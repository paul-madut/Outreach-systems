"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { approveDrafts, updateDraft } from "@/lib/enroll";
import { stopEnrollment } from "@/lib/worker/claim";
import { setMailboxStatus } from "@/lib/campaign";
import { addSuppression } from "@/lib/suppressions";

/**
 * Server actions for the dashboard.
 *
 * Deliberately few. Everything that decides what gets sent lives in the
 * worker and the enrollment code, and these only cover the judgement calls a
 * person has to make: approve a draft, resolve an unknown outcome, stop a
 * sequence, pause a mailbox.
 */

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


