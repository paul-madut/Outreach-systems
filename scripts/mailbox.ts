#!/usr/bin/env tsx
/**
 * Add and inspect mailboxes.
 *
 * Usage:
 *   pnpm mailbox list
 *   pnpm mailbox add --label payments --provider icloud \
 *       --from "Paul Madut <paul.madut@icloud.com>" \
 *       --keychain-service icloud-smtp-outreach
 *   pnpm mailbox check
 *   pnpm mailbox pause <label> "reason"
 *   pnpm mailbox resume <label>
 *
 * The password itself is never passed here. Store it in the Keychain first:
 *
 *   security add-generic-password -s icloud-smtp-outreach \
 *     -a paul.madut@icloud.com -w
 *
 * Both iCloud and Gmail need an app-specific password, which means two-factor
 * has to be on for the account first.
 */
import { getDb } from "@/lib/db";
import { createMailbox, providerDefaults, setMailboxStatus } from "@/lib/campaign";
import { keychainEntryExists, readKeychainPassword } from "@/lib/mail/keychain";

interface MailboxRecord {
  id: number;
  label: string;
  from_name: string;
  from_email: string;
  provider: string;
  status: string;
  paused_reason: string | null;
  daily_cap: number;
  min_gap_seconds: number;
  timezone: string;
  keychain_service: string;
  keychain_account: string;
  append_to_sent: number;
  smtp_host: string;
  imap_host: string;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

/** "Paul Madut <paul@example.com>" or a bare address. */
function parseFrom(value: string): { name: string; email: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  if (match) return { name: match[1] || match[2], email: match[2].toLowerCase() };
  return { name: value.trim(), email: value.trim().toLowerCase() };
}

function list(): void {
  const rows = getDb().prepare("select * from mailboxes order by id").all() as MailboxRecord[];

  if (rows.length === 0) {
    console.log("No mailboxes yet. Add one with: pnpm mailbox add --help");
    return;
  }

  for (const row of rows) {
    const password = keychainEntryExists(row.keychain_service, row.keychain_account);
    console.log(`\n${row.label}  (${row.status})`);
    console.log(`  from        ${row.from_name} <${row.from_email}>`);
    console.log(`  provider    ${row.provider}  smtp ${row.smtp_host}  imap ${row.imap_host}`);
    console.log(`  pacing      ${row.daily_cap}/day, ${row.min_gap_seconds}s gap, ${row.timezone}`);
    console.log(`  sent copy   ${row.append_to_sent ? "filed by this tool" : "filed by the provider"}`);
    console.log(`  keychain    ${password ? "found" : "MISSING"}  (${row.keychain_service} / ${row.keychain_account})`);
    if (row.paused_reason) console.log(`  paused      ${row.paused_reason}`);
  }
}

function add(args: string[]): void {
  const label = flag(args, "label");
  const from = flag(args, "from");
  const provider = (flag(args, "provider") ?? "icloud") as "icloud" | "gmail" | "custom";

  if (!label || !from) {
    console.error('Need --label and --from "Name <address>".');
    process.exit(1);
  }
  if (!["icloud", "gmail", "custom"].includes(provider)) {
    console.error("--provider must be icloud, gmail or custom.");
    process.exit(1);
  }

  const { name, email } = parseFrom(from);
  const keychainService = flag(args, "keychain-service") ?? `${provider}-smtp-outreach`;
  const keychainAccount = flag(args, "keychain-account") ?? email;

  if (!keychainEntryExists(keychainService, keychainAccount)) {
    console.error(
      `\nNo Keychain entry for service "${keychainService}", account "${keychainAccount}".\n` +
        `Store the app-specific password first:\n\n` +
        `  security add-generic-password -s ${keychainService} -a ${keychainAccount} -w\n`
    );
    process.exit(1);
  }

  const defaults = providerDefaults(provider);
  const id = createMailbox(getDb(), {
    label,
    fromName: name,
    fromEmail: email,
    provider,
    keychainService,
    keychainAccount,
    timezone: flag(args, "timezone") ?? "America/Toronto",
    dailyCap: Number(flag(args, "daily-cap") ?? 20),
    minGapSeconds: Number(flag(args, "min-gap") ?? 120),
    gapJitterSeconds: Number(flag(args, "jitter") ?? 60),
    smtpHost: flag(args, "smtp-host"),
    imapHost: flag(args, "imap-host"),
  });

  console.log(`Added mailbox "${label}" (id ${id}).`);
  console.log(
    defaults.appendToSent
      ? "This tool will file a copy in Sent, because the provider does not."
      : "The provider files its own Sent copy, so this tool will not add a second."
  );
}

/** Prove the credentials actually work, without sending anything. */
function check(): void {
  const rows = getDb().prepare("select * from mailboxes order by id").all() as MailboxRecord[];

  for (const row of rows) {
    process.stdout.write(`${row.label}: `);
    try {
      const password = readKeychainPassword(row.keychain_service, row.keychain_account);
      console.log(`keychain ok (${password.length} characters)`);
    } catch (error) {
      console.log(`FAILED - ${(error as Error).message.split("\n")[0]}`);
    }
  }

  if (rows.length === 0) console.log("No mailboxes configured.");
}

function setStatus(args: string[], status: "active" | "paused"): void {
  const label = args[0];
  if (!label) {
    console.error(`Usage: pnpm mailbox ${status === "paused" ? "pause" : "resume"} <label> [reason]`);
    process.exit(1);
  }

  const row = getDb().prepare("select id from mailboxes where label = ?").get(label) as
    | { id: number }
    | undefined;

  if (!row) {
    console.error(`No mailbox called "${label}".`);
    process.exit(1);
  }

  setMailboxStatus(getDb(), row.id, status, status === "paused" ? args[1] ?? "Paused by hand" : null);
  console.log(`Mailbox "${label}" is now ${status}.`);
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "list":
  case undefined:
    list();
    break;
  case "add":
    add(args);
    break;
  case "check":
    check();
    break;
  case "pause":
    setStatus(args, "paused");
    break;
  case "resume":
    setStatus(args, "active");
    break;
  default:
    console.error(`Unknown command "${command}". Try list, add, check, pause or resume.`);
    process.exit(1);
}
