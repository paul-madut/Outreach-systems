import { describe, expect, it } from "vitest";
import {
  classifyExchanges,
  normalizeExchange,
  resolveAll,
  resolveDomain,
  summarize,
  type DnsProbe,
} from "@/lib/mail/mx";

const dnsError = (code: string) => Object.assign(new Error(code), { code });

/** A probe backed by a fixture, so no test touches the network. */
function fakeProbe(
  zones: Record<string, { mx?: { exchange: string; priority: number }[]; a?: string[]; error?: string }>
): DnsProbe {
  return {
    async mx(domain) {
      const zone = zones[domain];
      if (!zone) throw dnsError("ENOTFOUND");
      if (zone.error) throw dnsError(zone.error);
      if (!zone.mx) throw dnsError("ENODATA");
      return zone.mx;
    },
    async addresses(domain) {
      const zone = zones[domain];
      if (!zone) throw dnsError("ENOTFOUND");
      if (zone.error) throw dnsError(zone.error);
      if (!zone.a) throw dnsError("ENODATA");
      return zone.a;
    },
  };
}

describe("classifying mail hosts", () => {
  it("strips the trailing dot and lowercases", () => {
    expect(normalizeExchange("ASPMX.L.GOOGLE.COM.")).toBe("aspmx.l.google.com");
  });

  it("recognises Google Workspace", () => {
    expect(classifyExchanges(["aspmx.l.google.com.", "alt1.aspmx.l.google.com."])).toBe("google");
    expect(classifyExchanges(["gmail-smtp-in.l.google.com"])).toBe("google");
  });

  it("recognises Microsoft 365", () => {
    expect(classifyExchanges(["example-com.mail.protection.outlook.com."])).toBe("microsoft");
  });

  it("recognises security gateways", () => {
    expect(classifyExchanges(["mx1-usg2.ppe-hosted.com."])).toBe("gateway");
    expect(classifyExchanges(["mx0a-00696f01.pphosted.com."])).toBe("gateway");
    expect(classifyExchanges(["uk-smtp-inbound-1.mimecast.com."])).toBe("gateway");
  });

  it("does not mistake a lookalike domain for the real host", () => {
    // The pattern is anchored, so a domain that merely contains the word is
    // not Google. Getting this wrong would overstate the case for Workspace.
    expect(classifyExchanges(["mail.google.com.evil.net"])).toBe("other");
    expect(classifyExchanges(["notgoogle.com"])).toBe("other");
  });

  it("falls back to other for everything else", () => {
    expect(classifyExchanges(["mx1.emailsrvr.com.", "mx2.emailsrvr.com."])).toBe("other");
    expect(classifyExchanges([])).toBe("other");
  });

  it("classifies on the lowest-priority record, which is tried first", () => {
    expect(
      classifyExchanges(["aspmx.l.google.com", "backup.mail.protection.outlook.com"])
    ).toBe("google");
  });
});

describe("resolving a domain", () => {
  const probe = fakeProbe({
    "hosted.com": { mx: [{ exchange: "aspmx.l.google.com.", priority: 10 }] },
    "parked.com": { a: ["185.125.27.119"] },
    "broken.com": { error: "ESERVFAIL" },
    "empty.com": {},
  });

  it("reports a hosted domain with its exchanges in priority order", async () => {
    const verdict = await resolveDomain("hosted.com", probe);
    expect(verdict).toEqual({
      kind: "hosted",
      host: "google",
      exchanges: ["aspmx.l.google.com"],
    });
  });

  it("sorts exchanges by priority before classifying", async () => {
    const mixed = fakeProbe({
      "mixed.com": {
        mx: [
          { exchange: "backup.mail.protection.outlook.com", priority: 20 },
          { exchange: "aspmx.l.google.com", priority: 5 },
        ],
      },
    });
    const verdict = await resolveDomain("mixed.com", mixed);
    expect(verdict).toMatchObject({ kind: "hosted", host: "google" });
  });

  it("calls a domain with an address but no MX 'implicit', not dead", async () => {
    // RFC 5321 falls back to the A record, so this is not proof of anything
    // and must never be suppressed automatically.
    expect(await resolveDomain("parked.com", probe)).toEqual({
      kind: "implicit",
      address: "185.125.27.119",
    });
  });

  it("calls a domain dead only when both lookups say it does not exist", async () => {
    expect(await resolveDomain("gone.com", probe)).toEqual({ kind: "dead" });
  });

  it("never calls a SERVFAIL dead", async () => {
    const verdict = await resolveDomain("broken.com", probe);
    expect(verdict.kind).toBe("unresolved");
  });

  it("does not call a domain dead when it exists but publishes nothing", async () => {
    const verdict = await resolveDomain("empty.com", probe);
    expect(verdict.kind).toBe("unresolved");
  });

  it("treats a blank MX target as no MX at all", async () => {
    const blank = fakeProbe({ "blank.com": { mx: [{ exchange: ".", priority: 0 }], a: ["1.2.3.4"] } });
    expect(await resolveDomain("blank.com", blank)).toMatchObject({ kind: "implicit" });
  });
});

describe("the report", () => {
  it("counts every verdict and resolves with bounded concurrency", async () => {
    const probe = fakeProbe({
      "a.com": { mx: [{ exchange: "aspmx.l.google.com", priority: 1 }] },
      "b.com": { mx: [{ exchange: "x.mail.protection.outlook.com", priority: 1 }] },
      "c.com": { mx: [{ exchange: "mx1.emailsrvr.com", priority: 1 }] },
      "d.com": { a: ["1.2.3.4"] },
      "e.com": { error: "ESERVFAIL" },
    });

    const results = await resolveAll(
      ["a.com", "b.com", "c.com", "d.com", "e.com", "gone.com"].map((domain) => ({
        domain,
        contacts: 2,
      })),
      { probe, concurrency: 2 }
    );

    expect(results.map((r) => r.domain)).toEqual([
      "a.com", "b.com", "c.com", "d.com", "e.com", "gone.com",
    ]);
    expect(summarize(results)).toEqual({
      google: 1,
      microsoft: 1,
      gateway: 0,
      other: 1,
      implicit: 1,
      dead: 1,
      unresolved: 1,
      total: 6,
    });
  });
});
