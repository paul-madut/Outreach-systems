import nodemailer, { type Transporter } from "nodemailer";
import type { MailboxRow } from "@/lib/campaign";

/**
 * Sending over SMTP.
 *
 * The endpoints and the app-specific-password approach are carried over from
 * `~/Desktop/peptide-outreach/send.py`, which delivered 51 of 53 on its first
 * real run. Plain text only, deliberately: an HTML part makes a one-to-one
 * email look like a campaign, and the whole pitch here is that it is not.
 */

export interface OutgoingMessage {
  to: string;
  subject: string;
  body: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string | null;
}

export interface SendOutcome {
  response: string;
  /** The id the server accepted, which should match what we generated. */
  messageId: string;
}

/**
 * How certain we are that a failed send did NOT reach the recipient.
 *
 * This drives the difference between retrying and parking a message for a
 * human, so it is the most consequential classification in the tool.
 */
export type FailureCertainty = "not-sent" | "ambiguous";

export interface ClassifiedError {
  certainty: FailureCertainty;
  /** Permanent rejection. Retrying will not help, and the address is bad. */
  permanent: boolean;
  /** Credentials were rejected, so every other send will fail too. */
  authFailure: boolean;
  message: string;
  responseCode: number | null;
}

interface NodemailerError extends Error {
  responseCode?: number;
  response?: string;
  command?: string;
  code?: string;
}

/**
 * Decide what a send failure means.
 *
 * The rule: a failure is only safe to retry when we know the server never
 * accepted the message. A response code proves the server answered, and which
 * class it is says whether to retry. A socket error before DATA proves nothing
 * was transmitted. A socket error at or after DATA is genuinely unknowable -
 * the server may have accepted and queued it before the connection dropped -
 * so it becomes 'ambiguous' and the message waits for a human.
 */
export function classifySmtpError(error: unknown): ClassifiedError {
  const err = error as NodemailerError;
  const code = typeof err?.responseCode === "number" ? err.responseCode : null;
  const command = (err?.command ?? "").toUpperCase();
  const message = err?.response || err?.message || String(error);

  if (code !== null) {
    // The server answered, so it definitely did not accept the message.
    return {
      certainty: "not-sent",
      permanent: code >= 500,
      authFailure: code === 535 || code === 534 || code === 530,
      message,
      responseCode: code,
    };
  }

  if (err?.code === "EAUTH") {
    return {
      certainty: "not-sent",
      permanent: true,
      authFailure: true,
      message,
      responseCode: null,
    };
  }

  // No response code means a transport-level failure. Where it happened is
  // what decides whether anything could have been delivered.
  const beforeData = ["CONN", "EHLO", "HELO", "STARTTLS", "AUTH", "MAIL FROM", "RCPT TO"];
  if (beforeData.includes(command) || ["ECONNECTION", "ETIMEDOUT", "EDNS"].includes(err?.code ?? "")) {
    return {
      certainty: "not-sent",
      permanent: false,
      authFailure: false,
      message,
      responseCode: null,
    };
  }

  return {
    certainty: "ambiguous",
    permanent: false,
    authFailure: false,
    message: `${message} (failed at ${command || "an unknown stage"}, so delivery is unknown)`,
    responseCode: null,
  };
}

export function createTransport(mailbox: MailboxRow, password: string): Transporter {
  return nodemailer.createTransport({
    host: mailbox.smtp_host,
    port: mailbox.smtp_port,
    // 587 with STARTTLS, which is what both iCloud and Gmail want.
    secure: mailbox.smtp_port === 465,
    requireTLS: mailbox.smtp_port !== 465,
    auth: { user: mailbox.smtp_user, pass: password },
    // A worker runs unattended, so every stage needs a ceiling or a hung
    // socket holds the lock until someone notices.
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 45_000,
    // One connection per tick. Pooling across ticks would keep a socket open
    // for the minutes between them and gain nothing at this volume.
    pool: false,
    logger: false,
  });
}

export async function sendMessage(
  transport: Transporter,
  mailbox: MailboxRow,
  message: OutgoingMessage
): Promise<SendOutcome> {
  const info = await transport.sendMail({
    from: { name: mailbox.from_name, address: mailbox.from_email },
    replyTo: mailbox.reply_to ?? undefined,
    to: message.to,
    subject: message.subject,
    text: message.body,
    messageId: message.messageId,
    inReplyTo: message.inReplyTo ?? undefined,
    references: message.references ?? undefined,
  });

  return {
    response: info.response ?? "accepted",
    messageId: info.messageId ?? message.messageId,
  };
}

/** Build the RFC822 source to file in Sent, for providers that do not. */
export async function buildRawMessage(
  mailbox: MailboxRow,
  message: OutgoingMessage
): Promise<Buffer> {
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "unix",
  });

  const info = await transport.sendMail({
    from: { name: mailbox.from_name, address: mailbox.from_email },
    replyTo: mailbox.reply_to ?? undefined,
    to: message.to,
    subject: message.subject,
    text: message.body,
    messageId: message.messageId,
    inReplyTo: message.inReplyTo ?? undefined,
    references: message.references ?? undefined,
    date: new Date(),
  });

  return info.message as Buffer;
}
