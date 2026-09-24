import type { Db } from "@/lib/db";
import { fromSqliteBool } from "@/lib/db";
import { getMailbox, threadMailboxId, type MailboxRow } from "@/lib/campaign";
import { readKeychainPassword } from "@/lib/mail/keychain";
import { buildRawMessage, classifySmtpError, createTransport, sendMessage } from "@/lib/mail/smtp";
import { appendToSent } from "@/lib/mail/imap";
import { buildReferences, generateMessageId, replySubject } from "@/lib/mail/message-id";
import { findSuppression } from "@/lib/suppressions";
import { hasBlockingFindings } from "@/lib/template/lint";
import { lintReplyBody } from "./lint";

/**
 * Sending a reply by hand from the Inbox.
 *
 * Separate from the send worker on purpose. The worker paces a queue it
 * claimed itself; this is one message a person just read and decided to
 * answer, and the interesting work is the refusals rather than the send.
 */

export class ReplyBlockedError extends Error {}

export interface SendReplyResult {
  to: string;
  subject: string;
  from: string;
  response: string;
}

interface InboundRow {
  id: number;
  from_email: string;
  subject: string | null;
  rfc_message_id: string | null;
  matched_message_id: number | null;
  classification: string;
  sent_message_id: string | null;
  sent_references: string | null;
  sent_subject: string | null;
  enrollment_id: number | null;
}

/** Live sending requires the same opt-in the worker does. */
function isLive(): boolean {
  return process.env.OUTREACH_LIVE === "1";
}

/**
 * Everything that must be true before a reply may leave.
 *
 * Exported so the interface can show the reason without attempting a send,
 * and so each refusal can be asserted on.
 */
export function blockingReason(db: Db, inbound: InboundRow, body: string): string | null {
  if (!isLive()) {
    return "Live sending is off. Set OUTREACH_LIVE=1 in .env.local to send anything.";
  }

  if (!body.trim()) return "The reply is empty.";

  const findings = lintReplyBody(body);
  if (hasBlockingFindings(findings)) {
    return findings
      .filter((finding) => finding.severity === "block")
      .map((finding) => finding.message)
      .join(" ");
  }

  // Someone who opted out does not get a reply, however well meant.
  const suppression = findSuppression(db, inbound.from_email);
  if (suppression) {
    return `${inbound.from_email} is on the do-not-contact list (${suppression.kind} "${suppression.value}").`;
  }

  const already = db
    .prepare(
      `select status from sent_replies
        where inbound_id = ? and status in ('sending', 'sent', 'uncertain')`
    )
    .get(inbound.id) as { status: string } | undefined;

  if (already) {
    return already.status === "sent"
      ? "A reply has already been sent to this message."
      : "A reply to this message is already in flight, or its outcome is unknown.";
  }

  return null;
}

function loadInbound(db: Db, inboundId: number): InboundRow {
  const row = db
    .prepare(
      `select i.id, i.from_email, i.subject, i.rfc_message_id, i.matched_message_id,
              i.classification,
              m.message_id as sent_message_id,
              m.references_header as sent_references,
              m.subject as sent_subject,
              m.enrollment_id
         from inbound_messages i
         left join messages m on m.id = i.matched_message_id
        where i.id = ?`
    )
    .get(inboundId) as InboundRow | undefined;

  if (!row) throw new ReplyBlockedError(`No inbound message with id ${inboundId}`);
  return row;
}

/**
 * Which mailbox answers.
 *
 * The one that started the thread, so the reply arrives from the address they
 * have been talking to. A message that matched nothing has no thread, so it
 * falls back to the mailbox that received it.
 */
function replyMailbox(db: Db, inbound: InboundRow): MailboxRow {
  const fromThread = inbound.enrollment_id ? threadMailboxId(db, inbound.enrollment_id) : null;
  if (fromThread) return getMailbox(db, fromThread);

  const received = db
    .prepare("select mailbox_id from inbound_messages where id = ?")
    .get(inbound.id) as { mailbox_id: number };
  return getMailbox(db, received.mailbox_id);
}

export async function sendReply(db: Db, inboundId: number, body: string): Promise<SendReplyResult> {
  const inbound = loadInbound(db, inboundId);

  const blocked = blockingReason(db, inbound, body);
  if (blocked) throw new ReplyBlockedError(blocked);

  const mailbox = replyMailbox(db, inbound);
  if (mailbox.status !== "active") {
    throw new ReplyBlockedError(
      `The mailbox that owns this thread ("${mailbox.label}") is paused. Resume it first.`
    );
  }

  const subject = replySubject(inbound.subject ?? inbound.sent_subject ?? "(no subject)");
  const messageId = generateMessageId(mailbox.from_email);

  // Their message is the parent. The chain behind it is the one the original
  // send carried, plus that send, plus their reply.
  const inReplyTo = inbound.rfc_message_id;
  const references = inbound.sent_message_id
    ? buildReferences(
        buildReferences(inbound.sent_references, inbound.sent_message_id),
        inReplyTo ?? inbound.sent_message_id
      )
    : (inReplyTo ?? null);

  const to = process.env.REDIRECT_ALL_TO?.trim() || inbound.from_email;

  // Written before the send, so dying mid-flight leaves a row that reads as
  // uncertain rather than as an invitation to send again.
  const inserted = db
    .prepare(
      `insert into sent_replies
         (inbound_id, mailbox_id, to_email, subject, body, message_id,
          in_reply_to, references_header, status)
       values (?, ?, ?, ?, ?, ?, ?, ?, 'sending')`
    )
    .run(inboundId, mailbox.id, to, subject, body, messageId, inReplyTo, references);

  const replyRowId = Number(inserted.lastInsertRowid);
  const password = readKeychainPassword(mailbox.keychain_service, mailbox.keychain_account);
  const transport = createTransport(mailbox, password);

  const outgoing = {
    to,
    subject,
    body,
    messageId,
    inReplyTo: inReplyTo ?? undefined,
    references: references ?? undefined,
  };

  try {
    const outcome = await sendMessage(transport, mailbox, outgoing);

    db.prepare(
      `update sent_replies set status = 'sent', sent_at = ?, smtp_response = ? where id = ?`
    ).run(new Date().toISOString(), outcome.response, replyRowId);

    // Filing the copy is bookkeeping. The message is already delivered, so a
    // failure here must not be reported as a failed send.
    if (fromSqliteBool(mailbox.append_to_sent)) {
      try {
        await appendToSent(mailbox, password, await buildRawMessage(mailbox, outgoing));
      } catch {
        // Deliberately swallowed. The send succeeded.
      }
    }

    db.prepare("update inbound_messages set handled = 1 where id = ?").run(inboundId);

    return { to, subject, from: mailbox.from_email, response: outcome.response };
  } catch (error) {
    const classified = classifySmtpError(error);

    db.prepare("update sent_replies set status = ?, error = ? where id = ?").run(
      classified.certainty === "not-sent" ? "failed" : "uncertain",
      classified.message,
      replyRowId
    );

    throw new Error(
      classified.certainty === "not-sent"
        ? `Not sent: ${classified.message}`
        : `The outcome is unknown and it may have been delivered: ${classified.message}`,
      { cause: error }
    );
  } finally {
    transport.close();
  }
}
