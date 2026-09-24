-- Outreach Systems schema (SQLite).
--
-- One user, one machine, one worker at a time. That assumption removes a lot:
-- no owner_id, no row level security, no lease or reaper, and no stored
-- procedures. The worker holds a lock file, so a claim is just a transaction.
--
-- Timestamps are ISO-8601 UTC strings ('2026-09-20T14:05:00.000Z'). They sort
-- correctly as text, they are readable in any SQLite browser, and they are
-- unambiguous. Anything needing a local calendar day is computed in TypeScript
-- through lib/schedule/tz.ts, never in SQL.

pragma journal_mode = wal;
pragma foreign_keys = on;

-- ---------------------------------------------------------------- mailboxes

-- A sending identity. Pacing lives here rather than on the campaign, because
-- two campaigns can share a mailbox and it is the mailbox that carries the
-- sending reputation.
create table if not exists mailboxes (
  id                 integer primary key,
  label              text    not null unique,
  from_name          text    not null,
  from_email         text    not null,
  reply_to           text,

  provider           text    not null default 'custom'
                       check (provider in ('icloud', 'gmail', 'custom')),
  smtp_host          text    not null,
  smtp_port          integer not null default 587,
  smtp_user          text    not null,
  imap_host          text    not null,
  imap_port          integer not null default 993,
  imap_user          text    not null,

  -- macOS Keychain lookup: `security find-generic-password -s <service> -a <account> -w`.
  -- The password itself is never stored here.
  keychain_service   text    not null,
  keychain_account   text    not null,

  -- Gmail files its own copy in Sent, so appending a second one duplicates
  -- every message. iCloud does not, so it needs the append.
  append_to_sent     integer not null default 1 check (append_to_sent in (0, 1)),

  timezone           text    not null default 'America/Toronto',
  daily_cap          integer not null default 20 check (daily_cap > 0),

  -- The sending ramp. A new domain has no reputation, so the cap starts low
  -- and climbs by `warmup_daily_increment` each local day until it reaches
  -- `daily_cap`, which stays the ceiling. Null start date means no ramp.
  -- Evaluated in lib/schedule/warmup.ts, never here: the day boundary is the
  -- mailbox's local one, and SQL has no idea what timezone that is.
  warmup_started_on      text,
  warmup_start_cap       integer not null default 5 check (warmup_start_cap >= 0),
  warmup_daily_increment integer not null default 2 check (warmup_daily_increment >= 0),

  min_gap_seconds    integer not null default 120 check (min_gap_seconds >= 0),
  gap_jitter_seconds integer not null default 60 check (gap_jitter_seconds >= 0),
  -- Pushed forward after every claim. This is what paces a mailbox without
  -- any worker having to stay alive between sends.
  next_send_after    text,

  status             text    not null default 'active'
                       check (status in ('active', 'paused', 'archived')),
  paused_reason      text,

  created_at         text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------- campaigns

create table if not exists campaigns (
  id              integer primary key,
  mailbox_id      integer not null references mailboxes (id) on delete restrict,

  name            text    not null unique,
  description     text,

  timezone        text    not null default 'America/Toronto',
  window_start    text    not null default '09:00',
  window_end      text    not null default '16:00',
  -- ISO weekdays as a JSON array. 1 is Monday, 7 is Sunday.
  send_days       text    not null default '[1,2,3,4,5]',

  -- Planning input for slotting step 1. The mailbox daily_cap is the ceiling.
  new_per_day     integer not null default 10 check (new_per_day > 0),

  -- Rendered messages wait in 'draft' for review unless this is on.
  auto_approve    integer not null default 0 check (auto_approve in (0, 1)),

  -- Appended to every body at render time. Carries the opt-out line.
  footer_template text,

  -- Per-campaign lint policy, as a JSON array of phrases.
  banned_phrases  text    not null default '[]',
  max_words       integer not null default 120,

  status          text    not null default 'draft'
                    check (status in ('draft', 'active', 'paused', 'archived')),

  created_at      text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  check (window_start < window_end)
);

create index if not exists campaigns_mailbox_idx on campaigns (mailbox_id);

-- ---------------------------------------------------------------- prospects

-- The company. Only what the system reasons about is typed; everything else
-- from the sheet lands in `custom` and is addressable as a merge field.
create table if not exists prospects (
  id          integer primary key,

  company     text not null,
  -- Slug of the company name. Dedupes rows that have no domain.
  company_key text,
  domain      text,
  vertical    text,
  grade       text check (grade is null or grade in ('A', 'B', 'C')),

  -- Any non-empty value blocks enrollment. From the sheet's
  -- "Review before contacting" column.
  hold_reason text,

  custom      text not null default '{}',

  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Two partial indexes rather than one nullable unique, because a plain unique
-- over a nullable column never dedupes the null rows, and the fintech job
-- sheet has companies with no clean domain.
create unique index if not exists prospects_domain_key
  on prospects (domain) where domain is not null;
create unique index if not exists prospects_company_key_key
  on prospects (company_key) where domain is null and company_key is not null;
create index if not exists prospects_grade_idx on prospects (grade);

-- ----------------------------------------------------------------- contacts

-- The person. Separate from prospects because the fintech job sheet carries
-- two contacts per row while the payments sheet carries one.
create table if not exists contacts (
  id             integer primary key,
  prospect_id    integer not null references prospects (id) on delete cascade,

  email          text,
  name           text,
  title          text,
  linkedin       text,

  channel        text not null default 'none'
                   check (channel in ('email', 'contact_form', 'phone', 'none')),
  -- The original channel cell, when it said more than the channel name.
  channel_detail text,

  custom         text not null default '{}',

  created_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- A contact on the email channel is useless without an address.
  check (channel <> 'email' or email is not null)
);

-- The dedupe that actually matters. The old script keyed on a sheet row
-- number, which is not stable and crashed on any file without one.
create unique index if not exists contacts_email_key
  on contacts (lower(email)) where email is not null;
create index if not exists contacts_prospect_idx on contacts (prospect_id);

-- ----------------------------------------------------------- sequence steps

create table if not exists sequence_steps (
  id               integer primary key,
  campaign_id      integer not null references campaigns (id) on delete cascade,

  step_number      integer not null check (step_number >= 1),
  -- Days after the PREVIOUS step actually sent. Ignored for step 1.
  delay_days       integer not null default 3 check (delay_days >= 0),

  subject_template text not null,
  body_template    text not null,

  -- Follow-ups thread into the step 1 message. Gmail also needs a matching
  -- subject, so the renderer forces "Re: <step 1 subject>" when this is on.
  same_thread      integer not null default 1 check (same_thread in (0, 1)),

  created_at       text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  unique (campaign_id, step_number)
);

-- -------------------------------------------------------------- enrollments

create table if not exists enrollments (
  id           integer primary key,
  campaign_id  integer not null references campaigns (id) on delete cascade,
  contact_id   integer not null references contacts (id) on delete cascade,

  status       text not null default 'active'
                 check (status in ('active', 'replied', 'bounced', 'stopped', 'completed')),
  stop_reason  text,

  current_step integer not null default 0,
  last_sent_at text,

  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- A contact cannot be enrolled twice in the same campaign.
  unique (campaign_id, contact_id)
);

create index if not exists enrollments_active_idx on enrollments (campaign_id, status);
create index if not exists enrollments_contact_idx on enrollments (contact_id);

-- ----------------------------------------------------------------- messages

-- The queue and the log in one table. A row is created 'draft', approved into
-- 'scheduled', claimed into 'sending', and ends 'sent', 'uncertain', 'failed'
-- or 'cancelled'.
create table if not exists messages (
  id                integer primary key,
  mailbox_id        integer not null references mailboxes (id) on delete restrict,
  enrollment_id     integer not null references enrollments (id) on delete cascade,

  step_number       integer not null check (step_number >= 1),

  -- Snapshot of the address at render time. The contact row can change later,
  -- and the log has to say where the message actually went.
  to_email          text not null,
  subject           text not null,
  body              text not null,

  -- Generated when the row is created, not at send time, so a retry reuses the
  -- same id and a receiving server has a chance to dedupe it.
  message_id        text not null unique,
  in_reply_to       text,
  references_header text,

  scheduled_at      text,
  sent_at           text,
  claimed_at        text,

  attempts          integer not null default 0,
  smtp_response     text,
  error             text,

  status            text not null default 'draft'
                      check (status in ('draft', 'scheduled', 'sending', 'sent',
                                        'uncertain', 'failed', 'cancelled')),

  created_at        text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  check (status <> 'scheduled' or scheduled_at is not null),

  -- One row per step per enrollment. This is what makes "ensure next steps"
  -- safe to re-run after a crash.
  unique (enrollment_id, step_number)
);

create index if not exists messages_due_idx on messages (status, scheduled_at);
create index if not exists messages_mailbox_sent_idx on messages (mailbox_id, status, sent_at);
create index if not exists messages_enrollment_idx on messages (enrollment_id);
create index if not exists messages_to_email_idx on messages (lower(to_email));

-- --------------------------------------------------------- inbound messages

create table if not exists inbound_messages (
  id                    integer primary key,
  mailbox_id            integer not null references mailboxes (id) on delete cascade,

  folder                text    not null default 'INBOX',
  uid                   integer,
  rfc_message_id        text,

  from_email            text    not null,
  subject               text,
  received_at           text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  snippet               text,

  classification        text    not null
                          check (classification in ('reply', 'auto_reply', 'bounce',
                                                    'unsubscribe', 'unmatched')),
  classification_reason text,

  -- Null when nothing matched. Those rows show in the inbox for manual linking.
  matched_message_id    integer references messages (id) on delete set null,
  match_method          text check (match_method is null or match_method in
                          ('in_reply_to', 'references', 'dsn_body', 'failed_recipient',
                           'sender_address', 'sender_domain', 'manual')),

  dsn_status            text,
  handled               integer not null default 0 check (handled in (0, 1)),

  -- When this was announced in Slack. Null means it still owes a notification,
  -- which is what makes a Slack outage recoverable: the next poll retries it.
  notified_at           text,

  created_at            text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per inbound message per mailbox, so a re-poll cannot double-apply.
create unique index if not exists inbound_mailbox_rfc_key
  on inbound_messages (mailbox_id, rfc_message_id) where rfc_message_id is not null;
create index if not exists inbound_triage_idx
  on inbound_messages (classification, received_at desc);

-- ------------------------------------------------------------- imap cursors

-- IMAP SINCE only has day granularity, so polling by date either misses
-- messages or reprocesses a whole day. UIDs are exact and monotonic, and
-- uidvalidity says when the server has reset them.
create table if not exists imap_cursors (
  mailbox_id     integer not null references mailboxes (id) on delete cascade,
  folder         text    not null,
  uidvalidity    integer,
  last_uid       integer not null default 0,
  last_polled_at text,
  primary key (mailbox_id, folder)
);

-- ------------------------------------------------------------- suppressions

create table if not exists suppressions (
  id         integer primary key,
  kind       text not null check (kind in ('email', 'domain')),
  value      text not null,
  reason     text,
  source     text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  unique (kind, value)
);

-- ------------------------------------------------------------------ imports

-- Saves the column mapping. Sheets exports one CSV per tab, so the same
-- mapping is reused every time a tab grows.
create table if not exists imports (
  id                integer primary key,
  label             text not null,
  source_name       text,
  mapping           text not null default '{}',
  row_count         integer not null default 0,
  created_prospects integer not null default 0,
  created_contacts  integer not null default 0,
  skipped           integer not null default 0,
  report            text not null default '{}',
  created_at        text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- --------------------------------------------------------------- updated_at

create trigger if not exists mailboxes_touch after update on mailboxes
begin
  update mailboxes set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = new.id;
end;

create trigger if not exists campaigns_touch after update on campaigns
begin
  update campaigns set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = new.id;
end;

create trigger if not exists prospects_touch after update on prospects
begin
  update prospects set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = new.id;
end;

create trigger if not exists contacts_touch after update on contacts
begin
  update contacts set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = new.id;
end;

create trigger if not exists sequence_steps_touch after update on sequence_steps
begin
  update sequence_steps set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = new.id;
end;

create trigger if not exists enrollments_touch after update on enrollments
begin
  update enrollments set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = new.id;
end;

create trigger if not exists messages_touch after update on messages
begin
  update messages set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = new.id;
end;

-- --------------------------------------------------- placement testing

-- Mailboxes you own that exist only to receive test mail. Separate from
-- `mailboxes` on purpose: these never send, carry no pacing, and a seed at a
-- provider you do not send from is still worth having.
create table if not exists seed_inboxes (
  id               integer primary key,
  label            text    not null unique,
  email            text    not null,
  provider         text    not null default 'custom',

  imap_host        text    not null,
  imap_port        integer not null default 993,
  imap_user        text    not null,
  keychain_service text    not null,
  keychain_account text    not null,

  status           text    not null default 'active'
                     check (status in ('active', 'paused')),

  created_at       text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One send from one sending mailbox to every active seed.
create table if not exists placement_tests (
  id         integer primary key,
  mailbox_id integer not null references mailboxes (id) on delete cascade,

  -- Unique marker in the subject. Searching for it at the seed is how the
  -- message is found again, and it is visible to a human reading the mailbox.
  token      text    not null unique,
  subject    text    not null,

  sent_at    text,
  status     text    not null default 'pending'
               check (status in ('pending', 'sent', 'complete', 'failed')),
  error      text,

  created_at text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists placement_tests_mailbox_idx on placement_tests (mailbox_id);

-- Where that message landed at one seed, and what the receiver concluded
-- about its authentication. The verdicts are the receiver's own, read out of
-- its Authentication-Results header, not recomputed here.
create table if not exists placement_results (
  id               integer primary key,
  test_id          integer not null references placement_tests (id) on delete cascade,
  seed_id          integer not null references seed_inboxes (id) on delete cascade,

  -- How the message is found again at the seed. Providers preserve it, and
  -- IMAP can search on it, so the test message needs no marker of its own.
  message_id       text    not null,
  sent_at          text,

  placement        text    check (placement in ('inbox', 'spam', 'missing')),
  folder           text,

  -- Whether the message carried an Authentication-Results header at all.
  -- Null until checked, 0 when no receiver ever ran the checks.
  auth_present     integer check (auth_present in (0, 1)),
  spf              text,
  dkim             text,
  dmarc            text,
  verifier         text,

  delivery_seconds integer,
  checked_at       text,

  unique (test_id, seed_id)
);
