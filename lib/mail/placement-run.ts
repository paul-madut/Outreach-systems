import type { Database } from "better-sqlite3";
import type { ImapFlow } from "imapflow";
import type { MailboxRow } from "@/lib/campaign";
import { readKeychainPassword } from "./keychain";
import { connect } from "./imap";
import { createTransport, sendMessage } from "./smtp";
import {
  classifyFolder,
  parseAuthResults,
  summarise,
  type AuthVerdict,
  type Placement,
  type PlacementReport,
} from "./placement";

/**
 * Running a placement test.
 *
 * The pure half lives in `placement.ts`. This half does the three things that
 * touch the world: send a real message from a sending mailbox, wait, and read
 * the seed mailboxes over IMAP to see where it landed.
 *
 * Two deliberate choices about the test message:
 *
 * It is a real template rendered against a real contact, not a message written
 * for the test. Filtering is a content decision, so a message that says
 * "placement test" measures nothing about the mail that actually goes out.
 *
 * Nothing is added to it, not even a marker in the subject. The message is
 * found again by its Message-ID, which every provider preserves and IMAP can
 * search on, so what the seed receives is byte-identical in shape to what a
 * prospect receives.
 */

export interface SeedRow {
  id: number;
  label: string;
  email: string;
  provider: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  keychain_service: string;
  keychain_account: string;
  status: string;
}

export function listSeeds(db: Database, includePaused = false): SeedRow[] {
  const where = includePaused ? "" : "where status = 'active'";
  return db.prepare(`select * from seed_inboxes ${where} order by id`).all() as SeedRow[];
}

export interface SeedInput {
  label: string;
  email: string;
  provider?: string;
  imapHost: string;
  imapPort?: number;
  imapUser?: string;
  keychainService: string;
  keychainAccount?: string;
}

export function addSeed(db: Database, input: SeedInput): number {
  const info = db
    .prepare(
      `insert into seed_inboxes
         (label, email, provider, imap_host, imap_port, imap_user,
          keychain_service, keychain_account)
       values (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.label,
      input.email,
      input.provider ?? "custom",
      input.imapHost,
      input.imapPort ?? 993,
      input.imapUser ?? input.email,
      input.keychainService,
      input.keychainAccount ?? input.email
    );

  return Number(info.lastInsertRowid);
}

/** A short human-facing identifier for one test run. Not put in the message. */
function makeToken(now: Date): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

function messageIdFor(mailbox: MailboxRow, token: string, seedId: number): string {
  const domain = mailbox.from_email.split("@")[1] ?? "localhost";
  return `<placement.${token}.${seedId}@${domain}>`;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface FoundMessage {
  folder: string;
  specialUse: string | null;
  headers: string;
  receivedAt: Date | null;
}

/** INBOX plus whatever this provider calls Junk. Nothing else is worth opening. */
async function placementFolders(
  client: ImapFlow
): Promise<Array<{ path: string; specialUse: string | null }>> {
  const list = await client.list();
  const junk = list.find((box) => box.specialUse === "\\Junk");
  const fallback = list.find((box) => box.path === "Junk" || box.path === "Spam");

  const folders = [{ path: "INBOX", specialUse: "\\Inbox" as string | null }];
  const spam = junk ?? fallback;
  if (spam) folders.push({ path: spam.path, specialUse: spam.specialUse ?? null });

  return folders;
}

/**
 * Look for one Message-ID across a seed's folders.
 *
 * Opened read-only throughout. A placement test that marked its own probe as
 * read would be changing the mailbox it is measuring.
 */
async function findMessage(client: ImapFlow, messageId: string): Promise<FoundMessage | null> {
  for (const folder of await placementFolders(client)) {
    const lock = await client.getMailboxLock(folder.path, { readOnly: true });
    try {
      const uids = (await client.search({ header: { "message-id": messageId } }, { uid: true })) || [];
      if (uids.length === 0) continue;

      for await (const message of client.fetch(
        uids.slice(-1),
        { uid: true, headers: true, internalDate: true },
        { uid: true }
      )) {
        return {
          folder: folder.path,
          specialUse: folder.specialUse,
          headers: message.headers?.toString("utf8") ?? "",
          receivedAt: toDate(message.internalDate),
        };
      }
    } finally {
      lock.release();
    }
  }

  return null;
}

export interface PlacementTestOptions {
  mailboxId: number;
  /** Subject and body to send. Render these from a real template first. */
  subject: string;
  body: string;
  onProgress?: (line: string) => void;
}

/**
 * Send the probe, and record one pending result per seed.
 *
 * Separate from checking on purpose. Sending takes a second or two; a message
 * can take minutes to show up. Keeping them apart means the web app can send
 * from a request without holding it open, and check again whenever it likes.
 */
export async function sendPlacementTest(
  db: Database,
  options: PlacementTestOptions
): Promise<number> {
  const log = options.onProgress ?? (() => {});

  const mailbox = db
    .prepare("select * from mailboxes where id = ?")
    .get(options.mailboxId) as MailboxRow | undefined;
  if (!mailbox) throw new Error(`No mailbox with id ${options.mailboxId}`);

  const seeds = listSeeds(db);
  if (seeds.length === 0) {
    throw new Error("No active seed inboxes. Add one with `pnpm placement seed-add`.");
  }

  const token = makeToken(new Date());
  const testId = Number(
    db
      .prepare(
        `insert into placement_tests (mailbox_id, token, subject, status)
         values (?, ?, ?, 'pending')`
      )
      .run(mailbox.id, token, options.subject).lastInsertRowid
  );

  const password = readKeychainPassword(mailbox.keychain_service, mailbox.keychain_account);
  const transport = createTransport(mailbox, password);

  try {
    for (const seed of seeds) {
      const messageId = messageIdFor(mailbox, token, seed.id);
      const at = new Date();
      let sent = false;

      try {
        await sendMessage(transport, mailbox, {
          to: seed.email,
          subject: options.subject,
          body: options.body,
          messageId,
        });
        sent = true;
        log(`sent to ${seed.label} <${seed.email}>`);
      } catch (error) {
        // One seed refusing the message is itself a placement result: the
        // hardest possible rejection. Recorded, and the run continues.
        log(`send to ${seed.label} failed: ${(error as Error).message}`);
      }

      db.prepare(
        `insert into placement_results (test_id, seed_id, message_id, sent_at, placement)
         values (?, ?, ?, ?, ?)`
      ).run(testId, seed.id, messageId, sent ? at.toISOString() : null, sent ? null : "missing");
    }
  } finally {
    transport.close();
  }

  db.prepare("update placement_tests set status = 'sent', sent_at = ? where id = ?").run(
    new Date().toISOString(),
    testId
  );

  return testId;
}

interface PendingResult {
  seed_id: number;
  message_id: string;
  sent_at: string;
}

/**
 * Look once for every result that has not been found yet.
 *
 * Idempotent, so calling it on a finished test does nothing and calling it
 * repeatedly is how a test completes. Returns how many were still outstanding
 * afterwards.
 */
export async function checkPlacementTest(
  db: Database,
  testId: number,
  onProgress?: (line: string) => void
): Promise<number> {
  const log = onProgress ?? (() => {});

  const pending = db
    .prepare(
      `select seed_id, message_id, sent_at from placement_results
        where test_id = ? and placement is null and sent_at is not null`
    )
    .all(testId) as PendingResult[];

  const seedsById = new Map(listSeeds(db, true).map((seed) => [seed.id, seed]));

  for (const row of pending) {
    const seed = seedsById.get(row.seed_id);
    if (!seed) continue;

    let client: ImapFlow | null = null;
    try {
      client = await connect(seed, readSeedPassword(seed));
      const found = await findMessage(client, row.message_id);
      if (!found) continue;

      const auth = parseAuthResults(found.headers);
      const placement = classifyFolder(found.folder, found.specialUse);
      const sent = new Date(row.sent_at);
      const deliverySeconds = found.receivedAt
        ? Math.max(0, Math.round((found.receivedAt.getTime() - sent.getTime()) / 1000))
        : null;

      db.prepare(
        `update placement_results
            set placement = ?, folder = ?, auth_present = ?, spf = ?, dkim = ?,
                dmarc = ?, verifier = ?, delivery_seconds = ?, checked_at = ?
          where test_id = ? and seed_id = ?`
      ).run(
        placement,
        found.folder,
        auth.present ? 1 : 0,
        auth.spf,
        auth.dkim,
        auth.dmarc,
        auth.verifier,
        deliverySeconds,
        new Date().toISOString(),
        testId,
        row.seed_id
      );

      log(`${seed.label}: ${placement} (${found.folder})`);
    } catch (error) {
      log(`check ${seed.label} failed: ${(error as Error).message}`);
    } finally {
      await client?.logout().catch(() => {});
    }
  }

  return (
    db
      .prepare(
        "select count(*) as n from placement_results where test_id = ? and placement is null"
      )
      .get(testId) as { n: number }
  ).n;
}

/**
 * Give up on anything that never arrived.
 *
 * Silent discard is what a bad sending reputation looks like, so a message
 * that never showed up is a finding rather than an absence, and it is written
 * down as one.
 */
export function closePlacementTest(db: Database, testId: number): void {
  db.prepare(
    `update placement_results set placement = 'missing', checked_at = ?
      where test_id = ? and placement is null`
  ).run(new Date().toISOString(), testId);

  db.prepare("update placement_tests set status = 'complete' where id = ?").run(testId);
}

interface StoredResult {
  label: string;
  email: string;
  placement: Placement | null;
  folder: string | null;
  auth_present: number | null;
  spf: AuthVerdict | null;
  dkim: AuthVerdict | null;
  dmarc: AuthVerdict | null;
  verifier: string | null;
  delivery_seconds: number | null;
}

/**
 * How many placement tests this mailbox has run.
 *
 * Used to rotate which contact the next test renders against, so two runs
 * never send the same message to the same seed. See `buildTestMessage`.
 */
export function testCount(db: Database, mailboxId: number): number {
  return (
    db
      .prepare("select count(*) as n from placement_tests where mailbox_id = ?")
      .get(mailboxId) as { n: number }
  ).n;
}

/** The most recent test for a mailbox, so a page can show the last answer. */
export function latestTestId(db: Database, mailboxId: number): number | null {
  const row = db
    .prepare("select id from placement_tests where mailbox_id = ? order by id desc limit 1")
    .get(mailboxId) as { id: number } | undefined;
  return row?.id ?? null;
}

/** Build the report from what is on disk, so a page can render it any time. */
export function placementReport(db: Database, testId: number): PlacementReport {
  const test = db
    .prepare(
      `select t.subject, m.label, m.from_email
         from placement_tests t join mailboxes m on m.id = t.mailbox_id
        where t.id = ?`
    )
    .get(testId) as { subject: string; label: string; from_email: string } | undefined;
  if (!test) throw new Error(`No placement test with id ${testId}`);

  const rows = db
    .prepare(
      `select s.label, s.email, r.placement, r.folder, r.auth_present,
              r.spf, r.dkim, r.dmarc, r.verifier, r.delivery_seconds
         from placement_results r join seed_inboxes s on s.id = r.seed_id
        where r.test_id = ? order by s.id`
    )
    .all(testId) as StoredResult[];

  return summarise(
    test.label,
    test.from_email,
    rows.map((row) => ({
      seedLabel: row.label,
      seedEmail: row.email,
      // A result still in flight has not placed anywhere yet. Counting it as
      // missing before the window closes would read as a delivery failure.
      placement: row.placement ?? "missing",
      folder: row.folder,
      auth:
        row.auth_present === null
          ? null
          : {
              present: row.auth_present === 1,
              spf: row.spf ?? "unknown",
              dkim: row.dkim ?? "unknown",
              dmarc: row.dmarc ?? "unknown",
              verifier: row.verifier,
            },
      deliverySeconds: row.delivery_seconds,
    }))
  );
}

export interface RunOptions extends PlacementTestOptions {
  /** How long to keep checking the seeds before calling a message missing. */
  waitSeconds?: number;
  /** Gap between checks. */
  pollSeconds?: number;
}

/** Send, then wait for every seed or for the window to close. */
export async function runPlacementTest(
  db: Database,
  options: RunOptions
): Promise<PlacementReport> {
  const waitMs = (options.waitSeconds ?? 180) * 1000;
  const pollMs = (options.pollSeconds ?? 20) * 1000;

  const testId = await sendPlacementTest(db, options);
  const deadline = Date.now() + waitMs;

  let outstanding = 1;
  while (outstanding > 0 && Date.now() < deadline) {
    await sleep(pollMs);
    outstanding = await checkPlacementTest(db, testId, options.onProgress);
  }

  closePlacementTest(db, testId);
  return placementReport(db, testId);
}

function readSeedPassword(seed: SeedRow): string {
  return readKeychainPassword(seed.keychain_service, seed.keychain_account);
}
