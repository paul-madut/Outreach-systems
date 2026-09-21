"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import {
  INELIGIBLE_LABEL,
  approveDrafts,
  dryRender,
  enrollContacts,
  previewEnrollment,
  updateDraft,
  type IneligibleKind,
} from "@/lib/enroll";
import { selectContacts } from "@/lib/enroll/select";
import { stopEnrollment } from "@/lib/worker/claim";
import { createCampaign, setCampaignStatus, setMailboxStatus, upsertStep } from "@/lib/campaign";
import { addSuppression } from "@/lib/suppressions";
import { runSendTick } from "@/lib/worker/send-tick";
import { pollAllMailboxes } from "@/lib/worker/poll-mailbox";
import { sweepOrphans } from "@/lib/worker/claim";
import { withLock, LockHeldError } from "@/lib/worker/lock";
import { resolve } from "node:path";

/**
 * Server actions for the dashboard.
 *
 * Deliberately few. Everything that decides what gets sent lives in the
 * worker and the enrollment code, and these only cover the judgement calls a
 * person has to make: approve a draft, resolve an unknown outcome, stop a
 * sequence, pause a mailbox.
 */

/**
 * Run one worker pass from the interface.
 *
 * The same code path the scheduled job uses, lock included, so pressing this
 * while launchd happens to be mid-run is safe: the second one reports that
 * the first holds the lock rather than sending anything twice.
 */
export async function runWorkerNow() {
  const lockPath = resolve(process.cwd(), ".worker.lock");

  try {
    return await withLock(lockPath, async () => {
      const db = getDb();
      sweepOrphans(db);

      const send = await runSendTick(db, { limit: 5 });
      const polls = await pollAllMailboxes(db);

      revalidatePath("/");
      revalidatePath("/queue");
      revalidatePath("/inbox");

      return {
        live: send.live,
        claimed: send.claimed,
        sent: send.sent,
        uncertain: send.uncertain,
        replies: polls.reduce((total, poll) => total + poll.replies, 0),
        bounces: polls.reduce((total, poll) => total + poll.bounces, 0),
      };
    });
  } catch (error) {
    if (error instanceof LockHeldError) {
      throw new Error("The scheduled worker is already running. Try again in a moment.", {
        cause: error,
      });
    }
    throw error;
  }
}

export async function approveMessages(messageIds: number[]) {
  const result = approveDrafts(getDb(), messageIds);
  revalidatePath("/queue");
  revalidatePath("/");
  return result;
}

export async function saveDraft(messageId: number, subject: string, body: string) {
  const findings = updateDraft(getDb(), messageId, subject, body);
  revalidatePath("/queue");
  return findings;
}

export async function cancelMessage(messageId: number, reason = "Cancelled by hand") {
  getDb()
    .prepare(
      "update messages set status = 'cancelled', error = ? where id = ? and status in ('draft','scheduled')"
    )
    .run(reason, messageId);
  revalidatePath("/queue");
  revalidatePath("/");
}

/**
 * Resolve a message whose outcome could not be determined.
 *
 * The worker never decides this on its own. "Sent" records it as delivered and
 * lets the sequence continue; "requeue" puts it back in the queue and accepts
 * the risk of a duplicate. Only a person can weigh that, usually by looking in
 * the Sent folder.
 */
export async function resolveUncertain(messageId: number, outcome: "sent" | "requeue") {
  const db = getDb();

  if (outcome === "sent") {
    db.prepare(
      "update messages set status = 'sent', sent_at = coalesce(sent_at, ?), error = null where id = ? and status = 'uncertain'"
    ).run(new Date().toISOString(), messageId);

    const row = db
      .prepare("select enrollment_id, step_number from messages where id = ?")
      .get(messageId) as { enrollment_id: number; step_number: number } | undefined;

    if (row) {
      db.prepare(
        "update enrollments set current_step = max(current_step, ?), last_sent_at = ? where id = ?"
      ).run(row.step_number, new Date().toISOString(), row.enrollment_id);
    }
  } else {
    db.prepare(
      "update messages set status = 'scheduled', scheduled_at = ?, error = null, attempts = 0 where id = ? and status = 'uncertain'"
    ).run(new Date().toISOString(), messageId);
  }

  revalidatePath("/queue");
  revalidatePath("/");
  return { ok: true };
}

/** Retry a message that failed permanently, after the cause has been fixed. */
export async function retryFailed(messageId: number) {
  getDb()
    .prepare(
      "update messages set status = 'scheduled', scheduled_at = ?, error = null, attempts = 0 where id = ? and status = 'failed'"
    )
    .run(new Date().toISOString(), messageId);
  revalidatePath("/queue");
}

export async function stopSequence(enrollmentId: number, reason: string) {
  stopEnrollment(getDb(), enrollmentId, "stopped", reason);
  revalidatePath("/queue");
  revalidatePath("/");
}

export async function suppressAddress(email: string, reason: string) {
  addSuppression(getDb(), "email", email, reason, "dashboard");
  revalidatePath("/prospects");
  revalidatePath("/inbox");
}

export async function setMailbox(
  mailboxId: number,
  status: "active" | "paused",
  reason: string | null = null
) {
  setMailboxStatus(getDb(), mailboxId, status, reason);
  revalidatePath("/");
  revalidatePath("/settings");
}

export async function markInboundHandled(inboundId: number) {
  getDb().prepare("update inbound_messages set handled = 1 where id = ?").run(inboundId);
  revalidatePath("/inbox");
}

/** Clear a prospect's hold so it can be enrolled. */
export async function clearHold(prospectId: number) {
  getDb().prepare("update prospects set hold_reason = null where id = ?").run(prospectId);
  revalidatePath("/prospects");
}



// ---------------------------------------------------------------- campaigns

/**
 * Everything a campaign needs to exist, in one call.
 *
 * A campaign with no step 1 can never send, so creating one seeds a step
 * rather than leaving a half-built thing behind for someone to discover later.
 */
export async function createCampaignAction(input: {
  mailboxId: number;
  name: string;
  description?: string;
  windowStart: string;
  windowEnd: string;
  sendDays: number[];
  newPerDay: number;
  subject: string;
  body: string;
  footer?: string;
}) {
  const db = getDb();

  const campaignId = createCampaign(db, {
    mailboxId: input.mailboxId,
    name: input.name,
    description: input.description || null,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    sendDays: input.sendDays,
    newPerDay: input.newPerDay,
    footerTemplate: input.footer || null,
  });

  upsertStep(db, {
    campaignId,
    stepNumber: 1,
    subjectTemplate: input.subject,
    bodyTemplate: input.body,
    delayDays: 0,
  });

  revalidatePath("/");
  revalidatePath("/campaigns");
  return { campaignId };
}

export async function saveStepAction(input: {
  campaignId: number;
  stepNumber: number;
  subject: string;
  body: string;
  delayDays: number;
  sameThread: boolean;
}) {
  upsertStep(getDb(), {
    campaignId: input.campaignId,
    stepNumber: input.stepNumber,
    subjectTemplate: input.subject,
    bodyTemplate: input.body,
    delayDays: input.delayDays,
    sameThread: input.sameThread,
  });

  revalidatePath(`/campaigns/${input.campaignId}`);
  revalidatePath("/");
  return { ok: true };
}

/**
 * Remove a step.
 *
 * Refused while any message still points at it. A sent one is history and a
 * chain with a hole in it is worse than one that is too long; a draft or a
 * queued message would be left referring to a step that no longer exists,
 * which is how a message goes out that nobody can account for.
 */
export async function deleteStepAction(campaignId: number, stepNumber: number) {
  const db = getDb();

  const held = db
    .prepare(
      `select
         sum(case when msg.status = 'sent' then 1 else 0 end) as sent,
         sum(case when msg.status in ('draft','scheduled','sending','uncertain','failed')
                  then 1 else 0 end) as pending
       from messages msg join enrollments e on e.id = msg.enrollment_id
      where e.campaign_id = ? and msg.step_number = ?`
    )
    .get(campaignId, stepNumber) as { sent: number | null; pending: number | null };

  const sent = held.sent ?? 0;
  const pending = held.pending ?? 0;

  if (sent > 0) {
    throw new Error(
      `Step ${stepNumber} has already been sent ${sent} time${sent === 1 ? "" : "s"}, so it cannot be removed.`
    );
  }

  if (pending > 0) {
    throw new Error(
      `${pending} message${pending === 1 ? "" : "s"} still point at step ${stepNumber}. Cancel them in the queue first.`
    );
  }

  db.prepare("delete from sequence_steps where campaign_id = ? and step_number = ?").run(
    campaignId,
    stepNumber
  );

  revalidatePath(`/campaigns/${campaignId}`);
  return { ok: true };
}

export async function updateCampaignAction(input: {
  campaignId: number;
  name: string;
  description?: string;
  windowStart: string;
  windowEnd: string;
  sendDays: number[];
  newPerDay: number;
  footer?: string;
}) {
  getDb()
    .prepare(
      `update campaigns
          set name = ?, description = ?, window_start = ?, window_end = ?,
              send_days = ?, new_per_day = ?, footer_template = ?
        where id = ?`
    )
    .run(
      input.name,
      input.description || null,
      input.windowStart,
      input.windowEnd,
      JSON.stringify(input.sendDays),
      input.newPerDay,
      input.footer || null,
      input.campaignId
    );

  revalidatePath(`/campaigns/${input.campaignId}`);
  revalidatePath("/campaigns");
  revalidatePath("/");
  return { ok: true };
}

export async function setCampaignState(
  campaignId: number,
  status: "draft" | "active" | "paused" | "archived"
) {
  setCampaignStatus(getDb(), campaignId, status);
  revalidatePath(`/campaigns/${campaignId}`);
  revalidatePath("/campaigns");
  revalidatePath("/");
  return { ok: true };
}

/**
 * Who a filter would enrol, and who it would skip, without writing anything.
 *
 * Every enrollment goes through this first. Enrolling is the one action here
 * that commits to emailing real people, so it is never a single click from a
 * text box: the list of companies and the reasons for each exclusion are shown
 * and confirmed before anything is stored.
 */
export async function previewEnrollAction(
  campaignId: number,
  filter: { match?: string; exclude?: string; grade?: string; limit?: number }
) {
  const db = getDb();
  const selection = selectContacts(db, filter);

  if (selection.error) {
    return {
      error: selection.error,
      considered: 0,
      matched: [] as { company: string; email: string; excerpt: string }[],
      eligible: 0,
      ineligible: [] as { company: string; kind: IneligibleKind; label: string }[],
      blocked: [] as { company: string; reason: string }[],
      sample: null as { company: string; subject: string; body: string } | null,
    };
  }

  const ids = selection.contacts.map((contact) => contact.contactId);
  const preview = previewEnrollment(db, campaignId, ids);
  const render = dryRender(db, campaignId, preview.eligible, 1);
  const first = render.rendered[0];

  return {
    error: null,
    considered: selection.considered,
    matched: selection.contacts.slice(0, 200).map((contact) => ({
      company: contact.company,
      email: contact.email,
      excerpt: contact.excerpt,
    })),
    eligible: render.rendered.length,
    ineligible: preview.ineligible.map((row) => ({
      company: row.company,
      kind: row.kind,
      label: INELIGIBLE_LABEL[row.kind],
    })),
    blocked: [
      ...render.blocked.map((row) => ({
        company: row.company,
        reason: row.findings
          .filter((finding) => finding.severity === "block")
          .map((finding) => finding.message)
          .join(" "),
      })),
      ...render.failed.map((row) => ({
        company: row.company,
        reason: `Nothing to fill ${row.missing.map((field) => `{{${field}}}`).join(", ")}.`,
      })),
    ],
    sample: first
      ? { company: first.company, subject: first.subject, body: first.body }
      : null,
  };
}

/** Enrol the contacts a filter selects. Drafts land in the review queue. */
export async function enrollAction(
  campaignId: number,
  filter: { match?: string; exclude?: string; grade?: string; limit?: number }
) {
  const db = getDb();
  const selection = selectContacts(db, filter);
  if (selection.error) throw new Error(selection.error);

  const result = enrollContacts(db, campaignId, {
    contactIds: selection.contacts.map((contact) => contact.contactId),
  });

  revalidatePath(`/campaigns/${campaignId}`);
  revalidatePath("/queue");
  revalidatePath("/");

  return {
    enrolled: result.enrolled,
    drafted: result.drafted,
    scheduled: result.scheduled,
    skipped: result.skipped.length,
    firstSendAt: result.firstSendAt ? result.firstSendAt.toISOString() : null,
    lastSendAt: result.lastSendAt ? result.lastSendAt.toISOString() : null,
  };
}
