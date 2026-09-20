import type { Db } from "@/lib/db";
import { fromIso, parseJson, toIso } from "@/lib/db";
import {
  autoApproves,
  getCampaign,
  getMailbox,
  getStep,
  lintPolicyOf,
  threadsFollowUps,
  windowOf,
} from "@/lib/campaign";
import { buildContext } from "@/lib/template/context";
import { renderMessage } from "@/lib/template/render";
import { hasBlockingFindings, lintMessage } from "@/lib/template/lint";
import { OccupancyMap, nextFollowUpSlot, type Rng } from "@/lib/schedule/slots";
import { buildReferences, generateMessageId, replySubject } from "@/lib/mail/message-id";
import { findSuppression } from "@/lib/suppressions";

/**
 * Creating the next step of a sequence.
 *
 * Runs after a step is marked sent, so the delay counts from the touch that
 * actually happened rather than from when the contact was enrolled. Precomputing
 * the whole sequence up front would let a paused campaign make step 2 due
 * before step 1 had gone out, and would waste work on the follow-ups that
 * replies cancel.
 *
 * Safe to re-run. A unique index on (enrollment_id, step_number) means a crash
 * between marking a message sent and creating the next one is repaired by the
 * next tick rather than producing a duplicate.
 */

export interface NextStepOutcome {
  enrollmentId: number;
  created: boolean;
  reason: string;
  scheduledAt: Date | null;
  messageId: number | null;
}

interface EnrollmentRow {
  id: number;
  campaign_id: number;
  contact_id: number;
  status: string;
  current_step: number;
  last_sent_at: string | null;
}

interface PreviousMessageRow {
  id: number;
  step_number: number;
  subject: string;
  message_id: string;
  references_header: string | null;
  sent_at: string | null;
  to_email: string;
}

function contextFor(db: Db, contactId: number, senderName: string, senderEmail: string) {
  const row = db
    .prepare(
      `select c.email, c.name, c.title, c.linkedin, c.custom as contact_custom,
              p.company, p.domain, p.vertical, p.grade, p.custom as prospect_custom
         from contacts c join prospects p on p.id = c.prospect_id
        where c.id = ?`
    )
    .get(contactId) as {
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
  };

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
    sender: { name: senderName, email: senderEmail },
  });
}

/** Create the follow-up for one enrollment, if there is one to create. */
export function createNextStep(
  db: Db,
  enrollmentId: number,
  options: { now?: Date; rng?: Rng } = {}
): NextStepOutcome {
  const { now = new Date(), rng = Math.random } = options;
  const skip = (reason: string): NextStepOutcome => ({
    enrollmentId,
    created: false,
    reason,
    scheduledAt: null,
    messageId: null,
  });

  const enrollment = db
    .prepare("select * from enrollments where id = ?")
    .get(enrollmentId) as EnrollmentRow | undefined;

  if (!enrollment) return skip("No such enrollment.");
  if (enrollment.status !== "active") return skip(`Enrollment is ${enrollment.status}.`);

  const campaign = getCampaign(db, enrollment.campaign_id);
  if (campaign.status === "archived") return skip("Campaign is archived.");

  const nextNumber = enrollment.current_step + 1;
  const step = getStep(db, campaign.id, nextNumber);
  if (!step) {
    // The sequence is over. Marking it completed keeps finished enrollments
    // out of the active list without implying the prospect did anything.
    db.prepare("update enrollments set status = 'completed' where id = ?").run(enrollmentId);
    return skip("No further steps; sequence complete.");
  }

  // Checked before the duplicate guard below. An enrollment that has not sent
  // anything yet has current_step 0, so nextNumber is 1 and step 1 does exist -
  // reporting that as "step 1 already exists" hides the real reason, which is
  // that nothing has gone out to follow up on.
  const previous = db
    .prepare(
      `select id, step_number, subject, message_id, references_header, sent_at, to_email
         from messages
        where enrollment_id = ? and status = 'sent'
        order by step_number desc limit 1`
    )
    .get(enrollmentId) as PreviousMessageRow | undefined;

  if (!previous?.sent_at) return skip("The previous step has not sent yet.");

  const existing = db
    .prepare("select id from messages where enrollment_id = ? and step_number = ?")
    .get(enrollmentId, nextNumber) as { id: number } | undefined;
  if (existing) return skip(`Step ${nextNumber} already exists.`);

  const suppression = findSuppression(db, previous.to_email);
  if (suppression) {
    return skip(`${previous.to_email} is suppressed by ${suppression.kind} "${suppression.value}".`);
  }

  const mailbox = getMailbox(db, campaign.mailbox_id);
  const context = contextFor(db, enrollment.contact_id, mailbox.from_name, mailbox.from_email);
  const rendered = renderMessage(step.subject_template, step.body_template, context);

  if (!rendered.ok) {
    return skip(`Could not render step ${nextNumber}: missing ${rendered.missing.join(", ")}.`);
  }

  // Gmail threads on subject as well as headers, so a follow-up that reworded
  // the subject would start a new conversation despite correct References.
  const threaded = threadsFollowUps(step);
  const firstSent = db
    .prepare(
      `select subject, message_id, references_header from messages
        where enrollment_id = ? and status = 'sent' order by step_number asc limit 1`
    )
    .get(enrollmentId) as
    | { subject: string; message_id: string; references_header: string | null }
    | undefined;

  const subject = threaded && firstSent ? replySubject(firstSent.subject) : rendered.subject;
  const footer = campaign.footer_template?.trim();
  const body = footer ? `${rendered.body.trimEnd()}\n\n${footer}` : rendered.body;

  const findings = lintMessage(subject, body, lintPolicyOf(campaign), {
    footer: campaign.footer_template,
  });
  if (hasBlockingFindings(findings)) {
    const blocking = findings.filter((f) => f.severity === "block").map((f) => f.message);
    return skip(`Step ${nextNumber} failed the content check: ${blocking.join(" ")}`);
  }

  const taken = db
    .prepare(
      `select scheduled_at, sent_at from messages
        where mailbox_id = ? and status in ('scheduled', 'sending', 'sent')`
    )
    .all(mailbox.id) as { scheduled_at: string | null; sent_at: string | null }[];

  const occupancy = new OccupancyMap(
    taken
      .map((row) => row.sent_at ?? row.scheduled_at)
      .filter((value): value is string => Boolean(value))
      .map((value) => new Date(value)),
    mailbox.timezone
  );

  const scheduledAt = nextFollowUpSlot(
    fromIso(previous.sent_at)!,
    step.delay_days,
    windowOf(campaign),
    { dailyCap: mailbox.daily_cap, minGapSeconds: mailbox.min_gap_seconds },
    occupancy,
    now,
    rng
  );

  const inReplyTo = threaded ? previous.message_id : null;
  const references = threaded
    ? buildReferences(previous.references_header, previous.message_id)
    : null;

  const inserted = db
    .prepare(
      `insert into messages
         (mailbox_id, enrollment_id, step_number, to_email, subject, body,
          message_id, in_reply_to, references_header, scheduled_at, status)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      mailbox.id,
      enrollmentId,
      nextNumber,
      previous.to_email,
      subject,
      body,
      generateMessageId(mailbox.from_email),
      inReplyTo,
      references,
      toIso(scheduledAt),
      autoApproves(campaign) ? "scheduled" : "draft"
    );

  return {
    enrollmentId,
    created: true,
    reason: `Queued step ${nextNumber}.`,
    scheduledAt,
    messageId: Number(inserted.lastInsertRowid),
  };
}

/**
 * Create any follow-up that should exist but does not.
 *
 * Runs at the start of every send tick. A crash between marking a message sent
 * and creating the next step leaves an enrollment with nothing queued, and this
 * is what repairs it. Cheap: the query only returns enrollments that actually
 * have a gap.
 */
export function ensureNextSteps(
  db: Db,
  options: { now?: Date; rng?: Rng; limit?: number } = {}
): NextStepOutcome[] {
  const { limit = 50 } = options;

  const candidates = db
    .prepare(
      `select e.id
         from enrollments e
         join campaigns c on c.id = e.campaign_id
        where e.status = 'active'
          and c.status in ('active', 'paused')
          and e.last_sent_at is not null
          and not exists (
            select 1 from messages m
             where m.enrollment_id = e.id
               and m.status in ('draft', 'scheduled', 'sending')
          )
        order by e.last_sent_at
        limit ?`
    )
    .all(limit) as { id: number }[];

  return candidates.map((row) => createNextStep(db, row.id, options));
}
