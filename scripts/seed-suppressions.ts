#!/usr/bin/env tsx
/**
 * Load a newline-delimited domain list into the suppression table.
 *
 * Usage:
 *   pnpm seed:suppressions <file.txt> [--reason "..."]
 *
 * Defaults to Paul's existing list at
 * ~/Desktop/peptide-outreach/research/exclude_master.txt (342 domains).
 *
 * Idempotent. Consumer mailbox domains are refused and reported rather than
 * applied: that list contains gmail.com and outlook.com, and honouring those
 * as domain blocks would make every prospect whose only published contact is
 * a free address permanently unreachable.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { getDb } from "@/lib/db";
import { seedDomainSuppressions } from "@/lib/suppressions";

const DEFAULT_LIST = resolve(
  homedir(),
  "Desktop/peptide-outreach/research/exclude_master.txt"
);

function main(): void {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--")) ?? DEFAULT_LIST;
  const reasonIndex = args.indexOf("--reason");
  const reason = reasonIndex >= 0 ? args[reasonIndex + 1] : "Imported exclude list";

  const path = resolve(file);
  const text = readFileSync(path, "utf8");

  const report = seedDomainSuppressions(getDb(), text, path, reason);

  console.log(`\n${path}`);
  console.log(`  parsed          ${report.parsed}`);
  console.log(`  added           ${report.added}`);
  console.log(`  already present ${report.alreadyPresent}`);

  if (report.refused.length > 0) {
    console.log(`\n  Refused ${report.refused.length} consumer mailbox domains:`);
    for (const domain of report.refused) console.log(`    ${domain}`);
    console.log(
      "\n  Blocking one of these would suppress every address at that provider.\n" +
        "  If specific addresses there should be excluded, add them individually."
    );
  }
}

main();
