import Papa from "papaparse";
import { unescapeMarkdown } from "./normalize";

/**
 * CSV parsing.
 *
 * A real parser rather than a split on commas, because the draft Body column
 * holds multi-line text with embedded commas and quotes. Google Sheets exports
 * one CSV per tab, so a file here is always a single table.
 */

export interface ParsedCsv {
  /** Header names in sheet order, with blanks dropped. */
  headers: string[];
  /** One record per data row, keyed by header. */
  rows: Record<string, string>[];
  /** Parse problems worth showing, already deduped by type. */
  warnings: string[];
}

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvParseError";
  }
}

/**
 * Google Sheets sometimes exports repeated or blank header cells. Blanks are
 * dropped, and a repeat gets a numeric suffix so the two columns stay
 * distinguishable in the mapping UI rather than one silently overwriting the
 * other.
 */
function dedupeHeaders(raw: string[]): { headers: string[]; warnings: string[] } {
  const seen = new Map<string, number>();
  const headers: string[] = [];
  const warnings: string[] = [];

  for (const cell of raw) {
    const name = cell.trim();
    if (!name) {
      headers.push("");
      continue;
    }

    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);

    if (count === 0) {
      headers.push(name);
    } else {
      headers.push(`${name} (${count + 1})`);
      warnings.push(`Duplicate column "${name}" kept as "${name} (${count + 1})".`);
    }
  }

  return { headers, warnings };
}

export function parseCsv(text: string): ParsedCsv {
  // Strip a UTF-8 BOM. Sheets adds one, and it would otherwise become part of
  // the first header name and break every mapping rule that matches on it.
  const content = text.replace(/^\uFEFF/, "");

  const result = Papa.parse<string[]>(content, {
    header: false,
    skipEmptyLines: "greedy",
    // Keep everything as text. Type inference would turn "Meets $70k" values
    // and phone numbers into numbers, and strip leading zeros.
    dynamicTyping: false,
  });

  if (result.data.length === 0) {
    throw new CsvParseError("The file has no rows.");
  }

  const { headers, warnings } = dedupeHeaders(result.data[0]);

  if (headers.every((h) => !h)) {
    throw new CsvParseError("The first row is empty, so there are no column names.");
  }

  // Papa reports one error per bad row; collapse to one message per kind.
  const seenErrors = new Set<string>();
  for (const error of result.errors) {
    if (!seenErrors.has(error.code)) {
      seenErrors.add(error.code);
      warnings.push(`Row ${(error.row ?? 0) + 1}: ${error.message}`);
    }
  }

  const rows: Record<string, string>[] = [];

  for (const cells of result.data.slice(1)) {
    const row: Record<string, string> = {};
    let hasValue = false;

    headers.forEach((header, index) => {
      if (!header) return;
      const value = unescapeMarkdown((cells[index] ?? "").trim());
      row[header] = value;
      if (value) hasValue = true;
    });

    // A row of nothing but commas is padding, not a prospect.
    if (hasValue) rows.push(row);
  }

  return { headers: headers.filter(Boolean), rows, warnings };
}
