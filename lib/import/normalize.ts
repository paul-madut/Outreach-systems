/**
 * Normalising imported sheet values.
 *
 * The research sheets were written by hand and by agents over several months,
 * so the same concept arrives in several shapes. Every rule here exists because
 * of a value actually present in Paul's data, not as defensive programming.
 */

export type Channel = "email" | "contact_form" | "phone" | "none";

/**
 * Undo markdown escaping.
 *
 * Values that travel through a markdown-shaped export come back with
 * backslashes in front of punctuation: `\[...\]`, `\&`, `\#`. A verbatim
 * quote carrying `\[...\]` goes out in an email exactly like that, which
 * looks like a bug to the person reading it. A backslash before punctuation
 * is never meaningful in prose, so removing it is safe.
 */
export function unescapeMarkdown(value: string): string {
  return value.replace(/\\([[\]\\&#_*~`<>|{}()+.!-])/g, "$1");
}

export interface ParsedChannel {
  channel: Channel;
  /** The payload that was stuffed into the channel cell, e.g. a phone number. */
  detail: string | null;
}

/** Cells that say only what the channel is, with no extra payload to keep. */
const BARE_CHANNEL_VALUES = new Set([
  "email",
  "email published",
  "contact form",
  "contact form only",
  "no contact found",
  "no contact",
  "none",
]);

/**
 * The `Channel` column mixes an enum with its payload. Real values include:
 *
 *   "email"
 *   "contact form only"
 *   "no contact found"
 *   "no contact page (404)"
 *   "phone only: (860-329-7187)"
 *   "WhatsApp only: +1 (416) 303-6969"
 *   "email; phone: +40 750 437 038"
 *   "phone only: 778 943 3625 (contact page email renders as 'email protected')"
 *
 * That last one is why an exclusive "X only" declaration is checked before the
 * generic email test. The cell mentions email twice while saying plainly that
 * there is no usable address, and a naive word match reads it as sendable.
 *
 * `detail` keeps the whole original cell whenever it says more than the bare
 * channel name, because these cells carry phone numbers, second addresses and
 * caveats that are worth keeping next to the prospect.
 */
export function parseChannel(raw: string | null | undefined): ParsedChannel {
  const value = (raw ?? "").trim();
  if (!value) return { channel: "none", detail: null };

  const lower = value.toLowerCase();
  const detail = BARE_CHANNEL_VALUES.has(lower) ? null : value;

  if (/^no contact\b|^not found\b|^none\b/.test(lower)) {
    return { channel: "none", detail };
  }

  // An exclusive declaration wins over any incidental mention of another channel.
  if (/\b(phone|whatsapp|telegram|sms|text|call)\s*(?:[-\s]?only)\b/.test(lower)) {
    return { channel: "phone", detail };
  }
  if (/\bcontact form\s*only\b/.test(lower)) {
    return { channel: "contact_form", detail };
  }
  if (/\bemail\s*only\b/.test(lower)) {
    return { channel: "email", detail };
  }

  if (/\bemail\b/.test(lower)) {
    return { channel: "email", detail };
  }
  if (/contact form/.test(lower)) {
    return { channel: "contact_form", detail };
  }
  if (/phone|whatsapp|telegram|call|sms/.test(lower)) {
    return { channel: "phone", detail };
  }

  return { channel: "none", detail };
}

/** Pull a phone number out of free text, keeping the digits and any leading +. */
export function extractPhone(value: string): string | null {
  const match = /(\+?[\d][\d\s().-]{6,}\d)/.exec(value);
  if (!match) return null;
  return match[1].trim().replace(/\s{2,}/g, " ");
}

/**
 * Reduce a domain or URL to a bare registrable host.
 *
 * `Domain` cells hold bare hosts, while `Finding URL` cells hold full URLs, and
 * both feed prospect identity. Subdomains are kept, because
 * `bulk.chunkyacademy.com` is genuinely a different storefront from its parent.
 */
export function normalizeDomain(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return null;

  let host = value;
  host = host.replace(/^[a-z]+:\/\//, "");
  host = host.split("/")[0];
  host = host.split("?")[0];
  host = host.split("#")[0];
  host = host.replace(/:\d+$/, "");
  host = host.replace(/^www\./, "");
  host = host.replace(/\.+$/, "");

  if (!host.includes(".") || /\s/.test(host)) return null;
  return host;
}

/** Fold casing and whitespace so `kratom` and `Kratom` become one value. */
export function normalizeVertical(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return value || null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return null;

  const angled = /<([^>]+)>/.exec(value);
  const address = (angled ? angled[1] : value).trim();

  // Deliberately permissive. The goal is to reject cells holding a sentence or
  // a URL, not to re-implement RFC 5322.
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(address)) return null;
  return address;
}

export function emailDomain(email: string): string | null {
  const parts = email.split("@");
  return parts.length === 2 ? parts[1].toLowerCase() : null;
}

/**
 * Stable identity for a prospect with no usable domain.
 *
 * The fintech job sheet has companies with no clean domain, and a plain unique
 * index over a nullable column never dedupes nulls. This gives those rows
 * something to be unique on.
 */
export function companyKey(company: string | null | undefined): string | null {
  const value = (company ?? "")
    .trim()
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|bv|sarl|pty)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return value || null;
}

/**
 * Words that mark a "contact" as a shared inbox rather than a person.
 *
 * The fintech sheet fills `Contact 1` with things like "Squads Talent",
 * "Verafin general enquiries" and "Hummingbird Jobs", with titles to match
 * ("Published talent inbox", "Recruiting team"). Storing those as a person's
 * name means a template using `{{first_name}}` greets a company with "Hi
 * Squads," or "Hi Verafin,". Treating them as nameless instead lets
 * `{{first_name|there}}` do its job.
 */
const INBOX_WORDS = [
  "careers", "career", "talent", "recruiting", "recruitment", "recruiter",
  "jobs", "hiring", "support", "enquiries", "enquiry", "inquiries",
  "general", "press", "media", "info", "contact", "team", "inbox",
  "desk", "hr", "people", "sales", "admin", "help", "hello",
];

const INBOX_TITLE_MARKERS = [
  "inbox", "published", "general company", "company email", "recruiting team",
  "talent team", "team inbox", "careers email", "hiring inbox", "point of c",
];

/**
 * Whether a contact is a shared mailbox rather than a named individual.
 *
 * Matches whole words only, so a person surnamed Hellon or Fielding is not
 * caught by "hello" or "field".
 */
export function looksLikeInbox(
  name: string | null | undefined,
  title: string | null | undefined
): boolean {
  const cleanName = (name ?? "").trim().toLowerCase();
  const cleanTitle = (title ?? "").trim().toLowerCase();

  if (!cleanName && !cleanTitle) return false;

  if (cleanName.includes("@")) return true;

  for (const marker of INBOX_TITLE_MARKERS) {
    if (cleanTitle.includes(marker)) return true;
  }

  const words = cleanName.split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => INBOX_WORDS.includes(word));
}

/** Grade is A, B or C in the sheets. Anything else is dropped rather than guessed. */
export function normalizeGrade(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().toUpperCase();
  return /^[ABC]$/.test(value) ? value : null;
}

/**
 * Sheet booleans. The columns hold "yes", "y", "true", "x" or a blank.
 * A blank means no, which is why absence is not treated as unknown.
 */
export function parseSheetBoolean(raw: string | null | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  return ["yes", "y", "true", "1", "x", "done", "sent"].includes(value);
}

/**
 * `Review before contacting` carries a reason, not a flag. Any non-empty value
 * means the prospect is on hold and cannot be enrolled.
 */
export function parseHoldReason(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (["no", "n", "false", "0"].includes(value.toLowerCase())) return null;
  return value;
}
