/**
 * Delivery Status Notification parsing.
 *
 * RFC 3464 defines a `message/delivery-status` part with `Final-Recipient`,
 * `Action` and `Status` fields, and most providers send something close to it.
 * Exchange and some appliances send prose instead, so there is a fallback that
 * reads an enhanced status code out of the raw text.
 *
 * The distinction that matters is hard versus soft. A 5.x.x means the address
 * is bad and must be suppressed. A 4.x.x is a temporary condition and must not
 * be, or one full mailbox would permanently retire a live prospect.
 */

export interface DsnResult {
  /** Enhanced status code, e.g. "5.1.1". */
  status: string | null;
  /** "failed", "delayed", "delivered", "relayed" or "expanded". */
  action: string | null;
  /** The address that failed, lowercased. */
  recipient: string | null;
  /** Raw SMTP diagnostic, when present. */
  diagnostic: string | null;
  /** True for 5.x.x. */
  hard: boolean;
  /** True for 4.x.x. */
  soft: boolean;
}

const STATUS_FIELD = /^Status:\s*([245]\.\d{1,3}\.\d{1,3})\s*$/im;
const ACTION_FIELD = /^Action:\s*(failed|delayed|delivered|relayed|expanded)\s*$/im;
const FINAL_RECIPIENT = /^Final-Recipient:\s*[^;]*;\s*(.+?)\s*$/im;
const ORIGINAL_RECIPIENT = /^Original-Recipient:\s*[^;]*;\s*(.+?)\s*$/im;
const DIAGNOSTIC_CODE = /^Diagnostic-Code:\s*(.+?)\s*$/im;

/** Loose fallback: an enhanced code sitting in prose, as Exchange NDRs do. */
const LOOSE_STATUS = /\b([45]\.\d{1,3}\.\d{1,3})\b/;
/** Barest fallback: a bare SMTP reply code such as "550". */
const LOOSE_SMTP_CODE = /\b([45])(\d{2})\b\s/;

const ANGLE_ADDRESS = /<([^>]+)>/;

function cleanAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const angled = ANGLE_ADDRESS.exec(value);
  const raw = (angled ? angled[1] : value).trim().toLowerCase();
  // rfc822 addresses in DSNs are sometimes quoted or trailed by a comment.
  const stripped = raw.replace(/^"+|"+$/g, "").split(/\s+/)[0];
  return stripped.includes("@") ? stripped : null;
}

export function parseDsn(raw: string): DsnResult {
  const statusMatch = STATUS_FIELD.exec(raw);
  const actionMatch = ACTION_FIELD.exec(raw);
  const finalMatch = FINAL_RECIPIENT.exec(raw);
  const originalMatch = ORIGINAL_RECIPIENT.exec(raw);
  const diagnosticMatch = DIAGNOSTIC_CODE.exec(raw);

  let status = statusMatch?.[1] ?? null;

  if (!status) {
    const loose = LOOSE_STATUS.exec(raw);
    if (loose) {
      status = loose[1];
    } else {
      const smtp = LOOSE_SMTP_CODE.exec(raw);
      // A bare 550 tells us the class but not the detail, so normalise to x.0.0.
      if (smtp) status = `${smtp[1]}.0.0`;
    }
  }

  const recipient =
    cleanAddress(finalMatch?.[1]) ?? cleanAddress(originalMatch?.[1]) ?? null;

  return {
    status,
    action: actionMatch?.[1]?.toLowerCase() ?? null,
    recipient,
    diagnostic: diagnosticMatch?.[1] ?? null,
    hard: status?.startsWith("5.") ?? false,
    soft: status?.startsWith("4.") ?? false,
  };
}

/** Message-IDs quoted inside a bounce, newest first. Used to find the original send. */
export function messageIdsIn(raw: string): string[] {
  const ids: string[] = [];
  for (const match of raw.matchAll(/<[^<>\s@]+@[^<>\s]+>/g)) {
    const id = match[0];
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}
