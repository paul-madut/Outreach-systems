import type { Db } from "@/lib/db";
import { emailDomain, normalizeDomain, normalizeEmail } from "@/lib/import/normalize";
import { isFreemailDomain } from "@/lib/mail/freemail-domains";

/**
 * The do-not-contact list.
 *
 * Checked before a contact can be enrolled and again before a message is
 * approved, because a suppression added midway through a campaign has to
 * catch messages already sitting in the queue.
 */

export type SuppressionKind = "email" | "domain";

export interface SuppressionHit {
  kind: SuppressionKind;
  value: string;
  reason: string | null;
}

export class FreemailSuppressionError extends Error {
  constructor(domain: string) {
    super(
      `Refusing to suppress "${domain}". It is a consumer mailbox provider, and ` +
        `suppressing it would retire every personal address at once. Suppress the ` +
        `individual address instead.`
    );
    this.name = "FreemailSuppressionError";
  }
}

export function addSuppression(
  db: Db,
  kind: SuppressionKind,
  rawValue: string,
  reason: string | null = null,
  source: string | null = null
): boolean {
  const value =
    kind === "email" ? normalizeEmail(rawValue) : normalizeDomain(rawValue);

  if (!value) return false;

  // A domain-level block on gmail.com would silently kill every consumer
  // address in the database.
  if (kind === "domain" && isFreemailDomain(value)) {
    throw new FreemailSuppressionError(value);
  }

  const result = db
    .prepare(
      `insert into suppressions (kind, value, reason, source)
       values (?, ?, ?, ?)
       on conflict (kind, value) do nothing`
    )
    .run(kind, value, reason, source);

  return result.changes > 0;
}

/**
 * Unblock something.
 *
 * Needed because suppressions are not all human decisions. `mailbox check-mx`
 * adds one when a domain returns NXDOMAIN, and NXDOMAIN is not always
 * permanent - asicminermarket.com returned it on 2026-09-22 and resolved
 * normally two days later. Without a way back, one bad reading loses a
 * prospect for good.
 *
 * Returns false when nothing was blocked under that value, so a caller can
 * tell "unblocked it" from "there was nothing to unblock".
 */
export function removeSuppression(db: Db, kind: SuppressionKind, rawValue: string): boolean {
  const value = kind === "email" ? normalizeEmail(rawValue) : normalizeDomain(rawValue);
  if (!value) return false;

  return (
    db.prepare("delete from suppressions where kind = ? and value = ?").run(kind, value).changes > 0
  );
}

/** Whether an address is blocked, by itself or by its domain. */
export function findSuppression(db: Db, rawEmail: string): SuppressionHit | null {
  const email = normalizeEmail(rawEmail);
  if (!email) return null;

  const byEmail = db
    .prepare("select kind, value, reason from suppressions where kind = 'email' and value = ?")
    .get(email) as SuppressionHit | undefined;
  if (byEmail) return byEmail;

  const domain = emailDomain(email);
  if (!domain) return null;

  const byDomain = db
    .prepare("select kind, value, reason from suppressions where kind = 'domain' and value = ?")
    .get(domain) as SuppressionHit | undefined;

  return byDomain ?? null;
}

export function isSuppressed(db: Db, email: string): boolean {
  return findSuppression(db, email) !== null;
}

/**
 * Parse a newline-delimited domain list.
 *
 * `research/exclude_master.txt` has 342 entries and NO trailing newline, so
 * `wc -l` reports 341. A loader that trusts a line count, or that splits and
 * assumes the last element is empty, drops `yourkratom.com` silently. Filtering
 * empties after the split is what makes the count come out right.
 */
export function parseDomainList(text: string): string[] {
  const seen = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const domain = normalizeDomain(line);
    if (domain) seen.add(domain);
  }

  return [...seen];
}

export interface SeedReport {
  parsed: number;
  added: number;
  alreadyPresent: number;
  refused: string[];
}

/** Load a domain list into the suppression table. Idempotent. */
export function seedDomainSuppressions(
  db: Db,
  text: string,
  source: string,
  reason = "Imported exclude list"
): SeedReport {
  const domains = parseDomainList(text);
  const report: SeedReport = {
    parsed: domains.length,
    added: 0,
    alreadyPresent: 0,
    refused: [],
  };

  const load = db.transaction(() => {
    for (const domain of domains) {
      try {
        if (addSuppression(db, "domain", domain, reason, source)) {
          report.added += 1;
        } else {
          report.alreadyPresent += 1;
        }
      } catch (error) {
        if (error instanceof FreemailSuppressionError) {
          report.refused.push(domain);
        } else {
          throw error;
        }
      }
    }
  });

  load();
  return report;
}
