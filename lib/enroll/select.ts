import type { Db } from "@/lib/db";

/**
 * Choosing which contacts to enrol.
 *
 * Segmenting on a plain column is not enough. "Their processor is down right
 * now" is a state that lives in free-text research, not in a field, so the
 * selector searches across the vertical and every imported column at once.
 *
 * `exclude` matters as much as `match`. Searching for "unavailable" finds the
 * stores that are down and also the one announcing it is "processing payments
 * again", which is the opposite situation. Both patterns are shown back with
 * the text that matched so the choice can be checked before anything is sent.
 */

export interface ContactFilter {
  /** Case-insensitive regular expression over the research text. */
  match?: string;
  /** Case-insensitive regular expression that rejects a match. */
  exclude?: string;
  grade?: string;
  limit?: number;
}

export interface SelectedContact {
  contactId: number;
  prospectId: number;
  company: string;
  email: string;
  grade: string | null;
  /** The research text around the match, for eyeballing before enrolling. */
  excerpt: string;
}

export interface SelectionResult {
  contacts: SelectedContact[];
  /** How many had an email and passed the grade filter, before matching. */
  considered: number;
  /** An invalid regular expression, reported rather than thrown. */
  error: string | null;
}

function compile(pattern: string | undefined): RegExp | null {
  if (!pattern?.trim()) return null;
  return new RegExp(pattern, "i");
}

/** The text a filter searches: the vertical plus every imported column. */
function researchText(vertical: string | null, custom: string): string {
  let values: unknown[];
  try {
    values = Object.values(JSON.parse(custom || "{}") as Record<string, unknown>);
  } catch {
    values = [];
  }
  return [vertical, ...values]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" | ");
}

export function selectContacts(db: Db, filter: ContactFilter = {}): SelectionResult {
  let include: RegExp | null;
  let reject: RegExp | null;

  try {
    include = compile(filter.match);
    reject = compile(filter.exclude);
  } catch (error) {
    return { contacts: [], considered: 0, error: (error as Error).message };
  }

  const rows = db
    .prepare(
      `select c.id, c.prospect_id, c.email, p.company, p.grade, p.vertical, p.custom
         from contacts c join prospects p on p.id = c.prospect_id
        where c.channel = 'email' and c.email is not null
          and (? is null or p.grade = ?)
        order by case p.grade when 'A' then 0 when 'B' then 1 when 'C' then 2 else 3 end,
                 p.company, c.id`
    )
    .all(filter.grade ?? null, filter.grade ?? null) as {
    id: number;
    prospect_id: number;
    email: string;
    company: string;
    grade: string | null;
    vertical: string | null;
    custom: string;
  }[];

  const contacts: SelectedContact[] = [];

  for (const row of rows) {
    const research = researchText(row.vertical, row.custom);

    if (include && !include.test(research)) continue;
    if (reject && reject.test(research)) continue;
    if (filter.limit && contacts.length >= filter.limit) break;

    const hit = include?.exec(research);
    const at = hit?.index ?? 0;

    contacts.push({
      contactId: row.id,
      prospectId: row.prospect_id,
      company: row.company,
      email: row.email,
      grade: row.grade,
      excerpt: research
        .slice(Math.max(0, at - 30), at + 70)
        .replace(/\s+/g, " ")
        .trim(),
    });
  }

  return { contacts, considered: rows.length, error: null };
}
