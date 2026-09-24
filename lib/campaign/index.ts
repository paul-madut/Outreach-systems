import type { Db } from "@/lib/db";
import { fromSqliteBool, parseJson, toSqliteBool } from "@/lib/db";
import { DEFAULT_BANNED_PHRASES, DEFAULT_MAX_WORDS, type LintPolicy } from "@/lib/template/lint";
import type { SendWindow } from "@/lib/schedule/slots";
import { validateWindow } from "@/lib/schedule/slots";

/** Reading campaigns, mailboxes and steps out of the database. */

export interface MailboxRow {
  id: number;
  label: string;
  from_name: string;
  from_email: string;
  reply_to: string | null;
  provider: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  keychain_service: string;
  keychain_account: string;
  append_to_sent: number;
  timezone: string;
  daily_cap: number;
  min_gap_seconds: number;
  gap_jitter_seconds: number;
  status: string;
  paused_reason: string | null;
}

export interface CampaignRow {
  id: number;
  mailbox_id: number;
  name: string;
  description: string | null;
  timezone: string;
  window_start: string;
  window_end: string;
  send_days: string;
  new_per_day: number;
  auto_approve: number;
  footer_template: string | null;
  banned_phrases: string;
  max_words: number;
  status: string;
}

export interface StepRow {
  id: number;
  campaign_id: number;
  step_number: number;
  delay_days: number;
  subject_template: string;
  body_template: string;
  same_thread: number;
}

export function getMailbox(db: Db, id: number): MailboxRow {
  const row = db.prepare("select * from mailboxes where id = ?").get(id) as
    | MailboxRow
    | undefined;
  if (!row) throw new Error(`No mailbox with id ${id}.`);
  return row;
}

export function getCampaign(db: Db, id: number): CampaignRow {
  const row = db.prepare("select * from campaigns where id = ?").get(id) as
    | CampaignRow
    | undefined;
  if (!row) throw new Error(`No campaign with id ${id}.`);
  return row;
}

export function listSteps(db: Db, campaignId: number): StepRow[] {
  return db
    .prepare("select * from sequence_steps where campaign_id = ? order by step_number")
    .all(campaignId) as StepRow[];
}

export function getStep(db: Db, campaignId: number, stepNumber: number): StepRow | null {
  return (
    (db
      .prepare("select * from sequence_steps where campaign_id = ? and step_number = ?")
      .get(campaignId, stepNumber) as StepRow | undefined) ?? null
  );
}

/** The send window, in the shape the slotting code wants. */
export function windowOf(campaign: CampaignRow): SendWindow {
  const window: SendWindow = {
    start: campaign.window_start,
    end: campaign.window_end,
    days: parseJson<number[]>(campaign.send_days, [1, 2, 3, 4, 5]),
    timeZone: campaign.timezone,
  };
  validateWindow(window);
  return window;
}

/** The lint policy, with this campaign's extra banned phrases folded in. */
export function lintPolicyOf(campaign: CampaignRow): LintPolicy {
  const extra = parseJson<string[]>(campaign.banned_phrases, []);
  return {
    bannedPhrases: [...DEFAULT_BANNED_PHRASES, ...extra],
    maxWords: campaign.max_words || DEFAULT_MAX_WORDS,
  };
}

export function autoApproves(campaign: CampaignRow): boolean {
  return fromSqliteBool(campaign.auto_approve);
}

export function threadsFollowUps(step: StepRow): boolean {
  return fromSqliteBool(step.same_thread);
}

// ------------------------------------------------------------------ writing

export interface CreateMailboxInput {
  label: string;
  fromName: string;
  fromEmail: string;
  provider: "icloud" | "gmail" | "custom";
  keychainService: string;
  keychainAccount: string;
  timezone?: string;
  dailyCap?: number;
  minGapSeconds?: number;
  gapJitterSeconds?: number;
  smtpHost?: string;
  smtpPort?: number;
  imapHost?: string;
  imapPort?: number;
  replyTo?: string | null;
}

/**
 * Known provider endpoints, so a mailbox can be added by naming the provider.
 *
 * `appendToSent` is the detail that bites. iCloud does not file a copy of a
 * message sent over SMTP, so the tool has to APPEND one over IMAP. Gmail files
 * its own, and appending a second there puts every sent message in twice.
 */
const PROVIDERS = {
  icloud: {
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    appendToSent: true,
  },
  gmail: {
    smtpHost: "smtp.gmail.com",
    smtpPort: 587,
    imapHost: "imap.gmail.com",
    imapPort: 993,
    appendToSent: false,
  },
  custom: {
    smtpHost: "",
    smtpPort: 587,
    imapHost: "",
    imapPort: 993,
    appendToSent: true,
  },
} as const;

export function providerDefaults(provider: keyof typeof PROVIDERS) {
  return PROVIDERS[provider];
}

export function createMailbox(db: Db, input: CreateMailboxInput): number {
  const defaults = PROVIDERS[input.provider];
  const smtpHost = input.smtpHost ?? defaults.smtpHost;
  const imapHost = input.imapHost ?? defaults.imapHost;

  if (!smtpHost || !imapHost) {
    throw new Error("A custom mailbox needs both an SMTP host and an IMAP host.");
  }

  const result = db
    .prepare(
      `insert into mailboxes
         (label, from_name, from_email, reply_to, provider,
          smtp_host, smtp_port, smtp_user, imap_host, imap_port, imap_user,
          keychain_service, keychain_account, append_to_sent,
          timezone, daily_cap, min_gap_seconds, gap_jitter_seconds)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.label,
      input.fromName,
      input.fromEmail,
      input.replyTo ?? null,
      input.provider,
      smtpHost,
      input.smtpPort ?? defaults.smtpPort,
      input.fromEmail,
      imapHost,
      input.imapPort ?? defaults.imapPort,
      input.fromEmail,
      input.keychainService,
      input.keychainAccount,
      toSqliteBool(defaults.appendToSent),
      input.timezone ?? "America/Toronto",
      input.dailyCap ?? 20,
      input.minGapSeconds ?? 120,
      input.gapJitterSeconds ?? 60
    );

  return Number(result.lastInsertRowid);
}

export interface CreateCampaignInput {
  mailboxId: number;
  name: string;
  description?: string | null;
  timezone?: string;
  windowStart?: string;
  windowEnd?: string;
  sendDays?: number[];
  newPerDay?: number;
  autoApprove?: boolean;
  footerTemplate?: string | null;
  bannedPhrases?: string[];
  maxWords?: number;
}

export function createCampaign(db: Db, input: CreateCampaignInput): number {
  const result = db
    .prepare(
      `insert into campaigns
         (mailbox_id, name, description, timezone, window_start, window_end,
          send_days, new_per_day, auto_approve, footer_template,
          banned_phrases, max_words)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.mailboxId,
      input.name,
      input.description ?? null,
      input.timezone ?? "America/Toronto",
      input.windowStart ?? "09:00",
      input.windowEnd ?? "16:00",
      JSON.stringify(input.sendDays ?? [1, 2, 3, 4, 5]),
      input.newPerDay ?? 10,
      toSqliteBool(input.autoApprove ?? false),
      input.footerTemplate ?? null,
      JSON.stringify(input.bannedPhrases ?? []),
      input.maxWords ?? DEFAULT_MAX_WORDS
    );

  return Number(result.lastInsertRowid);
}

export interface UpdateCampaignInput {
  name?: string;
  description?: string | null;
  timezone?: string;
  windowStart?: string;
  windowEnd?: string;
  sendDays?: number[];
  newPerDay?: number;
  footerTemplate?: string | null;
}

/**
 * Change a campaign's settings, window included.
 *
 * The new window is validated against the same rules the slotter uses, before
 * anything is written. The table's CHECK only compares the two time strings,
 * so a malformed time or an empty send_days array would otherwise be stored
 * happily and then throw at slot time, long after the form said it saved.
 *
 * Remember that `window_end` is effectively exclusive: `pickTime` stops a
 * minute short of it and `campaignIsOpen` uses `now < close`. A window ending
 * at 16:00 can never produce a 16:00 send.
 *
 * Omitted fields are left alone. `description` and `footerTemplate` accept an
 * explicit null to clear them, which is why they are checked for `undefined`
 * rather than falsiness.
 */
export function updateCampaign(
  db: Db,
  campaignId: number,
  input: UpdateCampaignInput
): CampaignRow {
  const current = getCampaign(db, campaignId);

  const next: CampaignRow = {
    ...current,
    name: input.name ?? current.name,
    description: input.description === undefined ? current.description : input.description,
    timezone: input.timezone ?? current.timezone,
    window_start: input.windowStart ?? current.window_start,
    window_end: input.windowEnd ?? current.window_end,
    send_days: input.sendDays ? JSON.stringify(input.sendDays) : current.send_days,
    new_per_day: input.newPerDay ?? current.new_per_day,
    footer_template:
      input.footerTemplate === undefined ? current.footer_template : input.footerTemplate,
  };

  // Throws on a bad window before a single column changes.
  windowOf(next);

  db.prepare(
    `update campaigns
        set name = ?, description = ?, timezone = ?, window_start = ?, window_end = ?,
            send_days = ?, new_per_day = ?, footer_template = ?
      where id = ?`
  ).run(
    next.name,
    next.description,
    next.timezone,
    next.window_start,
    next.window_end,
    next.send_days,
    next.new_per_day,
    next.footer_template,
    campaignId
  );

  return next;
}

export interface UpsertStepInput {
  campaignId: number;
  stepNumber: number;
  subjectTemplate: string;
  bodyTemplate: string;
  delayDays?: number;
  sameThread?: boolean;
}

export function upsertStep(db: Db, input: UpsertStepInput): number {
  const result = db
    .prepare(
      `insert into sequence_steps
         (campaign_id, step_number, delay_days, subject_template, body_template, same_thread)
       values (?, ?, ?, ?, ?, ?)
       on conflict (campaign_id, step_number) do update set
         delay_days = excluded.delay_days,
         subject_template = excluded.subject_template,
         body_template = excluded.body_template,
         same_thread = excluded.same_thread`
    )
    .run(
      input.campaignId,
      input.stepNumber,
      input.delayDays ?? (input.stepNumber === 1 ? 0 : 3),
      input.subjectTemplate,
      input.bodyTemplate,
      toSqliteBool(input.sameThread ?? input.stepNumber > 1)
    );

  return Number(result.lastInsertRowid);
}

export function setCampaignStatus(
  db: Db,
  campaignId: number,
  status: "draft" | "active" | "paused" | "archived"
): void {
  db.prepare("update campaigns set status = ? where id = ?").run(status, campaignId);
}

/**
 * The mailbox that started this enrollment's thread.
 *
 * A follow-up carries In-Reply-To pointing at the first message, so it has to
 * leave from the address that sent it. Without this, moving a campaign to a
 * new mailbox would continue conversations already in progress from a
 * different sender: the thread splits in the recipient's client and the reply
 * reads as coming from a stranger.
 *
 * Null when nothing has gone out yet, which means the campaign's current
 * mailbox is the right one to use.
 */
export function threadMailboxId(db: Db, enrollmentId: number): number | null {
  const row = db
    .prepare(
      `select mailbox_id from messages
        where enrollment_id = ? and status in ('sent', 'uncertain')
        order by step_number limit 1`
    )
    .get(enrollmentId) as { mailbox_id: number } | undefined;

  return row?.mailbox_id ?? null;
}

export interface MoveCampaignResult {
  /** Unsent messages repointed at the new mailbox. */
  moved: number;
  /** Unsent messages left behind because their thread belongs elsewhere. */
  keptOnThread: number;
}

/**
 * Send a campaign from a different mailbox.
 *
 * `messages.mailbox_id` is a snapshot taken when the row is rendered, so
 * changing the campaign alone would leave everything already queued going out
 * from the old address. Queued mail moves with the campaign, with one
 * exception: anything belonging to a thread that has already started stays
 * where it is, for the reason in `threadMailboxId`.
 *
 * Sent, failed and cancelled rows are never touched. They are a record of what
 * actually happened and rewriting them would make the log lie.
 */
export function moveCampaign(db: Db, campaignId: number, mailboxId: number): MoveCampaignResult {
  getMailbox(db, mailboxId);

  return db.transaction((): MoveCampaignResult => {
    db.prepare("update campaigns set mailbox_id = ? where id = ?").run(mailboxId, campaignId);

    const moved = db
      .prepare(
        `update messages set mailbox_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          where status in ('draft', 'scheduled')
            and mailbox_id <> ?
            and enrollment_id in (select id from enrollments where campaign_id = ?)
            and not exists (
              select 1 from messages prior
               where prior.enrollment_id = messages.enrollment_id
                 and prior.status in ('sent', 'uncertain')
            )`
      )
      .run(mailboxId, mailboxId, campaignId).changes;

    const keptOnThread = (
      db
        .prepare(
          `select count(*) as n from messages m
            where m.status in ('draft', 'scheduled')
              and m.mailbox_id <> ?
              and m.enrollment_id in (select id from enrollments where campaign_id = ?)`
        )
        .get(mailboxId, campaignId) as { n: number }
    ).n;

    return { moved, keptOnThread };
  })();
}

/** Rename a mailbox. The label is only ever an identifier for a person. */
export function renameMailbox(db: Db, mailboxId: number, label: string): void {
  db.prepare("update mailboxes set label = ? where id = ?").run(label, mailboxId);
}

export function setMailboxStatus(
  db: Db,
  mailboxId: number,
  status: "active" | "paused" | "archived",
  reason: string | null = null
): void {
  // Clearing the notification marker on the way out of a pause is what makes
  // the next pause announce itself. Leaving it set would mean a mailbox that
  // pauses, resumes and pauses again goes quiet the second time.
  db.prepare(
    `update mailboxes
        set status = ?, paused_reason = ?,
            pause_notified_at = case when ? = 'paused' then pause_notified_at else null end
      where id = ?`
  ).run(status, reason, status, mailboxId);
}
