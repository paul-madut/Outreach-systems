/**
 * Content linting for a rendered message.
 *
 * These rules come from `~/Desktop/peptide-outreach/COLD-EMAIL-BRIEF.md`, which
 * is the actual spec for how Paul's cold email is allowed to read. The brief
 * splits into two kinds of rule, and so does this:
 *
 * - "What he must never say" lists claims another model invented. Sending one
 *   would end his credibility with a prospect, so those BLOCK.
 * - "Voice rules" are style. Breaking one makes an email worse, not unsendable,
 *   so those WARN and stay visible in the review queue.
 *
 * Everything here is pure and works on rendered text. Checks that need the
 * database - duplicate recipient, suppression list, a prospect on hold - run at
 * enrollment instead, in lib/enroll.
 */

export type Severity = "block" | "warn";

export interface LintFinding {
  rule: string;
  severity: Severity;
  message: string;
  /** The offending text, when quoting it helps Paul find it. */
  excerpt?: string;
}

export interface LintPolicy {
  /** Case-insensitive substrings that must not appear. */
  bannedPhrases: string[];
  /** Body word count above which a warning is raised. */
  maxWords: number;
}

/**
 * Seeded from "What he must never say". Every one of these was fabricated by
 * another model during the 2026-09-14 offer rewrite and none can be backed up.
 */
export const DEFAULT_BANNED_PHRASES = [
  "zero freezes",
  "40+ high-risk",
  "37 stores",
  "stores saved",
  "90% of freezes",
  "i work free",
  "or i work free",
  "guaranteed approval",
  "guarantee approval",
];

export const DEFAULT_MAX_WORDS = 120;

export const DEFAULT_POLICY: LintPolicy = {
  bannedPhrases: DEFAULT_BANNED_PHRASES,
  maxWords: DEFAULT_MAX_WORDS,
};

/** Openers that read as templated outreach the moment they are seen. */
const STOCK_OPENERS = [
  "i hope this email finds you well",
  "hope this email finds you well",
  "i hope you are doing well",
  "i hope you're doing well",
  "i wanted to reach out",
  "i am reaching out",
  "i'm reaching out",
  "to whom it may concern",
];

const EM_DASH = "—";
const EN_DASH = "–";

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Remove text inside double quotes, straight or curly.
 *
 * Used only by the style rules. A quoted sentence is the prospect's, and its
 * punctuation is evidence rather than a mistake to correct.
 */
function stripQuotedSpans(text: string): string {
  return text.replace(/"[^"]*"/g, '""').replace(/\u201c[^\u201d]*\u201d/g, "");
}

function excerptAround(text: string, index: number, width = 40): string {
  const start = Math.max(0, index - width);
  const end = Math.min(text.length, index + width);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

/**
 * Lint a rendered subject and body.
 *
 * `subject` and `body` are checked together because a banned claim in a subject
 * line is exactly as damaging as one in the body.
 */
export interface LintOptions {
  /**
   * The campaign footer, if it is already appended to `body`.
   *
   * Excluded from the word count only. It is the same boilerplate on every
   * message, so counting it makes a short email look long and pushes the real
   * copy shorter than it needs to be. Every other rule still sees it, because
   * an em dash or a bad claim in the footer goes out just the same.
   */
  footer?: string | null;
}

export function lintMessage(
  subject: string,
  body: string,
  policy: LintPolicy = DEFAULT_POLICY,
  options: LintOptions = {}
): LintFinding[] {
  const findings: LintFinding[] = [];
  const combined = `${subject}\n${body}`;
  const lower = combined.toLowerCase();

  const footer = options.footer?.trim();
  const bodyWithoutFooter =
    footer && body.trimEnd().endsWith(footer)
      ? body.trimEnd().slice(0, -footer.length)
      : body;

  // --- blocking ---

  // Paul's global rule, and the one his old build script only half-enforced:
  // it asserted on U+2014 only, while en dashes are already present in the
  // research quotes that get pasted into bodies.
  for (const [dash, name] of [
    [EM_DASH, "em dash"],
    [EN_DASH, "en dash"],
  ] as const) {
    const index = combined.indexOf(dash);
    if (index !== -1) {
      findings.push({
        rule: "no-unicode-dash",
        severity: "block",
        message: `Contains an ${name}. Use a plain dash.`,
        excerpt: excerptAround(combined, index),
      });
    }
  }

  // A literal {{...}} surviving into rendered text means the render was not
  // strict, or someone pasted a template into a body field.
  const leftover = combined.match(/\{\{[^}]*\}\}/);
  if (leftover) {
    findings.push({
      rule: "unresolved-field",
      severity: "block",
      message: "An unresolved merge field reached the rendered message.",
      excerpt: leftover[0],
    });
  }

  for (const phrase of policy.bannedPhrases) {
    const needle = phrase.toLowerCase().trim();
    if (!needle) continue;
    const index = lower.indexOf(needle);
    if (index !== -1) {
      findings.push({
        rule: "banned-claim",
        severity: "block",
        message: `Contains a claim that cannot be backed up: "${phrase}".`,
        excerpt: excerptAround(combined, index),
      });
    }
  }

  if (!subject.trim()) {
    findings.push({
      rule: "empty-subject",
      severity: "block",
      message: "Subject is empty.",
    });
  }
  if (!body.trim()) {
    findings.push({
      rule: "empty-body",
      severity: "block",
      message: "Body is empty.",
    });
  }

  // --- warnings ---

  const words = countWords(bodyWithoutFooter);
  if (words > policy.maxWords) {
    findings.push({
      rule: "too-long",
      severity: "warn",
      message: `Body is ${words} words, over the ${policy.maxWords} word target${
        footer ? ", not counting the footer" : ""
      }.`,
    });
  }

  // Style rules judge Paul's own writing, so quoted text is excluded. These
  // emails quote the prospect's own page verbatim, and their punctuation is
  // not his to fix. Warning about it anyway trains him to ignore warnings.
  const unquoted = stripQuotedSpans(combined);

  if (unquoted.includes("!")) {
    findings.push({
      rule: "exclamation",
      severity: "warn",
      message: "Contains an exclamation mark.",
    });
  }

  if (unquoted.includes(";")) {
    findings.push({
      rule: "semicolon",
      severity: "warn",
      message: "Contains a semicolon. The brief asks for short, separate sentences.",
    });
  }

  for (const opener of STOCK_OPENERS) {
    const index = unquoted.toLowerCase().indexOf(opener);
    if (index !== -1) {
      findings.push({
        rule: "stock-opener",
        severity: "warn",
        message: `Reads as templated outreach: "${opener}".`,
        excerpt: excerptAround(unquoted, index),
      });
      break;
    }
  }

  return findings;
}

/** Whether anything in the findings prevents sending. */
export function hasBlockingFindings(findings: LintFinding[]): boolean {
  return findings.some((f) => f.severity === "block");
}
