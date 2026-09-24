/**
 * Inbox placement testing.
 *
 * The question that actually matters before a campaign starts is "does mail
 * from this mailbox reach the inbox, and did authentication pass at a real
 * receiver". A placement test answers both by sending a genuine message to
 * seed inboxes and then reading, over IMAP, which folder it landed in and what
 * the receiving provider wrote in its Authentication-Results header.
 *
 * That header is the receiver's own verdict, computed on a real message from
 * the real sending mailbox. It is worth more than any external checker's
 * guess, because a checker can only evaluate the DNS records; only Gmail can
 * tell you what Gmail concluded.
 *
 * Deliberately NOT here: anything that manufactures engagement. Marking a
 * message read over IMAP sets a flag that Gmail does not use for reputation,
 * and reciprocal sending between a handful of accounts on one tenant is the
 * most detectable pattern there is. This module measures placement; it does
 * not try to influence it.
 */

/** Where a test message ended up at the seed. */
export type Placement = "inbox" | "spam" | "missing";

export type AuthVerdict = "pass" | "fail" | "softfail" | "neutral" | "none" | "unknown";

export interface AuthResults {
  /**
   * Whether the message carried an Authentication-Results header at all.
   *
   * Absent is not the same as failing. It means no receiver ever ran the
   * checks, which is what happens when a message never leaves the sending
   * provider - a seed on the same tenant as the sender. Without this flag
   * that case reads as three separate failures.
   */
  present: boolean;
  spf: AuthVerdict;
  dkim: AuthVerdict;
  dmarc: AuthVerdict;
  /** The host that performed the checks, e.g. "mx.google.com". */
  verifier: string | null;
}

const VERDICTS: AuthVerdict[] = ["pass", "fail", "softfail", "neutral", "none"];

function normaliseVerdict(raw: string | undefined): AuthVerdict {
  if (!raw) return "unknown";
  const value = raw.trim().toLowerCase();
  // Providers append reasons: "pass (google.com: domain of ... designates ...)"
  const head = value.split(/[\s(]/)[0];
  return (VERDICTS as string[]).includes(head) ? (head as AuthVerdict) : "unknown";
}

/**
 * Read the receiver's authentication verdict.
 *
 * A message carries several Authentication-Results headers and providers
 * disagree about how to use them. Gmail writes one header holding spf, dkim
 * and dmarc together. iCloud writes one header per verifier - bimi.icloud.com,
 * arc.icloud.com, dmarc.icloud.com, dkim-verifier.icloud.com, spf.icloud.com -
 * and the first of them is BIMI, which carries no verdict at all.
 *
 * So each method is taken from the first header that actually declares it,
 * rather than from the first header. Scanning in order still means the host
 * that finally accepted the message wins over a forwarder that prepended its
 * own, which is what matters when the two disagree.
 */
export function parseAuthResults(rawHeaders: string): AuthResults {
  const headers = unfoldHeaders(rawHeaders)
    .filter((h) => /^authentication-results\s*:/i.test(h))
    .map((h) => h.replace(/^authentication-results\s*:/i, "").trim());

  const read = (method: string): { verdict: AuthVerdict; verifier: string | null } | null => {
    for (const body of headers) {
      // `spf=pass`, `dkim = pass`, `dmarc=pass (p=NONE ...)`. The \b keeps
      // "dkim-verifier.icloud.com" from being read as a dkim result.
      const match = new RegExp(`\\b${method}\\s*=\\s*([a-z]+)`, "i").exec(body);
      if (!match) continue;
      return {
        verdict: normaliseVerdict(match[1]),
        verifier: /^([^;\s]+)/.exec(body)?.[1] ?? null,
      };
    }
    return null;
  };

  const spf = read("spf");
  const dkim = read("dkim");
  const dmarc = read("dmarc");

  return {
    // A header that declares none of the three - iCloud's BIMI one, say - is
    // not a verdict. Treating it as one reported three failed checks that
    // nobody had actually run.
    present: Boolean(spf || dkim || dmarc),
    spf: spf?.verdict ?? "unknown",
    dkim: dkim?.verdict ?? "unknown",
    dmarc: dmarc?.verdict ?? "unknown",
    // DMARC is the summary verdict, so name whoever reached it.
    verifier: dmarc?.verifier ?? dkim?.verifier ?? spf?.verifier ?? null,
  };
}

/**
 * Split a raw header block into logical headers.
 *
 * RFC 5322 allows a header to continue onto following lines that begin with
 * whitespace, and Authentication-Results is long enough that providers almost
 * always fold it. Parsing line by line would see only the first fragment and
 * silently miss the dkim and dmarc results.
 */
export function unfoldHeaders(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1] += " " + line.trim();
    } else if (line.trim() !== "") {
      out.push(line);
    }
  }
  return out;
}

/**
 * Classify an IMAP folder name as inbox or spam.
 *
 * Providers disagree on the name: Gmail uses "[Gmail]/Spam", iCloud and
 * Outlook use "Junk". The special-use flag is authoritative when the server
 * sends it, so the caller passes it when known and the name is the fallback.
 */
export function classifyFolder(folder: string, specialUse?: string | null): Placement {
  if (specialUse === "\\Junk") return "spam";
  if (specialUse === "\\Inbox") return "inbox";

  const name = folder.toLowerCase();
  if (name === "inbox") return "inbox";
  if (/(^|\/)(junk|spam|bulk mail|junk e-?mail)$/.test(name)) return "spam";
  // Gmail nests under a namespace: "[Gmail]/Spam".
  if (name.includes("spam") || name.includes("junk")) return "spam";
  return "inbox";
}

export interface SeedOutcome {
  seedLabel: string;
  seedEmail: string;
  placement: Placement;
  folder: string | null;
  auth: AuthResults | null;
  /** Seconds between sending and the message appearing at the seed. */
  deliverySeconds: number | null;
}

export interface PlacementReport {
  senderLabel: string;
  senderEmail: string;
  outcomes: SeedOutcome[];
  inbox: number;
  spam: number;
  missing: number;
  /** Share of seeds that placed in the inbox, 0 to 1. Null when none arrived. */
  inboxRate: number | null;
}

export function summarise(
  senderLabel: string,
  senderEmail: string,
  outcomes: SeedOutcome[]
): PlacementReport {
  const inbox = outcomes.filter((o) => o.placement === "inbox").length;
  const spam = outcomes.filter((o) => o.placement === "spam").length;
  const missing = outcomes.filter((o) => o.placement === "missing").length;
  const landed = inbox + spam;

  return {
    senderLabel,
    senderEmail,
    outcomes,
    inbox,
    spam,
    missing,
    inboxRate: landed === 0 ? null : inbox / landed,
  };
}

/** Anything worth telling the reader, in the order it should be acted on. */
export function warnings(report: PlacementReport): string[] {
  const out: string[] = [];

  for (const o of report.outcomes) {
    if (o.placement === "missing") {
      out.push(`${o.seedLabel}: never arrived. Either still in flight, or rejected outright.`);
      continue;
    }
    if (o.placement === "spam") {
      out.push(`${o.seedLabel}: landed in spam.`);
    }
    if (!o.auth) continue;
    if (!o.auth.present) {
      out.push(
        `${o.seedLabel}: the receiver recorded no SPF, DKIM or DMARC result. ` +
          `Expected when the seed is on the same provider as the sender - use a seed elsewhere to test authentication.`
      );
      continue;
    }
    if (o.auth.spf !== "pass") out.push(`${o.seedLabel}: SPF ${o.auth.spf} at ${o.auth.verifier ?? "the receiver"}.`);
    if (o.auth.dkim !== "pass") out.push(`${o.seedLabel}: DKIM ${o.auth.dkim} at ${o.auth.verifier ?? "the receiver"}.`);
    if (o.auth.dmarc !== "pass") out.push(`${o.seedLabel}: DMARC ${o.auth.dmarc} at ${o.auth.verifier ?? "the receiver"}.`);
  }

  if (report.inboxRate !== null && report.inboxRate < 1) {
    out.push(
      `Inbox rate ${Math.round(report.inboxRate * 100)}%. Do not start a campaign from ${report.senderEmail} until this is 100%.`
    );
  }
  return out;
}
