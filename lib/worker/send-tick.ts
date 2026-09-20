import type { Transporter } from "nodemailer";
import type { Db } from "@/lib/db";
import { fromSqliteBool } from "@/lib/db";
import { getMailbox, setMailboxStatus, type MailboxRow } from "@/lib/campaign";
import { readKeychainPassword } from "@/lib/mail/keychain";
import {
  buildRawMessage,
  classifySmtpError,
  createTransport,
  sendMessage,
  type OutgoingMessage,
} from "@/lib/mail/smtp";
import { appendToSent } from "@/lib/mail/imap";
import { createNextStep, ensureNextSteps } from "@/lib/enroll/next-step";
import {
  claimDueMessages,
  markSent,
  markUncertain,
  releaseMessage,
} from "./claim";

/**
 * One pass of the send worker.
 *
 * Order matters:
 *   1. Repair any enrollment left without a next step by an earlier crash.
 *   2. Claim what is due, which applies the cap, window and pacing in SQL.
 *   3. Send, and record the outcome honestly.
 *   4. Create the follow-up for whatever just sent.
 *
 * Nothing sleeps. Each message already carries its own scheduled_at, so the
 * worker takes a few, exits, and lets launchd wake it again.
 */

export interface SendTickResult {
  claimed: number;
  sent: number;
  released: number;
  uncertain: number;
  failed: number;
  followUpsCreated: number;
  mailboxesPaused: string[];
  live: boolean;
  notes: string[];
}

export interface SendTickOptions {
  limit?: number;
  now?: Date;
  rng?: () => number;
  /**
   * Injected by tests. Production passes nothing and the real SMTP path runs.
   */
  sender?: (mailbox: MailboxRow, message: OutgoingMessage) => Promise<{ response: string }>;
}

/** Live sending requires an explicit opt-in, so a dev run cannot email a prospect. */
export function isLive(): boolean {
  return process.env.OUTREACH_LIVE === "1";
}

/** Reroute every message to one address, for end-to-end tests. */
function redirectTarget(): string | null {
  const value = process.env.REDIRECT_ALL_TO?.trim();
  return value ? value : null;
}

/** Two consecutive failures on a mailbox stops the run, as the old script did. */
const CONSECUTIVE_FAILURE_LIMIT = 2;

export async function runSendTick(
  db: Db,
  options: SendTickOptions = {}
): Promise<SendTickResult> {
  const { limit = 5, now = new Date(), rng = Math.random } = options;

  const result: SendTickResult = {
    claimed: 0,
    sent: 0,
    released: 0,
    uncertain: 0,
    failed: 0,
    followUpsCreated: 0,
    mailboxesPaused: [],
    live: isLive(),
    notes: [],
  };

  // Repair before claiming, so a follow-up that should already be queued gets
  // its slot in this tick rather than the next one.
  const repaired = ensureNextSteps(db, { now, rng });
  const repairedCount = repaired.filter((r) => r.created).length;
  if (repairedCount > 0) {
    result.notes.push(`Queued ${repairedCount} follow-up(s) that were missing.`);
  }

  const claimed = claimDueMessages(db, { limit, now, rng });
  result.claimed = claimed.length;
  if (claimed.length === 0) return result;

  const redirect = redirectTarget();
  const transports = new Map<number, Transporter>();
  const passwords = new Map<number, string>();
  const consecutiveFailures = new Map<number, number>();
  const sentEnrollments: number[] = [];

  try {
    for (const message of claimed) {
      const mailbox = getMailbox(db, message.mailbox_id);

      if (mailbox.status !== "active") {
        releaseMessage(db, message.id, `Mailbox paused: ${mailbox.paused_reason ?? ""}`.trim());
        result.released += 1;
        continue;
      }

      const outgoing: OutgoingMessage = {
        to: redirect ?? message.to_email,
        subject: message.subject,
        body: message.body,
        messageId: message.message_id,
        inReplyTo: message.in_reply_to,
        references: message.references_header,
      };

      // Without the live flag the whole pipeline runs except the network call,
      // so a dev run exercises claiming, rendering and logging safely.
      if (!result.live && !options.sender) {
        releaseMessage(
          db,
          message.id,
          "OUTREACH_LIVE is not set, so nothing was sent.",
          60,
          Number.MAX_SAFE_INTEGER
        );
        result.released += 1;
        result.notes.push(`Would have sent to ${outgoing.to}.`);
        continue;
      }

      try {
        let response: string;

        if (options.sender) {
          response = (await options.sender(mailbox, outgoing)).response;
        } else {
          let password = passwords.get(mailbox.id);
          if (!password) {
            password = readKeychainPassword(mailbox.keychain_service, mailbox.keychain_account);
            passwords.set(mailbox.id, password);
          }

          let transport = transports.get(mailbox.id);
          if (!transport) {
            transport = createTransport(mailbox, password);
            transports.set(mailbox.id, transport);
          }

          response = (await sendMessage(transport, mailbox, outgoing)).response;

          // iCloud does not keep a copy of what SMTP sends, so without this the
          // Sent folder is empty and there is no record outside this database.
          if (fromSqliteBool(mailbox.append_to_sent)) {
            try {
              const raw = await buildRawMessage(mailbox, outgoing);
              await appendToSent(mailbox, password, raw);
            } catch (error) {
              // Filing is bookkeeping. The message is already delivered, so a
              // failure here must not be reported as a send failure.
              result.notes.push(
                `Sent to ${outgoing.to} but could not file a copy in Sent: ${
                  (error as Error).message
                }`
              );
            }
          }
        }

        markSent(db, message.id, response);
        result.sent += 1;
        sentEnrollments.push(message.enrollment_id);
        consecutiveFailures.set(mailbox.id, 0);
      } catch (error) {
        const classified = classifySmtpError(error);

        if (classified.certainty === "ambiguous") {
          markUncertain(db, message.id, classified.message);
          result.uncertain += 1;
        } else if (classified.permanent) {
          releaseMessage(db, message.id, classified.message, 0, 0);
          result.failed += 1;
        } else {
          releaseMessage(db, message.id, classified.message);
          result.released += 1;
        }

        const failures = (consecutiveFailures.get(mailbox.id) ?? 0) + 1;
        consecutiveFailures.set(mailbox.id, failures);

        // Carried over from scheduled_send.py. Bad credentials or a run of
        // failures means every remaining send will fail the same way, and
        // grinding through the queue only burns the mailbox's reputation.
        if (classified.authFailure || failures >= CONSECUTIVE_FAILURE_LIMIT) {
          const reason = classified.authFailure
            ? `Authentication failed: ${classified.message}`
            : `${failures} failures in a row: ${classified.message}`;

          setMailboxStatus(db, mailbox.id, "paused", reason);
          result.mailboxesPaused.push(mailbox.label);
          result.notes.push(`Paused "${mailbox.label}". ${reason}`);

          for (const remaining of claimed) {
            if (remaining.mailbox_id === mailbox.id && remaining.id !== message.id) {
              releaseMessage(db, remaining.id, "Mailbox paused mid-tick.");
              result.released += 1;
            }
          }
          break;
        }
      }
    }
  } finally {
    for (const transport of transports.values()) transport.close();
  }

  // Queue the follow-up for anything that just went out. Done after the send
  // loop so a failure part way through still leaves the earlier sends with
  // their next step queued.
  for (const enrollmentId of sentEnrollments) {
    if (createNextStep(db, enrollmentId, { now, rng }).created) {
      result.followUpsCreated += 1;
    }
  }

  return result;
}
