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
 *   pnpm mailbox warmup <label> --start 2026-09-23 --from 5 --step 2
 *   pnpm mailbox warmup <label> --off
 *   pnpm mailbox check-mx [--suppress] [--concurrency 8]
 *   pnpm mailbox rename <old-label> <new-label>
 *   pnpm mailbox unsuppress <domain-or-address>
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
import { loadLocalEnv } from "@/lib/env";
import { getDb } from "@/lib/db";
import { createMailbox, providerDefaults, renameMailbox, setMailboxStatus } from "@/lib/campaign";
import { keychainEntryExists, readKeychainPassword } from "@/lib/mail/keychain";
import { resolveAll, summarize, type DomainResult } from "@/lib/mail/mx";
import { removeSuppression } from "@/lib/suppressions";
import {
  describeWarmup,
  validateWarmup,
  warmupState,
  type WarmupFields,
} from "@/lib/schedule/warmup";

import { addSuppression } from "@/lib/suppressions";

loadLocalEnv();

interface MailboxRecord extends WarmupFields {
  id: number;
  label: string;
  from_name: string;
  from_email: string;
  provider: string;
  status: string;
  paused_reason: string | null;
  min_gap_seconds: number;
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
    console.log(`  ramp        ${describeWarmup(warmupState(row, new Date()))}`);
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

/* ------------------------------------------------------------------ warmup */

function warmup(args: string[]): void {
  const label = args[0];
  if (!label) {
    console.error(
      "Usage:\n" +
        "  pnpm mailbox warmup <label> --start 2026-09-23 [--from 5] [--step 2]\n" +
        "  pnpm mailbox warmup <label> --off"
    );
    process.exit(1);
  }

  const db = getDb();
  const row = db.prepare("select * from mailboxes where label = ?").get(label) as
    | MailboxRecord
    | undefined;

  if (!row) {
    console.error(`No mailbox called "${label}".`);
    process.exit(1);
  }

  if (args.includes("--off")) {
    db.prepare("update mailboxes set warmup_started_on = null where id = ?").run(row.id);
    console.log(`Ramp removed. "${label}" sends at its full ${row.daily_cap} a day.`);
    return;
  }

  const start = flag(args, "start") ?? new Date().toISOString().slice(0, 10);
  const from = Number(flag(args, "from") ?? row.warmup_start_cap);
  const step = Number(flag(args, "step") ?? row.warmup_daily_increment);

  try {
    validateWarmup({ startOn: start, startCap: from, dailyIncrement: step });
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }

  db.prepare(
    `update mailboxes
        set warmup_started_on = ?, warmup_start_cap = ?, warmup_daily_increment = ?
      where id = ?`
  ).run(start, from, step, row.id);

  const updated = { ...row, warmup_started_on: start, warmup_start_cap: from, warmup_daily_increment: step };
  console.log(`"${label}": ${describeWarmup(warmupState(updated, new Date()))}`);
}

/* ---------------------------------------------------------------- check-mx */

interface DomainCount {
  domain: string;
  contacts: number;
}

/** Every domain the contact list can actually send to, with its weight. */
function emailableDomains(): DomainCount[] {
  return getDb()
    .prepare(
      `select lower(substr(email, instr(email, '@') + 1)) as domain, count(*) as contacts
         from contacts
        where email is not null and instr(email, '@') > 1
        group by 1
        order by contacts desc, domain`
    )
    .all() as DomainCount[];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function percent(count: number, total: number): string {
  return total === 0 ? "0.0%" : `${((100 * count) / total).toFixed(1)}%`;
}

async function checkMx(args: string[]): Promise<void> {
  const domains = emailableDomains();
  if (domains.length === 0) {
    console.log("No emailable contacts yet.");
    return;
  }

  const concurrency = Number(flag(args, "concurrency") ?? 8);
  const suppress = args.includes("--suppress");

  process.stdout.write(`Resolving ${domains.length} domains`);
  let done = 0;
  const results = await resolveAll(domains, {
    concurrency,
    onResult: () => {
      done += 1;
      if (done % 25 === 0) process.stdout.write(".");
    },
  });
  process.stdout.write("\n\n");

  const summary = summarize(results);
  const contactsFor = (predicate: (result: DomainResult) => boolean) =>
    results.filter(predicate).reduce((total, result) => total + result.contacts, 0);

  const rows: [string, number, number][] = [
    ["Google Workspace / Gmail", summary.google, contactsFor((r) => r.verdict.kind === "hosted" && r.verdict.host === "google")],
    ["Microsoft 365 / Outlook", summary.microsoft, contactsFor((r) => r.verdict.kind === "hosted" && r.verdict.host === "microsoft")],
    ["Security gateway", summary.gateway, contactsFor((r) => r.verdict.kind === "hosted" && r.verdict.host === "gateway")],
    ["Other / self-hosted", summary.other, contactsFor((r) => r.verdict.kind === "hosted" && r.verdict.host === "other")],
    ["No MX, address only", summary.implicit, contactsFor((r) => r.verdict.kind === "implicit")],
    ["Does not exist", summary.dead, contactsFor((r) => r.verdict.kind === "dead")],
    ["Could not resolve", summary.unresolved, contactsFor((r) => r.verdict.kind === "unresolved")],
  ];

  console.log("Where your mail lands".padEnd(28) + "DOMAINS   SHARE   CONTACTS");
  for (const [label, count, contacts] of rows) {
    console.log(
      label.padEnd(28) +
        String(count).padStart(7) +
        percent(count, summary.total).padStart(8) +
        String(contacts).padStart(11)
    );
  }
  console.log("".padEnd(28) + String(summary.total).padStart(7) + "  total domains");

  const dead = results.filter((result) => result.verdict.kind === "dead");
  const implicit = results.filter((result) => result.verdict.kind === "implicit");
  const unresolved = results.filter((result) => result.verdict.kind === "unresolved");

  if (dead.length > 0) {
    console.log(`\nDoes not exist (NXDOMAIN). These will hard-bounce:`);
    for (const result of dead) console.log(`  ${result.domain}  (${plural(result.contacts, "contact")})`);
  }

  if (implicit.length > 0) {
    console.log(`\nNo MX record, but the domain resolves. Deliverable in principle`);
    console.log(`(RFC 5321 falls back to the address record) and usually parked.`);
    console.log(`Judge these by hand; nothing here is suppressed automatically:`);
    for (const result of implicit) {
      const address = result.verdict.kind === "implicit" ? result.verdict.address : "";
      console.log(`  ${result.domain}  -> ${address}  (${plural(result.contacts, "contact")})`);
    }
  }

  if (unresolved.length > 0) {
    console.log(`\nCould not resolve. This says nothing either way, so run it again`);
    console.log(`before drawing a conclusion:`);
    for (const result of unresolved) {
      const reason = result.verdict.kind === "unresolved" ? result.verdict.error : "";
      console.log(`  ${result.domain}  (${reason})`);
    }
  }

  if (!suppress) {
    if (dead.length > 0) {
      console.log(`\nRun again with --suppress to block the ${dead.length} that do not exist.`);
    }
    return;
  }

  if (dead.length === 0) {
    console.log("\nNothing to suppress.");
    return;
  }

  // Only the NXDOMAIN ones. A suppression retires a prospect, so it needs the
  // same certainty the tool demands before it sends.
  const today = new Date().toISOString().slice(0, 10);
  let added = 0;
  for (const result of dead) {
    if (addSuppression(getDb(), "domain", result.domain, `No such domain on ${today}`, "mailbox check-mx")) {
      added += 1;
    }
  }
  console.log(`\nSuppressed ${added} domain${added === 1 ? "" : "s"}. ${dead.length - added} already blocked.`);
}

const [command, ...args] = process.argv.slice(2);

/** Wrapped rather than run at the top level: tsx transpiles this to CJS. */
/**
 * Let a domain back in.
 *
 * `check-mx` suppresses on NXDOMAIN, and that reading can be wrong: a domain
 * mid-transfer or with a lapsed zone looks identical to one that no longer
 * exists. This is the way back.
 */
function unsuppress(args: string[]): void {
  const [value] = args;
  if (!value) {
    console.error("Usage: pnpm mailbox unsuppress <domain-or-address>");
    process.exit(1);
  }

  const db = getDb();
  const kind = value.includes("@") ? "email" : "domain";
  const existing = db
    .prepare("select reason, source from suppressions where kind = ? and value = ?")
    .get(kind, value.trim().toLowerCase()) as { reason: string | null; source: string | null } | undefined;

  if (!removeSuppression(db, kind, value)) {
    console.error(`"${value}" was not on the do-not-contact list.`);
    process.exit(1);
  }

  console.log(`"${value}" can be contacted again.`);
  if (existing?.reason) console.log(`  it was blocked for: ${existing.reason}`);
  if (existing?.source) console.log(`  added by: ${existing.source}`);
}

function rename(args: string[]): void {
  const [from, to] = args;
  if (!from || !to) {
    console.error("Usage: pnpm mailbox rename <old-label> <new-label>");
    process.exit(1);
  }

  const db = getDb();
  const row = db.prepare("select id from mailboxes where label = ?").get(from) as
    | { id: number }
    | undefined;
  if (!row) {
    console.error(`No mailbox labelled "${from}".`);
    process.exit(1);
  }

  renameMailbox(db, row.id, to);
  console.log(`"${from}" is now "${to}".`);
}

async function main(): Promise<void> {
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
    case "warmup":
      warmup(args);
      break;
    case "check-mx":
      await checkMx(args);
      break;
    case "rename":
      rename(args);
      break;
    case "unsuppress":
      unsuppress(args);
      break;
    case "pause":
      setStatus(args, "paused");
      break;
    case "resume":
      setStatus(args, "active");
      break;
    default:
      console.error(
        `Unknown command "${command}". Try list, add, check, warmup, check-mx, rename, unsuppress, pause or resume.`
      );
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
