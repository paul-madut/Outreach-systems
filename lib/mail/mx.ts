import { promises as dns } from "node:dns";

/**
 * Who hosts a recipient's mail, and whether the domain accepts mail at all.
 *
 * Two reasons this exists. The first is that a hard bounce during the first
 * fortnight of a ramp is the fastest way to spend a new domain's reputation,
 * so dead addresses are worth finding before the first send rather than after.
 * The second is that knowing how much of a list sits behind Google and
 * Microsoft is what decides whether a sending provider is worth paying for.
 *
 * The verdicts follow the same discipline as `classifySmtpError`: act only on
 * certainty. A domain is 'dead' only when DNS says it does not exist, because
 * 'dead' is what suppresses a prospect and a suppression is not easily undone.
 * Anything merely suspicious is reported for a human to look at.
 */

export type MailHost = "google" | "microsoft" | "gateway" | "other";

export type DomainVerdict =
  /** Has MX records. `host` says whose filter the message will meet. */
  | { kind: "hosted"; host: MailHost; exchanges: string[] }
  /**
   * No MX, but the domain resolves. RFC 5321 says a sender then falls back to
   * the A record, so this is deliverable in principle. In practice it is
   * usually a parked domain that will reject, which is why it is reported
   * separately rather than counted as either working or dead.
   */
  | { kind: "implicit"; address: string }
  /** NXDOMAIN on both lookups. The domain does not exist. */
  | { kind: "dead" }
  /** SERVFAIL, a timeout, anything else. Says nothing either way. */
  | { kind: "unresolved"; error: string };

/** Matched against the MX hostnames, longest-standing patterns first. */
const HOST_PATTERNS: { host: MailHost; pattern: RegExp }[] = [
  { host: "google", pattern: /(^|\.)(google|googlemail)\.com$/ },
  { host: "microsoft", pattern: /(^|\.)(outlook|office365|microsoft)\.com$/ },
  {
    host: "gateway",
    pattern:
      /(^|\.)(pphosted|ppe-hosted|proofpoint|mimecast|barracudanetworks|iphmx|messagelabs|mailspamprotection|trendmicro|sophos|forcepoint|mailcontrol)\.(com|net|co\.uk)$/,
  },
];

/** Normalise an MX hostname: lowercase, no trailing dot. */
export function normalizeExchange(exchange: string): string {
  return exchange.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Whose filter a message to this domain will meet.
 *
 * Pure, so the classification can be asserted without DNS. The lowest-priority
 * record decides, because that is the one a sender tries first.
 */
export function classifyExchanges(exchanges: string[]): MailHost {
  for (const raw of exchanges) {
    const exchange = normalizeExchange(raw);
    for (const { host, pattern } of HOST_PATTERNS) {
      if (pattern.test(exchange)) return host;
    }
  }
  return "other";
}

/** The DNS calls, behind an interface so `resolveDomain` can be tested. */
export interface DnsProbe {
  mx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  addresses(domain: string): Promise<string[]>;
}

export const nodeDnsProbe: DnsProbe = {
  mx: (domain) => dns.resolveMx(domain),
  addresses: async (domain) => {
    const [v4, v6] = await Promise.allSettled([dns.resolve4(domain), dns.resolve6(domain)]);
    const out: string[] = [];
    if (v4.status === "fulfilled") out.push(...v4.value);
    if (v6.status === "fulfilled") out.push(...v6.value);
    if (out.length === 0) {
      // Surface the v4 failure so the caller can tell NXDOMAIN from SERVFAIL.
      if (v4.status === "rejected") throw v4.reason;
      throw Object.assign(new Error("no addresses"), { code: "ENODATA" });
    }
    return out;
  },
};

function errorCode(error: unknown): string {
  return (error as { code?: string })?.code ?? "UNKNOWN";
}

/** Node reports a non-existent domain as ENOTFOUND, and no-records as ENODATA. */
const NO_SUCH_DOMAIN = "ENOTFOUND";
const NO_RECORDS_OF_TYPE = "ENODATA";

/**
 * Decide what a domain does with mail.
 *
 * The A-record lookup is not an optimisation. Node reports both "no such
 * domain" and "no MX record" through error codes that some resolvers blur, so
 * a domain is only called dead when the address lookup agrees that it does not
 * exist. That second opinion is what makes automatic suppression safe.
 */
export async function resolveDomain(
  domain: string,
  probe: DnsProbe = nodeDnsProbe
): Promise<DomainVerdict> {
  let mxError: unknown;

  try {
    const records = await probe.mx(domain);
    const usable = records.filter((record) => normalizeExchange(record.exchange).length > 0);

    if (usable.length > 0) {
      const exchanges = [...usable]
        .sort((a, b) => a.priority - b.priority)
        .map((record) => normalizeExchange(record.exchange));
      return { kind: "hosted", host: classifyExchanges(exchanges), exchanges };
    }
  } catch (error) {
    mxError = error;
    const code = errorCode(error);
    if (code !== NO_SUCH_DOMAIN && code !== NO_RECORDS_OF_TYPE) {
      return { kind: "unresolved", error: `MX lookup failed (${code})` };
    }
  }

  // No MX. Whether that means "parked" or "gone" depends on the A record.
  try {
    const addresses = await probe.addresses(domain);
    return { kind: "implicit", address: addresses[0] };
  } catch (error) {
    const code = errorCode(error);
    if (code === NO_SUCH_DOMAIN && errorCode(mxError) === NO_SUCH_DOMAIN) {
      return { kind: "dead" };
    }
    if (code === NO_RECORDS_OF_TYPE || code === NO_SUCH_DOMAIN) {
      // The domain exists but publishes neither MX nor address records, so
      // there is nowhere to deliver. Still not proof it is gone.
      return { kind: "unresolved", error: "No MX and no address record" };
    }
    return { kind: "unresolved", error: `Address lookup failed (${code})` };
  }
}

export interface DomainResult {
  domain: string;
  verdict: DomainVerdict;
  /** How many emailable contacts sit on this domain. */
  contacts: number;
}

export interface MxSummary {
  google: number;
  microsoft: number;
  gateway: number;
  other: number;
  implicit: number;
  dead: number;
  unresolved: number;
  total: number;
}

/** Counts by verdict. Pure, so the report can be asserted. */
export function summarize(results: DomainResult[]): MxSummary {
  const summary: MxSummary = {
    google: 0,
    microsoft: 0,
    gateway: 0,
    other: 0,
    implicit: 0,
    dead: 0,
    unresolved: 0,
    total: results.length,
  };

  for (const { verdict } of results) {
    if (verdict.kind === "hosted") summary[verdict.host] += 1;
    else summary[verdict.kind] += 1;
  }

  return summary;
}

/**
 * Resolve many domains with a bounded number in flight.
 *
 * A few hundred lookups at once will exhaust the resolver and turn real
 * answers into timeouts, which this code reads as 'unresolved' and therefore
 * as nothing at all.
 */
export async function resolveAll(
  domains: { domain: string; contacts: number }[],
  options: { probe?: DnsProbe; concurrency?: number; onResult?: (result: DomainResult) => void } = {}
): Promise<DomainResult[]> {
  const { probe = nodeDnsProbe, concurrency = 8, onResult } = options;
  const results: DomainResult[] = [];
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= domains.length) return;

      const { domain, contacts } = domains[index];
      const verdict = await resolveDomain(domain, probe);
      const result = { domain, verdict, contacts };
      results.push(result);
      onResult?.(result);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, domains.length) }, () => worker())
  );

  return results.sort((a, b) => a.domain.localeCompare(b.domain));
}
