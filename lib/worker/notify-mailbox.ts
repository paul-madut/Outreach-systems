import type { Db } from "@/lib/db";
import { sendSlack } from "@/lib/notify/slack";
import { pauseAlertText, type PausedMailbox } from "@/lib/notify/mailbox-alert";

/**
 * Announce mailboxes that have paused themselves.
 *
 * Keyed off a column rather than off the tick's own result, for the same
 * reason inbound alerts are: a worker that dies, or a Slack outage, must not
 * swallow the notice. A paused mailbox that has not been announced is still
 * owed one on the next run, however long that takes.
 *
 * This matters more than an inbound alert. A pause is silent - the queue just
 * stops moving - and the only other way to find out is to go and look.
 */

export interface PauseNotifyResult {
  sent: number;
  notes: string[];
}

export async function notifyMailboxPauses(db: Db): Promise<PauseNotifyResult> {
  const result: PauseNotifyResult = { sent: 0, notes: [] };

  if (!process.env.SLACK_WEBHOOK_URL) return result;

  const rows = db
    .prepare(
      `select mb.id, mb.label, mb.from_email, mb.paused_reason,
              (select count(*) from messages m
                where m.mailbox_id = mb.id and m.status = 'scheduled') as queued
         from mailboxes mb
        where mb.status = 'paused' and mb.pause_notified_at is null
        order by mb.id`
    )
    .all() as PausedMailbox[];

  const mark = db.prepare("update mailboxes set pause_notified_at = ? where id = ?");

  for (const mailbox of rows) {
    const slack = await sendSlack(pauseAlertText(mailbox));

    if (!slack.ok) {
      result.notes.push(`Slack send failed for mailbox ${mailbox.label}: ${slack.reason}`);
      break;
    }

    mark.run(new Date().toISOString(), mailbox.id);
    result.sent += 1;
  }

  return result;
}

/** Treat current pauses as already announced, when switching alerts on. */
export function markPausesNotified(db: Db): number {
  return db
    .prepare(
      "update mailboxes set pause_notified_at = ? where status = 'paused' and pause_notified_at is null"
    )
    .run(new Date().toISOString()).changes;
}
