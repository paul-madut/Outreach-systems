import { randomBytes } from "node:crypto";

/**
 * RFC 5322 Message-IDs and thread headers.
 *
 * The id is generated when a message row is created, not when it is sent, for
 * two reasons. A retry reuses the same id, giving a receiving server a chance
 * to recognise the duplicate. And a follow-up can reference step 1's id while
 * step 1 is still sitting in the queue.
 */

export function generateMessageId(domain: string): string {
  const unique = `${Date.now().toString(36)}.${randomBytes(8).toString("hex")}`;
  return `<${unique}@${sanitiseDomain(domain)}>`;
}

function sanitiseDomain(domain: string): string {
  const clean = domain.trim().toLowerCase().replace(/^.*@/, "");
  return /^[a-z0-9.-]+$/.test(clean) && clean.includes(".") ? clean : "outreach.local";
}

/**
 * The References chain for a reply.
 *
 * RFC 5322 says to append the parent's id to the parent's References. Mail
 * clients walk this to thread a conversation, and the reply poller matches
 * against every id in it, so keeping the full chain is what lets a reply to
 * step 3 still resolve to the enrollment that started at step 1.
 */
export function buildReferences(
  parentReferences: string | null | undefined,
  parentMessageId: string
): string {
  const existing = (parentReferences ?? "")
    .split(/\s+/)
    .map((id) => id.trim())
    .filter(Boolean);

  if (!existing.includes(parentMessageId)) existing.push(parentMessageId);
  return existing.join(" ");
}

/** Message-IDs in a References or In-Reply-To header, in order. */
export function parseReferences(header: string | null | undefined): string[] {
  if (!header) return [];
  return header.match(/<[^<>\s]+>/g) ?? [];
}

/**
 * Gmail threads on subject as well as headers, so a follow-up that changes the
 * wording starts a new conversation even with correct References. One "Re: "
 * only; "Re: Re: Re:" reads as machine-generated.
 */
export function replySubject(originalSubject: string): string {
  const trimmed = originalSubject.trim();
  return /^re:\s/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}
