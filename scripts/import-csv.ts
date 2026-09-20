#!/usr/bin/env tsx
/**
 * Import a Google Sheets CSV export.
 *
 * Export one tab at a time: File > Download > Comma Separated Values.
 *
 * Usage:
 *   pnpm import:csv <file.csv>              # dry run, writes nothing
 *   pnpm import:csv <file.csv> --commit     # actually write
 *   pnpm import:csv <file.csv> --show-map   # print the detected mapping
 *
 * Safe to re-run on an expanded export of the same tab. Prospects are keyed on
 * domain, falling back to a slug of the company name, and contacts on email,
 * so an existing row is updated rather than duplicated. A blank cell never
 * clears a value that is already stored.
 */
import { basename, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { getDb } from "@/lib/db";
import { parseCsv } from "@/lib/import/parse-csv";
import { autoMap, validateMapping, type FieldTarget } from "@/lib/import/mapping";
import { commitImport, lastMappingFor } from "@/lib/import/commit";

function describeTarget(target: FieldTarget): string {
  switch (target.kind) {
    case "ignore":
      return "ignored";
    case "prospect":
      return `prospect.${target.field}`;
    case "contact":
      return `contact ${target.slot}.${target.field}`;
    case "prospect_custom":
      return `merge field {{${target.key}}}`;
    case "contact_custom":
      return `contact ${target.slot} field {{${target.key}}}`;
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const commit = args.includes("--commit");
  const showMap = args.includes("--show-map");

  if (!file) {
    console.error("Usage: pnpm import:csv <file.csv> [--commit] [--show-map]");
    process.exit(1);
  }

  const path = resolve(file);
  const sourceName = basename(path);
  const db = getDb();

  const parsed = parseCsv(readFileSync(path, "utf8"));
  for (const warning of parsed.warnings) console.warn(`  warning: ${warning}`);

  // Reuse the mapping from last time if this tab has been imported before, so
  // a hand-corrected mapping is not silently re-detected.
  const saved = lastMappingFor(db, sourceName);
  const mapping = saved ?? autoMap(parsed.headers);

  console.log(`\n${sourceName}: ${parsed.rows.length} rows, ${parsed.headers.length} columns`);
  console.log(saved ? "Reusing the mapping saved from the last import." : "Auto-detected mapping.");

  if (showMap || !saved) {
    console.log("");
    for (const header of parsed.headers) {
      console.log(`  ${header.padEnd(38)} -> ${describeTarget(mapping[header])}`);
    }
  }

  const problems = validateMapping(mapping);
  if (problems.length > 0) console.log("");
  for (const problem of problems) {
    console.log(`  ${problem.severity === "block" ? "BLOCKED" : "warning"}: ${problem.message}`);
  }
  if (problems.some((p) => p.severity === "block")) process.exit(1);

  const report = commitImport(db, parsed.rows, mapping, {
    dryRun: !commit,
    label: sourceName,
    sourceName,
  });

  console.log(`\n${commit ? "Imported" : "Dry run"}:`);
  console.log(`  prospects  ${report.prospectsCreated} created, ${report.prospectsUpdated} updated`);
  console.log(`  contacts   ${report.contactsCreated} created, ${report.contactsUpdated} updated`);
  console.log(`  skipped    ${report.skipped}`);
  console.log(`  on hold    ${report.onHold}`);
  console.log(`  suppressed ${report.suppressed}`);

  const flagged = report.perRow.filter((r) => r.notes.length > 0);
  if (flagged.length > 0) {
    console.log(`\nRows needing a look (${flagged.length}):`);
    for (const row of flagged.slice(0, 20)) {
      console.log(`  row ${row.rowNumber} ${row.company ?? "(no company)"}: ${row.notes.join(" ")}`);
    }
    if (flagged.length > 20) console.log(`  ... and ${flagged.length - 20} more`);
  }

  if (!commit) console.log("\nNothing was written. Re-run with --commit to apply.");
}

main();
