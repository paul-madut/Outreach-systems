/**
 * What a paused mailbox looks like in Slack.
 *
 * Pure, so the wording is testable without a webhook.
 */
import { escapeSlack } from "./inbound-alert";

export interface PausedMailbox {
  id: number;
  label: string;
  from_email: string;
  paused_reason: string | null;
  queued: number;
}

/**
 * A pause is louder than a reply, so it says so.
 *
 * Nothing sends from a paused mailbox and nothing says so anywhere else: the
 * queue simply stops moving. The count of stranded messages is the part that
 * makes the urgency legible.
 */
export function pauseAlertText(mailbox: PausedMailbox): string {
  const reason = mailbox.paused_reason?.trim() || "No reason recorded";
  const queued =
    mailbox.queued === 1 ? "1 message is waiting" : `${mailbox.queued} messages are waiting`;

  return [
    `*Mailbox paused: ${escapeSlack(mailbox.label)}* (${escapeSlack(mailbox.from_email)})`,
    `> ${escapeSlack(reason)}`,
    `Nothing will send from it until it is resumed. ${queued}.`,
    "`pnpm mailbox resume " + escapeSlack(mailbox.label) + "`",
  ].join("\n");
}
