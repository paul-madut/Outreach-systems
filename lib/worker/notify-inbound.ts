import type { Db } from "@/lib/db";
import { sendSlack } from "@/lib/notify/slack";
import { ALERTED, alertText, type AlertableInbound } from "@/lib/notify/inbound-alert";

/**
 * Announce inbound mail in Slack.
 *
 * Runs after polling rather than inside it, for two reasons. Polling writes in
 * a transaction and a network call has no business in one. And splitting them
 * means a Slack outage costs nothing: the row keeps its null `notified_at` and
 * the next run picks it up.
 *
 * Send first, mark second. The other order loses a notification whenever the
 * process dies between the two, and a duplicate ping is a far cheaper mistake
 * than a reply nobody hears about.
 */

export interface NotifyResult {
  sent: number;
  failed: number;
  notes: string[];
}

export async function notifyInbound(db: Db, limit = 20): Promise<NotifyResult> {
  const result: NotifyResult = { sent: 0, failed: 0, notes: [] };

  if (!process.env.SLACK_WEBHOOK_URL) return result;

  const placeholders = [...ALERTED].map(() => "?").join(", ");
  const rows = db
    .prepare(
      `select i.id, i.classification, i.from_email, i.subject, i.snippet, i.received_at,
              mb.label as mailbox_label,
              p.company as company,
              c.name as campaign
         from inbound_messages i
         join mailboxes mb on mb.id = i.mailbox_id
         left join messages m on m.id = i.matched_message_id
         left join enrollments e on e.id = m.enrollment_id
         left join campaigns c on c.id = e.campaign_id
         left join contacts ct on ct.id = e.contact_id
         left join prospects p on p.id = ct.prospect_id
        where i.notified_at is null
          and i.classification in (${placeholders})
        order by i.id
        limit ?`
    )
    .all(...ALERTED, limit) as AlertableInbound[];

  const markNotified = db.prepare(
    "update inbound_messages set notified_at = ? where id = ?"
  );

  for (const row of rows) {
    const slack = await sendSlack(alertText(row));

    if (!slack.ok) {
      result.failed += 1;
      result.notes.push(`Slack send failed for inbound ${row.id}: ${slack.reason}`);
      // Stop on the first failure. The rest will fail the same way, and
      // hammering a broken webhook only delays the retry.
      break;
    }

    markNotified.run(new Date().toISOString(), row.id);
    result.sent += 1;
  }

  return result;
}

/**
 * Treat everything already in the table as announced.
 *
 * Run once when the notifier is first switched on, or the first poll posts
 * every inbound message ever received.
 */
export function markExistingNotified(db: Db): number {
  return db
    .prepare(
      "update inbound_messages set notified_at = ? where notified_at is null"
    )
    .run(new Date().toISOString()).changes;
}
