import type { Db } from "@/lib/db";
import { parseJson } from "@/lib/db";

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
              (select count(*) from contacts c
                join suppressions s on s.kind = 'email' and s.value = lower(c.email)
                where c.prospect_id = p.id) as suppressed,
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
  pausedMailboxes: { label: string; reason: string | null }[];
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
    pausedMailboxes: db
      .prepare("select label, paused_reason as reason from mailboxes where status = 'paused'")
      .all() as { label: string; reason: string | null }[],
  };
}
