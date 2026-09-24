import type { Db } from "@/lib/db";
import { parseJson } from "@/lib/db";
import { firstSentence, toTemplateKey } from "@/lib/template/context";
import { referencedFields } from "@/lib/template/render";

/**
 * Read models for the dashboard.
 *
 * Kept apart from the worker code so a page can never accidentally mutate
 * queue state while rendering.
 */

export interface CampaignSummary {
  id: number;
  name: string;
  status: string;
  mailbox: string;
  mailboxStatus: string;
  enrolled: number;
  drafts: number;
  scheduled: number;
  sent: number;
  replied: number;
  bounced: number;
  stopped: number;
  uncertain: number;
  failed: number;
  nextSendAt: string | null;
}

export function listCampaigns(db: Db): CampaignSummary[] {
  return db
    .prepare(
      `select
         c.id, c.name, c.status,
         m.label as mailbox, m.status as mailboxStatus,
         (select count(*) from enrollments e where e.campaign_id = c.id) as enrolled,
         (select count(*) from enrollments e where e.campaign_id = c.id and e.status = 'replied') as replied,
         (select count(*) from enrollments e where e.campaign_id = c.id and e.status = 'bounced') as bounced,
         (select count(*) from enrollments e where e.campaign_id = c.id and e.status = 'stopped') as stopped,
         (select count(*) from messages msg join enrollments e on e.id = msg.enrollment_id
           where e.campaign_id = c.id and msg.status = 'draft') as drafts,
         (select count(*) from messages msg join enrollments e on e.id = msg.enrollment_id
           where e.campaign_id = c.id and msg.status = 'scheduled') as scheduled,
         (select count(*) from messages msg join enrollments e on e.id = msg.enrollment_id
           where e.campaign_id = c.id and msg.status = 'sent') as sent,
         (select count(*) from messages msg join enrollments e on e.id = msg.enrollment_id
           where e.campaign_id = c.id and msg.status = 'uncertain') as uncertain,
         (select count(*) from messages msg join enrollments e on e.id = msg.enrollment_id
           where e.campaign_id = c.id and msg.status = 'failed') as failed,
         (select min(msg.scheduled_at) from messages msg join enrollments e on e.id = msg.enrollment_id
           where e.campaign_id = c.id and msg.status = 'scheduled') as nextSendAt
       from campaigns c
       join mailboxes m on m.id = c.mailbox_id
       order by case c.status when 'active' then 0 when 'paused' then 1 when 'draft' then 2 else 3 end,
                c.name`
    )
    .all() as CampaignSummary[];
}

export interface QueueRow {
  id: number;
  status: string;
  stepNumber: number;
  toEmail: string;
  subject: string;
  body: string;
  scheduledAt: string | null;
  company: string;
  campaign: string;
  campaignId: number;
  error: string | null;
}

/** Everything waiting, drafts first, then what is coming up. */
export function listQueue(
  db: Db,
  options: { campaignId?: number; status?: string; limit?: number } = {}
): QueueRow[] {
  const { campaignId, status, limit = 200 } = options;
  const filters: string[] = [];
  const params: unknown[] = [];

  if (campaignId) {
    filters.push("c.id = ?");
    params.push(campaignId);
  }
  if (status) {
    filters.push("m.status = ?");
    params.push(status);
  } else {
    filters.push("m.status in ('draft', 'scheduled', 'sending', 'uncertain', 'failed')");
  }

  params.push(limit);

  return db
    .prepare(
      `select m.id, m.status, m.step_number as stepNumber, m.to_email as toEmail,
              m.subject, m.body, m.scheduled_at as scheduledAt, m.error,
              p.company, c.name as campaign, c.id as campaignId
         from messages m
         join enrollments e on e.id = m.enrollment_id
         join contacts ct on ct.id = e.contact_id
         join prospects p on p.id = ct.prospect_id
         join campaigns c on c.id = e.campaign_id
        where ${filters.join(" and ")}
        order by case m.status
                   when 'uncertain' then 0 when 'failed' then 1
                   when 'draft' then 2 else 3 end,
                 m.scheduled_at
        limit ?`
    )
    .all(...params) as QueueRow[];
}

export interface InboxRow {
  id: number;
  classification: string;
  reason: string | null;
  fromEmail: string;
  subject: string | null;
  receivedAt: string;
  snippet: string | null;
  matchMethod: string | null;
  company: string | null;
  handled: number;
  /** 1 when a reply has already gone to this message. */
  replySent: number;
}

export function listInbox(
  db: Db,
  options: { classification?: string; limit?: number } = {}
): InboxRow[] {
  const { classification, limit = 100 } = options;

  return db
    .prepare(
      `select i.id, i.classification, i.classification_reason as reason,
              i.from_email as fromEmail, i.subject, i.received_at as receivedAt,
              i.snippet, i.match_method as matchMethod, i.handled,
              (select count(*) from sent_replies r
                where r.inbound_id = i.id and r.status in ('sent', 'uncertain')) as replySent,
              p.company
         from inbound_messages i
         left join messages m on m.id = i.matched_message_id
         left join enrollments e on e.id = m.enrollment_id
         left join contacts ct on ct.id = e.contact_id
         left join prospects p on p.id = ct.prospect_id
        where (? is null or i.classification = ?)
        order by i.received_at desc
        limit ?`
    )
    .all(classification ?? null, classification ?? null, limit) as InboxRow[];
}

export interface ProspectRow {
  id: number;
  company: string;
  domain: string | null;
  vertical: string | null;
  grade: string | null;
  holdReason: string | null;
  contacts: number;
  emailable: number;
  suppressed: number;
  lastSentAt: string | null;
  enrollmentStatus: string | null;
}

export function listProspects(
  db: Db,
  options: { search?: string; grade?: string; limit?: number } = {}
): ProspectRow[] {
  const { search, grade, limit = 200 } = options;
  const like = search ? `%${search.toLowerCase()}%` : null;

  return db
    .prepare(
      `select p.id, p.company, p.domain, p.vertical, p.grade,
              p.hold_reason as holdReason,
              (select count(*) from contacts c where c.prospect_id = p.id) as contacts,
              (select count(*) from contacts c
                where c.prospect_id = p.id and c.channel = 'email') as emailable,
              -- Both kinds. The seeded exclude list is domain-level, so
              -- counting only email suppressions showed every already-contacted
              -- prospect as clear and gave no clue why it would not enrol.
              (select count(*) from contacts c
                where c.prospect_id = p.id
                  and c.email is not null
                  and (
                    exists (select 1 from suppressions s
                             where s.kind = 'email' and s.value = lower(c.email))
                    or exists (select 1 from suppressions s
                                where s.kind = 'domain'
                                  and s.value = substr(lower(c.email), instr(c.email, '@') + 1))
                  )) as suppressed,
              (select max(m.sent_at) from messages m
                 join enrollments e on e.id = m.enrollment_id
                 join contacts c on c.id = e.contact_id
                where c.prospect_id = p.id and m.status = 'sent') as lastSentAt,
              (select e.status from enrollments e
                 join contacts c on c.id = e.contact_id
                where c.prospect_id = p.id order by e.id desc limit 1) as enrollmentStatus
         from p_alias p
        where (? is null or lower(p.company) like ? or lower(coalesce(p.domain, '')) like ?)
          and (? is null or p.grade = ?)
        order by case p.grade when 'A' then 0 when 'B' then 1 when 'C' then 2 else 3 end,
                 p.company
        limit ?`.replace("p_alias", "prospects")
    )
    .all(like, like, like, grade ?? null, grade ?? null, limit) as ProspectRow[];
}

export interface ProspectDetail extends ProspectRow {
  custom: Record<string, unknown>;
  contactRows: {
    id: number;
    email: string | null;
    name: string | null;
    title: string | null;
    channel: string;
    channelDetail: string | null;
  }[];
  history: {
    id: number;
    status: string;
    stepNumber: number;
    subject: string;
    toEmail: string;
    scheduledAt: string | null;
    sentAt: string | null;
    campaign: string;
  }[];
}

export function getProspect(db: Db, id: number): ProspectDetail | null {
  const base = db
    .prepare(
      `select p.id, p.company, p.domain, p.vertical, p.grade,
              p.hold_reason as holdReason, p.custom,
              (select count(*) from contacts c where c.prospect_id = p.id) as contacts,
              (select count(*) from contacts c
                where c.prospect_id = p.id and c.channel = 'email') as emailable,
              0 as suppressed, null as lastSentAt, null as enrollmentStatus
         from prospects p where p.id = ?`
    )
    .get(id) as (ProspectRow & { custom: string }) | undefined;

  if (!base) return null;

  const contactRows = db
    .prepare(
      `select id, email, name, title, channel, channel_detail as channelDetail
         from contacts where prospect_id = ? order by id`
    )
    .all(id) as ProspectDetail["contactRows"];

  const history = db
    .prepare(
      `select m.id, m.status, m.step_number as stepNumber, m.subject,
              m.to_email as toEmail, m.scheduled_at as scheduledAt, m.sent_at as sentAt,
              c.name as campaign
         from messages m
         join enrollments e on e.id = m.enrollment_id
         join contacts ct on ct.id = e.contact_id
         join campaigns c on c.id = e.campaign_id
        where ct.prospect_id = ?
        order by coalesce(m.sent_at, m.scheduled_at) desc`
    )
    .all(id) as ProspectDetail["history"];

  return {
    ...base,
    custom: parseJson<Record<string, unknown>>(base.custom, {}),
    contactRows,
    history,
  };
}

export interface HealthStatus {
  lastSendAt: string | null;
  lastPollAt: string | null;
  dueNow: number;
  drafts: number;
  uncertain: number;
  failed: number;
  scheduled: number;
  unhandledReplies: number;
  /** Inbound mail that matched nothing we sent. Mostly ordinary personal mail. */
  unmatched: number;
  pausedMailboxes: { label: string; reason: string | null }[];
  /** Setup state, so the interface can say what is still missing. */
  mailboxes: number;
  campaigns: number;
  activeCampaigns: number;
  prospects: number;
  suppressions: number;
  stepsDefined: number;
}

/**
 * What the banner needs.
 *
 * A worker that has silently stopped looks identical to a quiet day unless
 * something surfaces the last time it ran, which is the point of this.
 */
export function getHealth(db: Db): HealthStatus {
  const one = <T>(sql: string, ...params: unknown[]): T =>
    db.prepare(sql).get(...params) as T;

  return {
    lastSendAt: one<{ v: string | null }>("select max(sent_at) as v from messages").v,
    lastPollAt: one<{ v: string | null }>("select max(last_polled_at) as v from imap_cursors").v,
    dueNow: one<{ n: number }>(
      "select count(*) as n from messages where status = 'scheduled' and scheduled_at <= ?",
      new Date().toISOString()
    ).n,
    drafts: one<{ n: number }>("select count(*) as n from messages where status = 'draft'").n,
    uncertain: one<{ n: number }>("select count(*) as n from messages where status = 'uncertain'").n,
    failed: one<{ n: number }>("select count(*) as n from messages where status = 'failed'").n,
    scheduled: one<{ n: number }>("select count(*) as n from messages where status = 'scheduled'").n,
    /*
      Deliberately NOT counting 'unmatched'. Polling a personal mailbox means
      every newsletter and receipt Paul receives lands here as unmatched: the
      first real poll logged 107 of them and not one was about outreach.
      Counting those put 107 on the nav badge with zero things to do, which
      is exactly how a badge stops being read at all. Unmatched is a bucket
      to browse; a reply or an opt-out is work.
    */
    unhandledReplies: one<{ n: number }>(
      `select count(*) as n from inbound_messages
        where handled = 0 and classification in ('reply', 'unsubscribe')`
    ).n,
    unmatched: one<{ n: number }>(
      "select count(*) as n from inbound_messages where handled = 0 and classification = 'unmatched'"
    ).n,
    pausedMailboxes: db
      .prepare("select label, paused_reason as reason from mailboxes where status = 'paused'")
      .all() as { label: string; reason: string | null }[],

    mailboxes: one<{ n: number }>("select count(*) as n from mailboxes").n,
    campaigns: one<{ n: number }>("select count(*) as n from campaigns").n,
    activeCampaigns: one<{ n: number }>(
      "select count(*) as n from campaigns where status = 'active'"
    ).n,
    prospects: one<{ n: number }>("select count(*) as n from prospects").n,
    suppressions: one<{ n: number }>("select count(*) as n from suppressions").n,
    stepsDefined: one<{ n: number }>("select count(*) as n from sequence_steps").n,
  };
}

/**
 * The next thing worth doing, in the order it matters.
 *
 * This is what turns the overview from a readout into something that answers
 * "what now". Setup gaps come first because nothing works without them, then
 * anything ambiguous or broken, then the ordinary daily work.
 */
export interface NextAction {
  title: string;
  detail: string;
  href?: string;
  command?: string;
  tone: "ok" | "warn" | "danger" | "info";
  done?: boolean;
}

export function getNextActions(health: HealthStatus): NextAction[] {
  const actions: NextAction[] = [];

  if (health.mailboxes === 0) {
    actions.push({
      title: "Add a mailbox to send from",
      detail:
        "Store an app-specific password in the Keychain first, then register it. Nothing can send until one exists.",
      command: 'pnpm mailbox add --label payments --provider icloud --from "You <you@icloud.com>"',
      tone: "danger",
    });
  }

  if (health.prospects === 0) {
    actions.push({
      title: "Import a sheet of prospects",
      detail:
        "Export one tab from Google Sheets as CSV. Every column is kept, and re-importing an expanded sheet updates rather than duplicates.",
      command: "pnpm import:csv ~/Downloads/prospects.csv --commit",
      tone: "warn",
    });
  }

  if (health.suppressions === 0 && health.prospects > 0) {
    actions.push({
      title: "Load your do-not-contact list",
      detail:
        "Without it, anyone you already emailed can be emailed again. This is the one step worth doing before enrolling anybody.",
      command: "pnpm seed:suppressions",
      tone: "warn",
    });
  }

  if (health.campaigns === 0 && health.mailboxes > 0) {
    actions.push({
      title: "Create a campaign",
      detail: "A campaign is a sequence of up to three emails sent from one mailbox.",
      href: "/campaigns/new",
      tone: "info",
    });
  } else if (health.campaigns > 0 && health.stepsDefined === 0) {
    actions.push({
      title: "Write step 1",
      detail: "A campaign with no steps has nothing to send.",
      href: "/campaigns",
      tone: "warn",
    });
  }

  if (health.uncertain > 0) {
    actions.push({
      title: `Decide on ${health.uncertain} message${health.uncertain === 1 ? "" : "s"} with an unknown outcome`,
      detail:
        "The connection dropped mid-send on these, so they may or may not have arrived. They will never resend on their own.",
      href: "/queue?status=uncertain",
      tone: "warn",
    });
  }

  if (health.pausedMailboxes.length > 0) {
    actions.push({
      title: "A mailbox is paused",
      detail: health.pausedMailboxes
        .map((m) => `${m.label}: ${m.reason ?? "paused by hand"}`)
        .join(" · "),
      href: "/settings",
      tone: "danger",
    });
  }

  if (health.unhandledReplies > 0) {
    actions.push({
      title: `${health.unhandledReplies} thing${health.unhandledReplies === 1 ? "" : "s"} came back`,
      detail: "Replies and opt-outs waiting to be read. Sequences already stopped themselves.",
      href: "/inbox",
      tone: "ok",
    });
  }

  if (health.drafts > 0) {
    actions.push({
      title: `Review ${health.drafts} draft${health.drafts === 1 ? "" : "s"}`,
      detail: "Read them, then approve in bulk. Nothing leaves until you do.",
      href: "/queue?status=draft",
      tone: "info",
    });
  }

  if (health.failed > 0) {
    actions.push({
      title: `${health.failed} failed to send`,
      detail: "Rejected by the server. Worth checking the address before retrying.",
      href: "/queue?status=failed",
      tone: "danger",
    });
  }

  if (actions.length === 0 && health.scheduled > 0) {
    actions.push({
      title: "Nothing needs you",
      detail: `${health.scheduled} message${health.scheduled === 1 ? " is" : "s are"} queued and will go out on schedule.`,
      href: "/queue?status=scheduled",
      tone: "ok",
      done: true,
    });
  }

  return actions;
}

// ---------------------------------------------------------------- campaigns

export interface StepDetail {
  id: number;
  stepNumber: number;
  delayDays: number;
  subject: string;
  body: string;
  sameThread: boolean;
  /** Fields this step references, so the editor can show what it depends on. */
  fields: string[];
  /** Referenced fields that no prospect has a value for. */
  unknownFields: string[];
  sent: number;
  drafts: number;
  scheduled: number;
}

export interface CampaignDetail {
  id: number;
  name: string;
  description: string | null;
  status: string;
  timezone: string;
  windowStart: string;
  windowEnd: string;
  sendDays: number[];
  newPerDay: number;
  autoApprove: boolean;
  footerTemplate: string | null;
  maxWords: number;
  mailboxId: number;
  mailbox: string;
  mailboxEmail: string;
  mailboxStatus: string;
  dailyCap: number;
  steps: StepDetail[];
}

export function getCampaignDetail(db: Db, id: number): CampaignDetail | null {
  const row = db
    .prepare(
      `select c.*, m.label as mailbox, m.from_email as mailboxEmail,
              m.status as mailboxStatus, m.daily_cap as dailyCap
         from campaigns c join mailboxes m on m.id = c.mailbox_id
        where c.id = ?`
    )
    .get(id) as
    | (Record<string, unknown> & {
        id: number;
        name: string;
        description: string | null;
        status: string;
        timezone: string;
        window_start: string;
        window_end: string;
        send_days: string;
        new_per_day: number;
        auto_approve: number;
        footer_template: string | null;
        max_words: number;
        mailbox_id: number;
        mailbox: string;
        mailboxEmail: string;
        mailboxStatus: string;
        dailyCap: number;
      })
    | undefined;

  if (!row) return null;

  const known = new Set(listMergeFields(db).map((field) => field.key));

  const steps = (
    db
      .prepare("select * from sequence_steps where campaign_id = ? order by step_number")
      .all(id) as {
      id: number;
      step_number: number;
      delay_days: number;
      subject_template: string;
      body_template: string;
      same_thread: number;
    }[]
  ).map((step): StepDetail => {
    const counts = db
      .prepare(
        `select
           sum(case when msg.status = 'sent' then 1 else 0 end) as sent,
           sum(case when msg.status = 'draft' then 1 else 0 end) as drafts,
           sum(case when msg.status = 'scheduled' then 1 else 0 end) as scheduled
         from messages msg join enrollments e on e.id = msg.enrollment_id
        where e.campaign_id = ? and msg.step_number = ?`
      )
      .get(id, step.step_number) as {
      sent: number | null;
      drafts: number | null;
      scheduled: number | null;
    };

    const fields = referencedFields(
      `${step.subject_template}\n${step.body_template}`
    );

    return {
      id: step.id,
      stepNumber: step.step_number,
      delayDays: step.delay_days,
      subject: step.subject_template,
      body: step.body_template,
      sameThread: step.same_thread === 1,
      fields,
      unknownFields: fields.filter((field) => !known.has(field)),
      sent: counts.sent ?? 0,
      drafts: counts.drafts ?? 0,
      scheduled: counts.scheduled ?? 0,
    };
  });

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    timezone: row.timezone,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    sendDays: parseJson<number[]>(row.send_days, [1, 2, 3, 4, 5]),
    newPerDay: row.new_per_day,
    autoApprove: row.auto_approve === 1,
    footerTemplate: row.footer_template,
    maxWords: row.max_words,
    mailboxId: row.mailbox_id,
    mailbox: row.mailbox,
    mailboxEmail: row.mailboxEmail,
    mailboxStatus: row.mailboxStatus,
    dailyCap: row.dailyCap,
    steps,
  };
}

export interface MailboxOption {
  id: number;
  label: string;
  fromEmail: string;
  status: string;
  dailyCap: number;
  timezone: string;
}

export function listMailboxes(db: Db): MailboxOption[] {
  return db
    .prepare(
      `select id, label, from_email as fromEmail, status, daily_cap as dailyCap, timezone
         from mailboxes order by label`
    )
    .all() as MailboxOption[];
}

// ------------------------------------------------------------- merge fields

export interface MergeField {
  key: string;
  /** "built in" or the name of the sheet column it came from. */
  source: string;
  /** How many contacts have a non-empty value. */
  filled: number;
  total: number;
  example: string | null;
}

/**
 * Every merge field that can actually be typed into a template, counted.
 *
 * The count is the point. A field that only 3 of 152 prospects have will fail
 * to render for everyone else, and finding that out at enrollment time after
 * writing the email is too late. Listing the fill rate next to the field name
 * makes the choice obvious while the email is being written.
 */
export function listMergeFields(db: Db): MergeField[] {
  const contacts = db
    .prepare(
      `select c.email, c.name, c.title, c.linkedin, c.custom as contactCustom,
              p.company, p.domain, p.vertical, p.grade, p.custom as prospectCustom
         from contacts c join prospects p on p.id = c.prospect_id`
    )
    .all() as {
    email: string | null;
    name: string | null;
    title: string | null;
    linkedin: string | null;
    contactCustom: string;
    company: string;
    domain: string | null;
    vertical: string | null;
    grade: string | null;
    prospectCustom: string;
  }[];

  const total = contacts.length;
  const stats = new Map<string, { source: string; filled: number; example: string | null }>();

  const note = (key: string, source: string, value: unknown) => {
    const text =
      typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : Array.isArray(value)
            ? value.filter(Boolean).join(", ")
            : "";

    const entry = stats.get(key) ?? { source, filled: 0, example: null };
    if (text.trim()) {
      entry.filled += 1;
      entry.example ??= text.length > 90 ? `${text.slice(0, 90)}...` : text;
    }
    stats.set(key, entry);
  };

  for (const row of contacts) {
    note("company", "built in", row.company);
    note("company_short", "built in", row.company);
    note("domain", "built in", row.domain);
    note("vertical", "built in", row.vertical);
    note("grade", "built in", row.grade);
    note("email", "built in", row.email);
    note("full_name", "built in", row.name);
    note("first_name", "built in", row.name?.split(/\s+/)[0] ?? "");
    note("title", "built in", row.title);
    note("linkedin", "built in", row.linkedin);

    for (const [source, raw] of [
      ["sheet column", row.prospectCustom],
      ["sheet column", row.contactCustom],
    ] as const) {
      let custom: Record<string, unknown>;
      try {
        custom = JSON.parse(raw || "{}") as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const [header, value] of Object.entries(custom)) {
        note(toTemplateKey(header), source, value);

        // `_first` only exists where the value is long enough to shorten.
        if (typeof value === "string" && firstSentence(value)) {
          note(`${toTemplateKey(header)}_first`, "first sentence of the above", value);
        }
      }
    }
  }

  // sender_* come from the mailbox, so they are always resolvable.
  for (const key of ["sender_name", "sender_email"]) {
    stats.set(key, { source: "mailbox", filled: total, example: null });
  }

  return [...stats.entries()]
    .map(([key, entry]) => ({ key, ...entry, total }))
    .sort((a, b) => b.filled - a.filled || a.key.localeCompare(b.key));
}

/**
 * How many messages sit in each status, for the filter pills.
 *
 * The empty key is the default view: everything still waiting on something.
 * Showing the count on the pill answers "is there anything failed" without
 * clicking through to an empty list to find out.
 */
export function countQueueByStatus(
  db: Db,
  campaignId?: number
): Record<string, number> {
  const rows = db
    .prepare(
      `select m.status, count(*) as n
         from messages m
         join enrollments e on e.id = m.enrollment_id
        where (? is null or e.campaign_id = ?)
        group by m.status`
    )
    .all(campaignId ?? null, campaignId ?? null) as { status: string; n: number }[];

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = row.n;

  counts[""] = ["draft", "scheduled", "sending", "uncertain", "failed"].reduce(
    (total, status) => total + (counts[status] ?? 0),
    0
  );

  return counts;
}

/** The same, for the inbox tabs. */
export function countInboxByKind(db: Db): Record<string, number> {
  const rows = db
    .prepare("select classification, count(*) as n from inbound_messages group by classification")
    .all() as { classification: string; n: number }[];

  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    counts[row.classification] = row.n;
    total += row.n;
  }
  counts[""] = total;

  return counts;
}

/** How many prospects exist, for "12 of 152 match". */
export function countProspects(db: Db): number {
  return (db.prepare("select count(*) as n from prospects").get() as { n: number }).n;
}
