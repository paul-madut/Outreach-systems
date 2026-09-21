/**
 * Template context building.
 *
 * A template resolves `{{field}}` against one flat string map. It is built by
 * layering contact fields over prospect fields over the prospect's `custom`
 * JSON, so an unmapped sheet column is usable in a template the moment it is
 * imported, without any schema change.
 */

/**
 * Sheet headers become template keys, so `Payment methods today` is written
 * `{{payment_methods_today}}`. Anything that is not a letter or digit collapses
 * to a single underscore.
 *
 * "Verbatim quote (the hook)" -> "verbatim_quote_the_hook"
 * "Subject (agent fills)"     -> "subject_agent_fills"
 */
export function toTemplateKey(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Keys the system sets itself. An imported column may not claim one of these,
 * because a sheet column called "Email" silently shadowing the contact's real
 * address is the kind of bug that is only visible in someone's inbox.
 */
export const RESERVED_KEYS = new Set([
  "email",
  "first_name",
  "last_name",
  "full_name",
  "title",
  "linkedin",
  "company",
  "domain",
  "vertical",
  "grade",
  "unsubscribe",
  "sender_name",
  "sender_email",
]);

export type TemplateContext = Record<string, string>;

export interface ContextSources {
  contact: {
    email: string;
    name?: string | null;
    title?: string | null;
    linkedin?: string | null;
    custom?: Record<string, unknown> | null;
  };
  prospect: {
    company?: string | null;
    domain?: string | null;
    vertical?: string | null;
    grade?: string | null;
    custom?: Record<string, unknown> | null;
  };
  sender: {
    name: string;
    email: string;
  };
}

/** Split a display name into first and last. Single-word names have no last. */
export function splitName(name: string | null | undefined): {
  first: string;
  last: string;
} {
  const clean = (name ?? "").trim().replace(/\s+/g, " ");
  if (!clean) return { first: "", last: "" };
  const parts = clean.split(" ");
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/**
 * First sentence of a longer value, exposed as `<field>_first`.
 *
 * The research sheets quote prospects verbatim, and the newer batches run to
 * 400 characters. Dropping one whole into an email pushes it past 150 words,
 * and a long cold email does not get read. Cutting at a sentence boundary and
 * marking the cut keeps the quote faithful while staying short, which matters
 * because the quote is the proof the email rests on.
 *
 * Returns null when there is nothing to shorten, so the field simply does not
 * appear rather than duplicating the original.
 */
export function firstSentence(value: string, minLength = 40): string | null {
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length <= minLength) return null;

  // Sentence end, but not on a decimal or a common abbreviation.
  const match = /^(.{40,}?[.!?])(?=\s+[A-Z(])/.exec(text);
  if (!match) return null;

  const sentence = match[1].trim();
  if (sentence.length >= text.length) return null;

  return `${sentence.replace(/[.!?]$/, "")}...`;
}

/**
 * A company name fit to say out loud, exposed as `{{company_short}}`.
 *
 * The research sheets carry names as records rather than as address: "Arete
 * Hemp LLC (wholesale)", "CertaPeptides (CERTALAB S.R.L.)", "E-CIGARETTES.CA
 * INC.". Writing "Is that the case for Exo Club (Exodus)?" reads like a
 * database row, which undoes the personal tone the rest of the email is for.
 *
 * The full value stays on `{{company}}`, because that is the identity.
 */
export function shortCompanyName(company: string): string {
  let name = company.trim();

  // A trailing parenthetical is a research note, not part of the name.
  name = name.replace(/\s*\([^)]*\)\s*$/, "").trim();

  // Legal suffixes, with or without punctuation.
  name = name
    .replace(/[,.]?\s+(inc|llc|ltd|limited|corp|corporation|co|gmbh|bv|srl|s\.r\.l|pty|plc)\.?$/i, "")
    .trim();

  // Shouted names read as shouting. Only touch ones that are entirely caps.
  const letters = name.replace(/[^a-zA-Z]/g, "");
  if (letters.length > 3 && letters === letters.toUpperCase()) {
    name = name
      .toLowerCase()
      .replace(/\b([a-z])/g, (char) => char.toUpperCase());
  }

  return name || company.trim();
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringify).filter(Boolean).join(", ");
  return "";
}

/**
 * Build the flat map a template renders against.
 *
 * Precedence, lowest to highest: prospect custom, contact custom, prospect
 * system fields, contact system fields. System fields win so that a stray
 * `custom.email` can never replace the address the message is actually sent to.
 */
export function buildContext(sources: ContextSources): TemplateContext {
  const context: TemplateContext = {};

  const addCustom = (custom: Record<string, unknown> | null | undefined) => {
    for (const [rawKey, rawValue] of Object.entries(custom ?? {})) {
      const key = toTemplateKey(rawKey);
      const value = stringify(rawValue);
      context[key] = value;

      const short = firstSentence(value);
      if (short) context[`${key}_first`] = short;
    }
  };

  addCustom(sources.prospect.custom);
  addCustom(sources.contact.custom);

  const { first, last } = splitName(sources.contact.name);

  const company = stringify(sources.prospect.company);

  Object.assign(context, {
    company,
    company_short: company ? shortCompanyName(company) : "",
    domain: stringify(sources.prospect.domain),
    vertical: stringify(sources.prospect.vertical),
    grade: stringify(sources.prospect.grade),
    email: sources.contact.email,
    full_name: stringify(sources.contact.name),
    first_name: first,
    last_name: last,
    title: stringify(sources.contact.title),
    linkedin: stringify(sources.contact.linkedin),
    sender_name: sources.sender.name,
    sender_email: sources.sender.email,
  });

  return context;
}
