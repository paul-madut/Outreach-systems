import { messageIdsIn } from "./parse-dsn";
import { senderAddress, type InboundMessage } from "./classify-inbound";
import { isFreemailDomain } from "./freemail-domains";

/**
 * Linking an inbound message back to the message that provoked it.
 *
 * Threading headers are the reliable path, but plenty of real mail loses them:
 * some helpdesks rewrite a thread entirely, and a prospect forwarding to a
 * colleague breaks the chain. The looser fallbacks are there to catch those,
 * and every match records how it was found so a wrong stop can be undone.
 */

export type MatchMethod =
  | "in_reply_to"
  | "references"
  | "dsn_body"
  | "failed_recipient"
  | "sender_address"
  | "sender_domain";

export interface SentLookup {
  /** Our Message-ID (with angle brackets) to the message row id. */
  byMessageId: Map<string, string>;
  /** Lowercased recipient address to message row ids, newest first. */
  byRecipient: Map<string, string[]>;
  /** Lowercased recipient domain to message row ids, newest first. */
  byRecipientDomain: Map<string, string[]>;
}

export interface MatchResult {
  messageId: string;
  method: MatchMethod;
}

export interface MatchOptions {
  /**
   * How far back a bare address or domain match is allowed to reach. Threading
   * headers are exact, so they are not bounded; a loose match to a send from
   * last spring almost certainly is not about that send.
   */
  looseMatchWindowDays?: number;
  /** Used to evaluate the window. */
  now?: Date;
  /** Row id to sent-at, for the windowed fallbacks. */
  sentAt?: Map<string, Date>;
}

const DEFAULT_LOOSE_WINDOW_DAYS = 45;

function withinWindow(
  rowId: string,
  options: Required<Pick<MatchOptions, "looseMatchWindowDays" | "now">> & {
    sentAt?: Map<string, Date>;
  }
): boolean {
  const sentAt = options.sentAt?.get(rowId);
  if (!sentAt) return true; // No timestamp recorded, so do not exclude on it.
  const ageMs = options.now.getTime() - sentAt.getTime();
  return ageMs <= options.looseMatchWindowDays * 86_400_000;
}

export function matchInbound(
  message: InboundMessage,
  lookup: SentLookup,
  options: MatchOptions = {}
): MatchResult | null {
  const windowOptions = {
    looseMatchWindowDays: options.looseMatchWindowDays ?? DEFAULT_LOOSE_WINDOW_DAYS,
    now: options.now ?? new Date(),
    sentAt: options.sentAt,
  };

  // 1. In-Reply-To is the single most reliable signal.
  const inReplyTo = message.headers.inReplyTo?.trim();
  if (inReplyTo) {
    const hit = lookup.byMessageId.get(inReplyTo);
    if (hit) return { messageId: hit, method: "in_reply_to" };
  }

  // 2. Any id in the References chain. Walk newest first: a long thread ends
  //    with the message actually being replied to.
  const references = message.headers.references ?? [];
  for (let i = references.length - 1; i >= 0; i -= 1) {
    const hit = lookup.byMessageId.get(references[i].trim());
    if (hit) return { messageId: hit, method: "references" };
  }

  // 3. Bounces often drop threading headers but quote the original message,
  //    id and all, inside the attached report.
  if (message.raw) {
    for (const id of messageIdsIn(message.raw)) {
      const hit = lookup.byMessageId.get(id);
      if (hit) return { messageId: hit, method: "dsn_body" };
    }
  }

  // 4. X-Failed-Recipients names the address that failed even when the DSN
  //    itself is unparsable.
  const failed = message.headers.xFailedRecipients?.trim().toLowerCase();
  if (failed) {
    const candidates = lookup.byRecipient.get(failed);
    const hit = candidates?.find((id) => withinWindow(id, windowOptions));
    if (hit) return { messageId: hit, method: "failed_recipient" };
  }

  // 5. The exact address we wrote to, replying from a client that stripped the
  //    threading headers.
  const from = senderAddress(message.headers.from);
  const byAddress = lookup.byRecipient.get(from);
  const addressHit = byAddress?.find((id) => withinWindow(id, windowOptions));
  if (addressHit) return { messageId: addressHit, method: "sender_address" };

  // 6. A colleague at the same company answering on their own address. Only
  //    safe on a company domain, since matching on gmail.com would connect
  //    unrelated people. `sent_log.json` already contains gmail and outlook
  //    recipients, so this case is not hypothetical.
  const domain = from.split("@")[1];
  if (domain && !isFreemailDomain(domain)) {
    const byDomain = lookup.byRecipientDomain.get(domain);
    const domainHit = byDomain?.find((id) => withinWindow(id, windowOptions));
    if (domainHit) return { messageId: domainHit, method: "sender_domain" };
  }

  return null;
}
