#!/usr/bin/env tsx
/**
 * Placement testing: find out where this mailbox's real mail actually lands.
 *
 * Usage:
 *   pnpm placement seeds
 *   pnpm placement seed-add --label icloud-seed --email paul.madut@icloud.com \
 *       --provider icloud --keychain-service icloud-smtp-outreach
 *   pnpm placement test --mailbox payments --campaign peptides [--step 1]
 *   pnpm placement test --mailbox payments --campaign peptides --dry-run
 *   pnpm placement history [--mailbox payments]
 *
 * A seed is a mailbox Paul owns that exists only to receive. It needs an IMAP
 * password in the Keychain, the same way a sending mailbox does:
 *
 *   security add-generic-password -s icloud-smtp-outreach \
 *     -a paul.madut@icloud.com -w
 *
 * The test sends a real template rendered against a real contact, because
 * filtering is a content decision and a message written for a test measures
 * nothing about the mail that actually goes out.
 */
import { loadLocalEnv } from "@/lib/env";
import { getDb } from "@/lib/db";
import { providerDefaults, type MailboxRow } from "@/lib/campaign";
import { keychainEntryExists } from "@/lib/mail/keychain";
import { warnings } from "@/lib/mail/placement";
import { buildTestMessage } from "@/lib/mail/placement-message";
import { addSeed, listSeeds, runPlacementTest, testCount } from "@/lib/mail/placement-run";

loadLocalEnv();

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function required(args: string[], name: string): string {
  const value = flag(args, name);
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function seeds(): void {
  const db = getDb();
  const rows = listSeeds(db, true);

  if (rows.length === 0) {
    console.log("No seed inboxes yet. Add one with `pnpm placement seed-add`.");
    return;
  }

  for (const seed of rows) {
    const found = keychainEntryExists(seed.keychain_service, seed.keychain_account);
    console.log(`\n${seed.label}  (${seed.status})`);
    console.log(`  address   ${seed.email}`);
    console.log(`  imap      ${seed.imap_host}:${seed.imap_port} as ${seed.imap_user}`);
    console.log(`  keychain  ${found ? "found" : "MISSING"}  (${seed.keychain_service})`);
  }
  console.log();
}

function seedAdd(args: string[]): void {
  const db = getDb();
  const provider = flag(args, "provider") ?? "custom";
  const known = provider === "icloud" || provider === "gmail";
  const defaults = known ? providerDefaults(provider) : null;

  const imapHost = flag(args, "imap-host") ?? defaults?.imapHost;
  if (!imapHost) throw new Error("A custom seed needs --imap-host.");

  const email = required(args, "email");
  const id = addSeed(db, {
    label: required(args, "label"),
    email,
    provider,
    imapHost,
    imapPort: Number(flag(args, "imap-port") ?? defaults?.imapPort ?? 993),
    imapUser: flag(args, "imap-user") ?? email,
    keychainService: required(args, "keychain-service"),
    keychainAccount: flag(args, "keychain-account") ?? email,
  });

  console.log(`Added seed inbox (id ${id}).`);
}

async function test(args: string[]): Promise<void> {
  const db = getDb();
  const label = required(args, "mailbox");
  const mailbox = db
    .prepare("select * from mailboxes where label = ?")
    .get(label) as MailboxRow | undefined;
  if (!mailbox) throw new Error(`No mailbox labelled "${label}".`);

  const campaignName = required(args, "campaign");
  const campaign = db
    .prepare("select id from campaigns where name = ?")
    .get(campaignName) as { id: number } | undefined;
  if (!campaign) throw new Error(`No campaign named "${campaignName}".`);

  const message = buildTestMessage(
    db,
    campaign.id,
    Number(flag(args, "step") ?? 1),
    mailbox,
    testCount(db, mailbox.id)
  );

  console.log(`Sending as ${mailbox.from_name} <${mailbox.from_email}>`);
  console.log(`Rendered against ${message.renderedFor}`);
  console.log(`Subject: ${message.subject}\n`);
  console.log(message.body.replace(/^/gm, "  "));
  console.log();

  // Seeing the exact message first is the point of this flag. A placement test
  // is only worth running on mail Paul would actually send.
  if (args.includes("--dry-run")) {
    const targets = listSeeds(getDb());
    console.log(`Dry run. Nothing sent. ${targets.length} seed(s) would receive this.`);
    return;
  }

  const report = await runPlacementTest(db, {
    mailboxId: mailbox.id,
    subject: message.subject,
    body: message.body,
    waitSeconds: Number(flag(args, "wait") ?? 180),
    pollSeconds: Number(flag(args, "poll") ?? 20),
    onProgress: (line) => console.log(`  ${line}`),
  });

  console.log();
  for (const outcome of report.outcomes) {
    const auth =
      outcome.auth && outcome.auth.present
        ? `spf ${outcome.auth.spf}, dkim ${outcome.auth.dkim}, dmarc ${outcome.auth.dmarc}` +
          (outcome.auth.verifier ? ` (per ${outcome.auth.verifier})` : "")
        : "not authenticated by any receiver";
    const timing = outcome.deliverySeconds === null ? "" : ` in ${outcome.deliverySeconds}s`;
    const folder =
      outcome.folder && outcome.folder.toLowerCase() !== outcome.placement
        ? `${outcome.folder}  |  `
        : "";
    console.log(`${outcome.seedLabel.padEnd(16)} ${outcome.placement.toUpperCase()}${timing}`);
    console.log(`  ${folder}${auth}`);
  }

  const rate = report.inboxRate === null ? "n/a" : `${Math.round(report.inboxRate * 100)}%`;
  console.log(`\ninbox ${report.inbox}  spam ${report.spam}  missing ${report.missing}  (${rate})`);

  for (const warning of warnings(report)) console.log(`\n${warning}`);
  console.log();
}

function history(args: string[]): void {
  const db = getDb();
  const label = flag(args, "mailbox");

  const rows = db
    .prepare(
      `select t.token, t.sent_at, m.label as mailbox, m.timezone, t.subject,
              coalesce(sum(r.placement = 'inbox'), 0)   as inbox,
              coalesce(sum(r.placement = 'spam'), 0)    as spam,
              coalesce(sum(r.placement = 'missing'), 0) as missing
         from placement_tests t
         join mailboxes m on m.id = t.mailbox_id
         left join placement_results r on r.test_id = t.id
        where (? is null or m.label = ?)
        group by t.id
        order by t.id desc
        limit 20`
    )
    .all(label ?? null, label ?? null) as Array<Record<string, unknown>>;

  if (rows.length === 0) {
    console.log("No placement tests yet.");
    return;
  }

  for (const row of rows) {
    const when = row.sent_at
      ? new Date(String(row.sent_at)).toLocaleString("en-CA", {
          timeZone: String(row.timezone),
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      : "not sent";
    console.log(
      `${when}  ${String(row.mailbox).padEnd(12)} inbox ${row.inbox}  spam ${row.spam}  missing ${row.missing}`
    );
    console.log(`  ${row.subject}`);
  }
}

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<void> {
  switch (command) {
    case "seeds":
      seeds();
      break;
    case "seed-add":
      seedAdd(args);
      break;
    case "test":
      await test(args);
      break;
    case "history":
      history(args);
      break;
    default:
      console.error(`Unknown command "${command}". Try seeds, seed-add, test or history.`);
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
