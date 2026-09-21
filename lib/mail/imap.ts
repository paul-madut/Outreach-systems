import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { MailboxRow } from "@/lib/campaign";
import type { InboundMessage } from "./classify-inbound";

/**
 * IMAP: filing sent copies, and reading what comes back.
 *
 * Two things carried over from the Python version, both learned the hard way:
 * iCloud's folders are literally named "Sent Messages" and "Deleted Messages"
 * with spaces, and a copy has to be appended there manually because SMTP
 * sending leaves no record.
 *
 * Polling uses a UID cursor rather than IMAP SINCE. SINCE only has day
 * granularity, so date-based polling either misses messages that arrive later
 * the same day or reprocesses the whole day every time.
 */

const SENT_FOLDER_CANDIDATES = ["Sent Messages", "Sent", "[Gmail]/Sent Mail", "INBOX.Sent"];

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function connect(mailbox: MailboxRow, password: string): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: mailbox.imap_host,
    port: mailbox.imap_port,
    secure: true,
    auth: { user: mailbox.imap_user, pass: password },
    logger: false,
    // An unhandled 'error' event on this client would take the process down
    // while it holds the worker lock.
    emitLogs: false,
  });

  client.on("error", () => {
    // Swallowed on purpose. Every call site already handles a rejected promise,
    // and an unhandled event here is fatal to the whole worker.
  });

  await client.connect();
  return client;
}

/** The Sent folder's real name, which differs per provider. */
export async function findSentFolder(client: ImapFlow): Promise<string | null> {
  const list = await client.list();
  const bySpecialUse = list.find((box) => box.specialUse === "\\Sent");
  if (bySpecialUse) return bySpecialUse.path;

  for (const candidate of SENT_FOLDER_CANDIDATES) {
    if (list.some((box) => box.path === candidate)) return candidate;
  }
  return null;
}

/**
 * File a copy of a sent message.
 *
 * iCloud keeps no record of what SMTP sends, so without this the Sent folder
 * stays empty and the only evidence a message went out is this tool's own
 * database.
 */
export async function appendToSent(
  mailbox: MailboxRow,
  password: string,
  raw: Buffer
): Promise<void> {
  const client = await connect(mailbox, password);
  try {
    const folder = await findSentFolder(client);
    if (!folder) throw new Error("Could not find a Sent folder on this account.");
    await client.append(folder, raw, ["\\Seen"], new Date());
  } finally {
    await client.logout().catch(() => client.close());
  }
}

export interface FetchedMessage extends InboundMessage {
  uid: number;
  folder: string;
  receivedAt: Date;
}

export interface FolderCursor {
  uidvalidity: number | null;
  lastUid: number;
}

export interface FetchResult {
  messages: FetchedMessage[];
  cursor: FolderCursor;
  /** True when the server reset its UIDs and the cursor had to start over. */
  uidValidityChanged: boolean;
}

/**
 * Pick the UID to start a FIRST poll from.
 *
 * Starting at 1 is what a fresh cursor naively means, and on a personal
 * mailbox it is catastrophic: the fetch asks for the full source of every
 * message, so iCloud streams years of mail down the wire. The first run took
 * more than ten minutes and had ingested nothing when it was killed. The
 * `limit` does not save you, because it only stops messages being parsed
 * after the server has already sent them.
 *
 * Nothing older than the first email this tool sent can be a reply to it, so
 * the first poll seeds from a date instead. SINCE is only day-granular, which
 * is the reason it is not used for incremental polling, but for picking a
 * floor once it is exactly right.
 */
async function seedStartUid(
  client: ImapFlow,
  since: Date
): Promise<number> {
  const uids = (await client.search({ since }, { uid: true })) as number[] | false;

  // Nothing that recent. Start at the top: the next poll reads forward from
  // here, and there is no history worth having.
  if (!uids || uids.length === 0) {
    const box = client.mailbox;
    return typeof box === "boolean" ? 0 : Number(box.uidNext ?? 1) - 1;
  }

  return Math.min(...uids) - 1;
}

/**
 * Read everything new in one folder.
 *
 * `uidvalidity` is the server's promise that UIDs are stable. When it changes,
 * every stored UID is meaningless and the cursor has to reset, which is why it
 * is tracked alongside the cursor rather than assumed.
 */
export async function fetchSince(
  client: ImapFlow,
  folder: string,
  cursor: FolderCursor,
  limit = 100,
  /** Only consulted on a first poll, to avoid reading the whole mailbox. */
  seedSince?: Date
): Promise<FetchResult> {
  const lock = await client.getMailboxLock(folder);
  const messages: FetchedMessage[] = [];

  try {
    const box = client.mailbox;
    if (typeof box === "boolean") {
      throw new Error(`Could not open ${folder}.`);
    }

    const uidValidity = Number(box.uidValidity);
    const uidValidityChanged =
      cursor.uidvalidity !== null && cursor.uidvalidity !== uidValidity;

    // A cursor of 0 means this folder has never been read, either because it
    // is the first poll or because the server reset its UIDs.
    const fresh = uidValidityChanged || cursor.lastUid === 0;
    const startUid =
      fresh && seedSince ? await seedStartUid(client, seedSince) : uidValidityChanged ? 0 : cursor.lastUid;

    let highestUid = startUid;

    // `${n}:*` always returns at least one message even when nothing is new,
    // because the server clamps to the highest existing UID. The explicit
    // filter below is what makes the range safe.
    if (box.exists > 0) {
      for await (const raw of client.fetch(
        `${startUid + 1}:*`,
        { uid: true, source: true, envelope: true, internalDate: true },
        { uid: true }
      )) {
        if (raw.uid <= startUid) continue;
        highestUid = Math.max(highestUid, raw.uid);
        if (messages.length >= limit) continue;

        const parsed = await simpleParser(raw.source as Buffer);
        const headers = parsed.headers;
        const header = (name: string): string | null => {
          const value = headers.get(name);
          if (value === undefined || value === null) return null;
          return typeof value === "string" ? value : String((value as { value?: unknown }).value ?? value);
        };

        messages.push({
          uid: raw.uid,
          folder,
          // internalDate can arrive as a string depending on the server.
          receivedAt: toDate(raw.internalDate) ?? parsed.date ?? new Date(),
          headers: {
            from: parsed.from?.text ?? header("from") ?? "",
            to: parsed.to
              ? Array.isArray(parsed.to)
                ? parsed.to.map((a) => a.text).join(", ")
                : parsed.to.text
              : null,
            subject: parsed.subject ?? null,
            messageId: parsed.messageId ?? null,
            inReplyTo: parsed.inReplyTo ?? null,
            references: Array.isArray(parsed.references)
              ? parsed.references
              : parsed.references
                ? [parsed.references]
                : [],
            contentType: header("content-type"),
            returnPath: header("return-path"),
            autoSubmitted: header("auto-submitted"),
            precedence: header("precedence"),
            listId: header("list-id"),
            listUnsubscribe: header("list-unsubscribe"),
            xAutoreply: header("x-autoreply"),
            xAutorespond: header("x-autorespond"),
            xAutoResponseSuppress: header("x-auto-response-suppress"),
            xFailedRecipients: header("x-failed-recipients"),
          },
          text: parsed.text ?? "",
          raw: (raw.source as Buffer).toString("utf8"),
        });
      }
    }

    return {
      messages,
      cursor: { uidvalidity: uidValidity, lastUid: highestUid },
      uidValidityChanged,
    };
  } finally {
    lock.release();
  }
}

/** Folders worth reading. Junk matters: real replies land there regularly. */
export const POLL_FOLDERS = ["INBOX", "Junk"];

export async function resolveFolders(client: ImapFlow): Promise<string[]> {
  const list = await client.list();
  const paths = new Set(list.map((box) => box.path));
  const junk = list.find((box) => box.specialUse === "\\Junk")?.path;

  const folders = ["INBOX"];
  if (junk) folders.push(junk);
  else if (paths.has("Junk")) folders.push("Junk");
  else if (paths.has("Spam")) folders.push("Spam");

  return folders;
}
