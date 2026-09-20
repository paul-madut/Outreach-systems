import type { Db } from "@/lib/db";
import { nowIso, toIso } from "@/lib/db";
import { getMailbox, setMailboxStatus, type MailboxRow } from "@/lib/campaign";
import { readKeychainPassword } from "@/lib/mail/keychain";
import { connect, fetchSince, resolveFolders, type FetchedMessage } from "@/lib/mail/imap";
import { classifyInbound, senderAddress } from "@/lib/mail/classify-inbound";
import { matchInbound, type SentLookup } from "@/lib/mail/match-inbound";
import { addSuppression } from "@/lib/suppressions";
import { stopEnrollment } from "./claim";

/**
 * Reading a mailbox and acting on what is there.
 *
 * This is what makes multi-step sequences safe. Without it, step 2 goes to
 * somebody who already replied, or to an address that hard bounced.
 *
 * Classification runs before matching, because what a message IS decides what
 * happens: a bounce suppresses, a reply stops the sequence, an auto-reply does
 * neither. Most of Paul's recipients are support@ addresses behind a helpdesk,
 * so treating every inbound message as a reply would kill most sequences after
 * the first send.
 */

export interface PollResult {
  mailbox: string;
  fetched: number;
  replies: number;
  autoReplies: number;
  bounces: number;
  unsubscribes: number;
  unmatched: number;
  stopped: number;
  suppressed: number;
  notes: string[];
}

/** Hard bounces in a day above which the mailbox is paused. */
const HARD_BOUNCE_PAUSE_THRESHOLD = 3;

/** How far back a bare address or domain match may reach. */
const LOOSE_MATCH_WINDOW_DAYS = 45;

/**
 * Index of what this mailbox has sent, for matching inbound mail against.
 *
 * Built once per poll. At this volume the whole sent history fits comfortably
 * in memory, and doing it per message would mean a query per inbound item.
 */
export function buildSentLookup(db: Db, mailboxId: number): SentLookup & { sentAt: Map<string, Date> } {
  const rows = db
    .prepare(
      `select id, message_id, to_email, sent_at
         from messages
        where mailbox_id = ? and status in ('sent', 'uncertain')
        order by sent_at desc`
    )
    .all(mailboxId) as {
    id: number;
    message_id: string;
    to_email: string;
    sent_at: string | null;
  }[];

  const byMessageId = new Map<string, string>();
  const byRecipient = new Map<string, string[]>();
  const byRecipientDomain = new Map<string, string[]>();
  const sentAt = new Map<string, Date>();

  for (const row of rows) {
    const id = String(row.id);
    byMessageId.set(row.message_id, id);
    if (row.sent_at) sentAt.set(id, new Date(row.sent_at));

    const email = row.to_email.toLowerCase();
    byRecipient.set(email, [...(byRecipient.get(email) ?? []), id]);

    const domain = email.split("@")[1];
    if (domain) {
      byRecipientDomain.set(domain, [...(byRecipientDomain.get(domain) ?? []), id]);
    }
  }

  return { byMessageId, byRecipient, byRecipientDomain, sentAt };
}

function readCursor(db: Db, mailboxId: number, folder: string) {
  const row = db
    .prepare("select uidvalidity, last_uid from imap_cursors where mailbox_id = ? and folder = ?")
    .get(mailboxId, folder) as { uidvalidity: number | null; last_uid: number } | undefined;

  return { uidvalidity: row?.uidvalidity ?? null, lastUid: row?.last_uid ?? 0 };
}

function writeCursor(
  db: Db,
  mailboxId: number,
  folder: string,
  cursor: { uidvalidity: number | null; lastUid: number }
): void {
  db.prepare(
    `insert into imap_cursors (mailbox_id, folder, uidvalidity, last_uid, last_polled_at)
     values (?, ?, ?, ?, ?)
     on conflict (mailbox_id, folder) do update set
       uidvalidity = excluded.uidvalidity,
       last_uid = excluded.last_uid,
       last_polled_at = excluded.last_polled_at`
  ).run(mailboxId, folder, cursor.uidvalidity, cursor.lastUid, nowIso());
}

/**
 * Apply one inbound message.
 *
 * Pure enough to test without a network: it takes an already-fetched message
 * and the lookup, and does everything else against the database.
 */
export function applyInbound(
  db: Db,
  mailbox: MailboxRow,
  message: FetchedMessage,
  lookup: ReturnType<typeof buildSentLookup>,
  result: PollResult,
  now = new Date()
): void {
  const classified = classifyInbound(message);
  const match = matchInbound(message, lookup, {
    now,
    looseMatchWindowDays: LOOSE_MATCH_WINDOW_DAYS,
    sentAt: lookup.sentAt,
  });

  const matchedId = match ? Number(match.messageId) : null;
  const classification = match ? classified.classification : "unmatched";

  const inserted = db
    .prepare(
      `insert into inbound_messages
         (mailbox_id, folder, uid, rfc_message_id, from_email, subject, received_at,
          snippet, classification, classification_reason, matched_message_id,
          match_method, dsn_status)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       -- The unique index is partial, and SQLite needs the WHERE repeated here
       -- or it will not recognise the conflict target at all. A message with no
       -- Message-ID cannot be deduped, which is why the index is partial: those
       -- are rare, and recording one twice is better than dropping it.
       on conflict (mailbox_id, rfc_message_id) where rfc_message_id is not null
       do nothing`
    )
    .run(
      mailbox.id,
      message.folder,
      message.uid,
      message.headers.messageId,
      senderAddress(message.headers.from),
      message.headers.subject,
      toIso(message.receivedAt),
      message.text.slice(0, 400),
      classification,
      classified.reason,
      matchedId,
      match?.method ?? null,
      classified.dsn?.status ?? null
    );

  // Already seen on an earlier poll. Re-applying would stop a sequence the
  // user had deliberately restarted.
  if (inserted.changes === 0) return;

  result.fetched += 1;

  if (classification === "unmatched") {
    result.unmatched += 1;
    return;
  }

  const enrollment = matchedId
    ? (db.prepare("select enrollment_id from messages where id = ?").get(matchedId) as
        | { enrollment_id: number }
        | undefined)
    : undefined;

  switch (classified.classification) {
    case "auto_reply":
      // Deliberately does nothing to the sequence. A Zendesk or Gorgias
      // acknowledgement is not a human saying no.
      result.autoReplies += 1;
      return;

    case "bounce": {
      result.bounces += 1;
      if (!classified.dsn?.hard) {
        // Soft bounce. Temporary, so suppressing would retire a live prospect.
        result.notes.push(
          `Soft bounce from ${senderAddress(message.headers.from)}, left alone.`
        );
        return;
      }

      const address = classified.suppress ?? null;
      if (address) {
        addSuppression(db, "email", address, "Hard bounce", "reply poller");
        result.suppressed += 1;
      }
      if (enrollment) {
        stopEnrollment(db, enrollment.enrollment_id, "bounced", classified.reason);
        result.stopped += 1;
      }
      return;
    }

    case "unsubscribe": {
      result.unsubscribes += 1;
      if (classified.suppress) {
        addSuppression(db, "email", classified.suppress, "Asked to stop", "reply poller");
        result.suppressed += 1;
      }
      if (enrollment) {
        stopEnrollment(db, enrollment.enrollment_id, "stopped", "Asked to stop");
        result.stopped += 1;
      }
      return;
    }

    case "reply": {
      result.replies += 1;
      if (!enrollment) return;

      stopEnrollment(db, enrollment.enrollment_id, "replied", classified.reason);
      result.stopped += 1;

      // Someone at the company answered, so stop writing to their colleagues
      // too. Two people at one company getting the same pitch after one has
      // already replied reads as automated, which it is.
      const siblings = db
        .prepare(
          `select e.id from enrollments e
             join contacts c on c.id = e.contact_id
            where e.status = 'active'
              and c.prospect_id = (
                select c2.prospect_id from enrollments e2
                  join contacts c2 on c2.id = e2.contact_id
                 where e2.id = ?
              )`
        )
        .all(enrollment.enrollment_id) as { id: number }[];

      for (const sibling of siblings) {
        stopEnrollment(db, sibling.id, "stopped", "A colleague replied.");
        result.stopped += 1;
      }
      return;
    }
  }
}

/** Pause a mailbox that is producing hard bounces, which wrecks reputation. */
function checkBounceRate(db: Db, mailbox: MailboxRow, result: PollResult): void {
  const since = toIso(new Date(Date.now() - 86_400_000));
  const row = db
    .prepare(
      `select count(*) as n from inbound_messages
        where mailbox_id = ? and classification = 'bounce'
          and dsn_status like '5.%' and received_at >= ?`
    )
    .get(mailbox.id, since) as { n: number };

  if (row.n >= HARD_BOUNCE_PAUSE_THRESHOLD && mailbox.status === "active") {
    const reason = `${row.n} hard bounces in 24 hours. Check the list before sending more.`;
    setMailboxStatus(db, mailbox.id, "paused", reason);
    result.notes.push(`Paused "${mailbox.label}". ${reason}`);
  }
}

export interface PollOptions {
  now?: Date;
  limitPerFolder?: number;
}

/** Poll one mailbox over IMAP and apply everything new. */
export async function pollMailbox(
  db: Db,
  mailboxId: number,
  options: PollOptions = {}
): Promise<PollResult> {
  const { now = new Date(), limitPerFolder = 100 } = options;
  const mailbox = getMailbox(db, mailboxId);

  const result: PollResult = {
    mailbox: mailbox.label,
    fetched: 0,
    replies: 0,
    autoReplies: 0,
    bounces: 0,
    unsubscribes: 0,
    unmatched: 0,
    stopped: 0,
    suppressed: 0,
    notes: [],
  };

  const password = readKeychainPassword(mailbox.keychain_service, mailbox.keychain_account);
  const client = await connect(mailbox, password);

  try {
    const lookup = buildSentLookup(db, mailbox.id);
    const folders = await resolveFolders(client);

    for (const folder of folders) {
      const cursor = readCursor(db, mailbox.id, folder);
      const fetched = await fetchSince(client, folder, cursor, limitPerFolder);

      if (fetched.uidValidityChanged) {
        result.notes.push(
          `${folder}: the server reset its UIDs, so the cursor started over.`
        );
      }

      const apply = db.transaction(() => {
        for (const message of fetched.messages) {
          applyInbound(db, mailbox, message, lookup, result, now);
        }
        writeCursor(db, mailbox.id, folder, fetched.cursor);
      });
      apply();
    }

    checkBounceRate(db, mailbox, result);
  } finally {
    await client.logout().catch(() => client.close());
  }

  return result;
}

/** Poll every active mailbox, reporting per mailbox rather than failing all. */
export async function pollAllMailboxes(
  db: Db,
  options: PollOptions = {}
): Promise<PollResult[]> {
  const mailboxes = db
    .prepare("select id, label from mailboxes where status = 'active' order by id")
    .all() as { id: number; label: string }[];

  const results: PollResult[] = [];

  for (const mailbox of mailboxes) {
    try {
      results.push(await pollMailbox(db, mailbox.id, options));
    } catch (error) {
      results.push({
        mailbox: mailbox.label,
        fetched: 0,
        replies: 0,
        autoReplies: 0,
        bounces: 0,
        unsubscribes: 0,
        unmatched: 0,
        stopped: 0,
        suppressed: 0,
        notes: [`Poll failed: ${(error as Error).message}`],
      });
    }
  }

  return results;
}
