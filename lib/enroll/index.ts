import type { Db } from "@/lib/db";
import { parseJson, toIso } from "@/lib/db";
import {
  autoApproves,
  getCampaign,
  getMailbox,
  getStep,
  lintPolicyOf,
  windowOf,
  type CampaignRow,
  type MailboxRow,
  type StepRow,
} from "@/lib/campaign";
import { buildContext } from "@/lib/template/context";
import { renderMessage } from "@/lib/template/render";
import { hasBlockingFindings, lintMessage, type LintFinding } from "@/lib/template/lint";
import {
  OccupancyMap,
  assignStep1Slots,
  type PacingLimits,
  type Rng,
} from "@/lib/schedule/slots";
import { generateMessageId } from "@/lib/mail/message-id";
import { findSuppression } from "@/lib/suppressions";

/**
 * Enrolling contacts into a campaign.
 *
 * Only step 1 is created here. Follow-ups are created when the previous step
 * actually sends, so `delay_days` counts from the touch that really happened
 * and no work is spent on the follow-ups that replies will cancel.
 *
 * Every message is rendered and linted before it is stored, so a broken
 * template or a banned claim is caught now rather than at send time when the
 * worker is unattended.
 */

export interface EligibleContact {
  contactId: number;
  prospectId: number;
  email: string;
  company: string;
  grade: string | null;
}

/**
 * Why a contact cannot be enrolled.
 *
 * `kind` exists so callers can group these. Grouping on the prose does not
 * work: every suppression reason carries a domain, and splitting on the
 * punctuation turns one "suppressed" group into a hundred groups of one.
 */
export type IneligibleKind = "already_enrolled" | "on_hold" | "no_email" | "suppressed";

export interface Ineligible {
  contactId: number | null;
  company: string;
  email: string | null;
  kind: IneligibleKind;
  reason: string;
}

/** A plain-English heading for a group of skipped contacts. */
export const INELIGIBLE_LABEL: Record<IneligibleKind, string> = {
  already_enrolled: "Already in this campaign",
  on_hold: "On hold, flagged during research",
  no_email: "No email address",
  suppressed: "On the do-not-contact list",
};

export interface EnrollPreview {
  eligible: EligibleContact[];
  ineligible: Ineligible[];
}

interface CandidateRow {
  contact_id: number;
  prospect_id: number;
  email: string | null;
  channel: string;
  company: string;
  grade: string | null;
  hold_reason: string | null;
  already_enrolled: number;
}

/**
 * Who can be enrolled, and why the rest cannot.
 *
 * Ordered by grade so the A prospects take the earliest slots. `assignStep1Slots`
 * preserves input order, so this ordering is what decides who gets emailed first.
 */
export function previewEnrollment(
  db: Db,
  campaignId: number,
  contactIds?: number[]
): EnrollPreview {
  const filter = contactIds?.length
    ? `and c.id in (${contactIds.map(() => "?").join(",")})`
    : "";

  const rows = db
    .prepare(
      `select c.id as contact_id, c.prospect_id, c.email, c.channel,
              p.company, p.grade, p.hold_reason,
              (select count(*) from enrollments e
                where e.campaign_id = ? and e.contact_id = c.id) as already_enrolled
         from contacts c
         join prospects p on p.id = c.prospect_id
        where 1 = 1 ${filter}
        order by case p.grade when 'A' then 0 when 'B' then 1 when 'C' then 2 else 3 end,
                 p.company, c.id`
    )
    .all(campaignId, ...(contactIds ?? [])) as CandidateRow[];

  const eligible: EligibleContact[] = [];
  const ineligible: Ineligible[] = [];

  for (const row of rows) {
    const base = { contactId: row.contact_id, company: row.company, email: row.email };

    if (row.already_enrolled > 0) {
      ineligible.push({
        ...base,
        kind: "already_enrolled",
        reason: "Already enrolled in this campaign.",
      });
      continue;
    }
    if (row.hold_reason) {
      ineligible.push({ ...base, kind: "on_hold", reason: `On hold: ${row.hold_reason}` });
      continue;
    }
    if (row.channel !== "email" || !row.email) {
      ineligible.push({
        ...base,
        kind: "no_email",
        reason: `No email address; reachable by ${row.channel.replace("_", " ")}.`,
      });
      continue;
    }

    const suppression = findSuppression(db, row.email);
    if (suppression) {
      ineligible.push({
        ...base,
        kind: "suppressed",
        reason: `Suppressed by ${suppression.kind} "${suppression.value}".`,
      });
      continue;
    }

    eligible.push({
      contactId: row.contact_id,
      prospectId: row.prospect_id,
      email: row.email,
      company: row.company,
      grade: row.grade,
    });
  }

  return { eligible, ineligible };
}

export interface RenderedMessage {
  contactId: number;
  company: string;
  email: string;
  subject: string;
  body: string;
  findings: LintFinding[];
}

export interface RenderFailure {
  contactId: number;
  company: string;
  email: string;
  missing: string[];
}

export interface DryRenderResult {
  rendered: RenderedMessage[];
  failed: RenderFailure[];
  blocked: RenderedMessage[];
}

interface ContactContextRow {
  email: string;
  name: string | null;
  title: string | null;
  linkedin: string | null;
  contact_custom: string;
  company: string;
  domain: string | null;
  vertical: string | null;
  grade: string | null;
  prospect_custom: string;
}

function contextFor(
  db: Db,
  contactId: number,
  mailbox: MailboxRow
): ReturnType<typeof buildContext> {
  const row = db
    .prepare(
      `select c.email, c.name, c.title, c.linkedin, c.custom as contact_custom,
              p.company, p.domain, p.vertical, p.grade, p.custom as prospect_custom
         from contacts c join prospects p on p.id = c.prospect_id
        where c.id = ?`
    )
    .get(contactId) as ContactContextRow;

  return buildContext({
    contact: {
      email: row.email,
      name: row.name,
      title: row.title,
      linkedin: row.linkedin,
      custom: parseJson<Record<string, unknown>>(row.contact_custom, {}),
    },
    prospect: {
      company: row.company,
      domain: row.domain,
      vertical: row.vertical,
      grade: row.grade,
      custom: parseJson<Record<string, unknown>>(row.prospect_custom, {}),
    },
    sender: { name: mailbox.from_name, email: mailbox.from_email },
  });
}

/** Append the campaign footer, which carries the opt-out line and address. */
function withFooter(body: string, campaign: CampaignRow): string {
  const footer = campaign.footer_template?.trim();
  return footer ? `${body.trimEnd()}\n\n${footer}` : body;
}

/**
 * Render a step for every contact without writing anything.
 *
 * Splits three ways so the import screen can act on each: ready, failed to
 * render at all, and rendered but carrying something that blocks sending.
 */
export function dryRender(
  db: Db,
  campaignId: number,
  contacts: EligibleContact[],
  stepNumber = 1
): DryRenderResult {
  const campaign = getCampaign(db, campaignId);
  const mailbox = getMailbox(db, campaign.mailbox_id);
  const step = getStep(db, campaignId, stepNumber);
  if (!step) throw new Error(`Campaign ${campaignId} has no step ${stepNumber}.`);

  const policy = lintPolicyOf(campaign);
  const result: DryRenderResult = { rendered: [], failed: [], blocked: [] };

  for (const contact of contacts) {
    const context = contextFor(db, contact.contactId, mailbox);
    const output = renderMessage(step.subject_template, step.body_template, context);

    if (!output.ok) {
      result.failed.push({
        contactId: contact.contactId,
        company: contact.company,
        email: contact.email,
        missing: output.missing,
      });
      continue;
    }

    const body = withFooter(output.body, campaign);
    const findings = lintMessage(output.subject, body, policy, {
      footer: campaign.footer_template,
    });
    const message: RenderedMessage = {
      contactId: contact.contactId,
      company: contact.company,
      email: contact.email,
      subject: output.subject,
      body,
      findings,
    };

    if (hasBlockingFindings(findings)) result.blocked.push(message);
    else result.rendered.push(message);
  }

  return result;
}

export interface EnrollOptions {
  contactIds?: number[];
  now?: Date;
  rng?: Rng;
  /** Render and slot without writing. */
  dryRun?: boolean;
}

export interface EnrollResult {
  enrolled: number;
  scheduled: number;
  drafted: number;
  skipped: Ineligible[];
  failed: RenderFailure[];
  blocked: RenderedMessage[];
  firstSendAt: Date | null;
  lastSendAt: Date | null;
}

/**
 * Enrol contacts and queue step 1 for each.
 *
 * A message lands in 'draft' unless the campaign auto-approves, so nothing can
 * leave until it has been looked at. Anything that fails to render or trips a
 * blocking lint rule is reported and NOT enrolled, because a half-enrolled
 * contact with no step 1 would sit in the campaign doing nothing.
 */
export function enrollContacts(
  db: Db,
  campaignId: number,
  options: EnrollOptions = {}
): EnrollResult {
  const { now = new Date(), rng = Math.random, dryRun = false } = options;

  const campaign = getCampaign(db, campaignId);
  const mailbox = getMailbox(db, campaign.mailbox_id);
  const step = getStep(db, campaignId, 1);
  if (!step) throw new Error(`Campaign ${campaignId} has no step 1 to send.`);

  const preview = previewEnrollment(db, campaignId, options.contactIds);
  const render = dryRender(db, campaignId, preview.eligible, 1);

  const ready = render.rendered;
  const readyIds = new Set(ready.map((m) => m.contactId));
  const sendable = preview.eligible.filter((c) => readyIds.has(c.contactId));

  const result: EnrollResult = {
    enrolled: 0,
    scheduled: 0,
    drafted: 0,
    skipped: preview.ineligible,
    failed: render.failed,
    blocked: render.blocked,
    firstSendAt: null,
    lastSendAt: null,
  };

  if (sendable.length === 0) return result;

  // Occupancy is per MAILBOX across every campaign, because the cap and the
  // spacing belong to the mailbox. Slots already taken by a sibling campaign
  // have to be visible here or the two would each schedule a full day.
  //
  // 'draft' counts. A draft already owns its slot and will occupy it the
  // moment it is approved. Leaving it out meant enrolling several batches
  // before approving any of them stacked them all onto the same days: three
  // batches put 31 messages on one day against a cap of 20.
  const taken = db
    .prepare(
      `select scheduled_at, sent_at from messages
        where mailbox_id = ? and status in ('draft', 'scheduled', 'sending', 'sent')`
    )
    .all(mailbox.id) as { scheduled_at: string | null; sent_at: string | null }[];

  const occupancy = new OccupancyMap(
    taken
      .map((row) => row.sent_at ?? row.scheduled_at)
      .filter((value): value is string => Boolean(value))
      .map((value) => new Date(value)),
    mailbox.timezone
  );

  const limits: PacingLimits = {
    dailyCap: mailbox.daily_cap,
    minGapSeconds: mailbox.min_gap_seconds,
    newPerDay: campaign.new_per_day,
  };

  const slots = assignStep1Slots(sendable, windowOf(campaign), limits, occupancy, now, rng);
  const byContact = new Map(ready.map((m) => [m.contactId, m]));
  const approved = autoApproves(campaign);

  if (!dryRun) {
    const write = db.transaction(() => {
      for (const { item, scheduledAt } of slots) {
        const message = byContact.get(item.contactId)!;

        const enrollment = db
          .prepare("insert into enrollments (campaign_id, contact_id) values (?, ?)")
          .run(campaignId, item.contactId);

        db.prepare(
          `insert into messages
             (mailbox_id, enrollment_id, step_number, to_email, subject, body,
              message_id, scheduled_at, status)
           values (?, ?, 1, ?, ?, ?, ?, ?, ?)`
        ).run(
          mailbox.id,
          enrollment.lastInsertRowid,
          message.email,
          message.subject,
          message.body,
          generateMessageId(mailbox.from_email),
          toIso(scheduledAt),
          approved ? "scheduled" : "draft"
        );
      }
    });
    write();
  }

  result.enrolled = slots.length;
  result.scheduled = approved ? slots.length : 0;
  result.drafted = approved ? 0 : slots.length;
  result.firstSendAt = slots.length > 0 ? slots[0].scheduledAt : null;
  result.lastSendAt = slots.length > 0 ? slots[slots.length - 1].scheduledAt : null;

  return result;
}

export interface ApproveResult {
  approved: number;
  blocked: { messageId: number; toEmail: string; findings: LintFinding[] }[];
}

/**
 * Move drafts into the send queue.
 *
 * Linting runs again here rather than trusting the check done at enrollment,
 * because a draft can be edited in the review queue and a suppression can be
 * added after it was rendered.
 */
export function approveDrafts(
  db: Db,
  messageIds: number[],
  campaignId?: number
): ApproveResult {
  const result: ApproveResult = { approved: 0, blocked: [] };
  if (messageIds.length === 0) return result;

  const placeholders = messageIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `select m.id, m.to_email, m.subject, m.body, c.id as campaign_id
         from messages m
         join enrollments e on e.id = m.enrollment_id
         join campaigns c on c.id = e.campaign_id
        where m.id in (${placeholders}) and m.status = 'draft'
          ${campaignId ? "and c.id = ?" : ""}`
    )
    .all(...messageIds, ...(campaignId ? [campaignId] : [])) as {
    id: number;
    to_email: string;
    subject: string;
    body: string;
    campaign_id: number;
  }[];

  const policies = new Map<number, ReturnType<typeof lintPolicyOf>>();

  const run = db.transaction(() => {
    for (const row of rows) {
      let policy = policies.get(row.campaign_id);
      if (!policy) {
        policy = lintPolicyOf(getCampaign(db, row.campaign_id));
        policies.set(row.campaign_id, policy);
      }

      const findings = lintMessage(row.subject, row.body, policy);
      const suppression = findSuppression(db, row.to_email);

      if (suppression) {
        findings.push({
          rule: "suppressed",
          severity: "block",
          message: `${row.to_email} is suppressed by ${suppression.kind} "${suppression.value}".`,
        });
      }

      if (hasBlockingFindings(findings)) {
        result.blocked.push({ messageId: row.id, toEmail: row.to_email, findings });
        continue;
      }

      db.prepare("update messages set status = 'scheduled' where id = ? and status = 'draft'").run(
        row.id
      );
      result.approved += 1;
    }
  });

  run();
  return result;
}

/** Edit a draft in the review queue. Re-lints so the caller sees the effect. */
export function updateDraft(
  db: Db,
  messageId: number,
  subject: string,
  body: string
): LintFinding[] {
  const row = db
    .prepare(
      `select c.id as campaign_id from messages m
         join enrollments e on e.id = m.enrollment_id
         join campaigns c on c.id = e.campaign_id
        where m.id = ? and m.status = 'draft'`
    )
    .get(messageId) as { campaign_id: number } | undefined;

  if (!row) throw new Error(`Message ${messageId} is not a draft.`);

  db.prepare("update messages set subject = ?, body = ? where id = ?").run(
    subject,
    body,
    messageId
  );

  return lintMessage(subject, body, lintPolicyOf(getCampaign(db, row.campaign_id)));
}

export type { StepRow, CampaignRow, MailboxRow };
