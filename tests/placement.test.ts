import { describe, expect, it } from "vitest";
import {
  classifyFolder,
  parseAuthResults,
  summarise,
  unfoldHeaders,
  warnings,
  type SeedOutcome,
} from "@/lib/mail/placement";

/** A real Gmail header block, folded the way Gmail actually folds it. */
const GMAIL_HEADERS = `Delivered-To: seed@gmail.com
Received: by 2002:a05:6214 with SMTP id x1csp123456
Authentication-Results: mx.google.com;
       dkim=pass header.i=@paulecom.com header.s=google header.b=Ab1Cd2Ef;
       spf=pass (google.com: domain of paul@paulecom.com designates 209.85.220.41
       as permitted sender) smtp.mailfrom=paul@paulecom.com;
       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=paulecom.com
Subject: Quick question
From: Paul Madut <paul@paulecom.com>`;

describe("header unfolding", () => {
  it("joins continuation lines onto their header", () => {
    const headers = unfoldHeaders(GMAIL_HEADERS);
    const auth = headers.find((h) => h.startsWith("Authentication-Results"))!;
    expect(auth).toContain("dkim=pass");
    expect(auth).toContain("spf=pass");
    expect(auth).toContain("dmarc=pass");
  });

  it("drops blank lines and keeps header order", () => {
    expect(unfoldHeaders("A: 1\n\nB: 2\n  cont")).toEqual(["A: 1", "B: 2 cont"]);
  });
});

describe("parsing the receiver's auth verdict", () => {
  it("reads all three results out of a folded Gmail header", () => {
    expect(parseAuthResults(GMAIL_HEADERS)).toEqual({
      present: true,
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      verifier: "mx.google.com",
    });
  });

  it("strips the parenthetical reason that follows a verdict", () => {
    const raw = "Authentication-Results: mx.google.com; spf=softfail (google.com: domain transitioning) smtp.mailfrom=x@y.com";
    expect(parseAuthResults(raw).spf).toBe("softfail");
  });

  it("reports unknown for methods the receiver did not run", () => {
    const raw = "Authentication-Results: mx.google.com; spf=pass smtp.mailfrom=x@y.com";
    const r = parseAuthResults(raw);
    expect(r.spf).toBe("pass");
    expect(r.dkim).toBe("unknown");
    expect(r.dmarc).toBe("unknown");
  });

  it("uses the first header, which is the accepting host's verdict", () => {
    // A forwarder prepends its own; later headers describe earlier hops and
    // can disagree. The one that decided placement is the first.
    const raw = [
      "Authentication-Results: mx.google.com; spf=fail; dkim=fail; dmarc=fail",
      "Authentication-Results: relay.example.net; spf=pass; dkim=pass; dmarc=pass",
    ].join("\n");
    const r = parseAuthResults(raw);
    expect(r.verifier).toBe("mx.google.com");
    expect(r.spf).toBe("fail");
  });

  it("returns unknowns rather than throwing when the header is absent", () => {
    expect(parseAuthResults("Subject: hi\nFrom: a@b.com")).toEqual({
      present: false, spf: "unknown", dkim: "unknown", dmarc: "unknown", verifier: null,
    });
  });
});

describe("folder classification", () => {
  it("trusts the special-use flag over the name", () => {
    expect(classifyFolder("Weird Name", "\\Junk")).toBe("spam");
    expect(classifyFolder("Junk", "\\Inbox")).toBe("inbox");
  });

  it("recognises each provider's spelling of spam", () => {
    for (const name of ["Junk", "Spam", "[Gmail]/Spam", "Junk E-mail", "Bulk Mail"]) {
      expect(classifyFolder(name), name).toBe("spam");
    }
  });

  it("treats INBOX as inbox regardless of case", () => {
    expect(classifyFolder("INBOX")).toBe("inbox");
    expect(classifyFolder("inbox")).toBe("inbox");
  });

  it("does not call a user folder spam because of its parent", () => {
    expect(classifyFolder("INBOX/Clients")).toBe("inbox");
  });
});

const outcome = (over: Partial<SeedOutcome>): SeedOutcome => ({
  seedLabel: "icloud",
  seedEmail: "paul.madut@icloud.com",
  placement: "inbox",
  folder: "INBOX",
  auth: { present: true, spf: "pass", dkim: "pass", dmarc: "pass", verifier: "mx.icloud.com" },
  deliverySeconds: 12,
  ...over,
});

describe("the report", () => {
  it("counts placements and computes an inbox rate over what arrived", () => {
    const r = summarise("pwp-1", "paul@paulecom.com", [
      outcome({}),
      outcome({ seedLabel: "gmail", placement: "spam", folder: "[Gmail]/Spam" }),
      outcome({ seedLabel: "outlook", placement: "missing", folder: null, auth: null }),
    ]);
    expect({ inbox: r.inbox, spam: r.spam, missing: r.missing }).toEqual({ inbox: 1, spam: 1, missing: 1 });
    // Missing seeds are excluded: they say nothing about placement either way.
    expect(r.inboxRate).toBe(0.5);
  });

  it("has no inbox rate when nothing arrived", () => {
    const r = summarise("pwp-1", "paul@paulecom.com", [outcome({ placement: "missing", auth: null })]);
    expect(r.inboxRate).toBeNull();
  });

  it("stays quiet when everything passed and landed", () => {
    expect(warnings(summarise("pwp-1", "paul@paulecom.com", [outcome({})]))).toEqual([]);
  });

  it("names the failing method and the receiver that failed it", () => {
    const r = summarise("pwp-1", "paul@paulecom.com", [
      outcome({ auth: { present: true, spf: "pass", dkim: "fail", dmarc: "fail", verifier: "mx.google.com" } }),
    ]);
    const w = warnings(r);
    expect(w.some((line) => /DKIM fail at mx\.google\.com/.test(line))).toBe(true);
    expect(w.some((line) => /DMARC fail at mx\.google\.com/.test(line))).toBe(true);
  });

  it("blocks the campaign while the inbox rate is below 100%", () => {
    const r = summarise("pwp-1", "paul@paulecom.com", [outcome({}), outcome({ placement: "spam" })]);
    expect(warnings(r).some((l) => l.includes("Do not start a campaign"))).toBe(true);
  });
});

describe("a message no receiver authenticated", () => {
  it("is reported once, not as three separate failures", () => {
    const report = summarise("payments", "paul@example.com", [
      outcome({
        auth: { present: false, spf: "unknown", dkim: "unknown", dmarc: "unknown", verifier: null },
      }),
    ]);

    const lines = warnings(report);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("recorded no SPF, DKIM or DMARC result");
  });

  it("still warns per method when a receiver did check and disagreed", () => {
    const report = summarise("payments", "paul@example.com", [
      outcome({
        auth: { present: true, spf: "pass", dkim: "fail", dmarc: "unknown", verifier: "mx.google.com" },
      }),
    ]);

    const lines = warnings(report);
    expect(lines.some((l) => l.includes("DKIM fail"))).toBe(true);
    expect(lines.some((l) => l.includes("recorded no SPF"))).toBe(false);
  });
});

describe("a receiver that splits its verdicts across headers", () => {
  // Verbatim from iCloud, which writes one header per verifier and leads with
  // BIMI. Reading only the first header reported three unknowns on a message
  // that had in fact passed all three.
  const ICLOUD = [
    'Authentication-Results: bimi.icloud.com; bimi=skipped reason="insufficient dmarc"',
    "Authentication-Results: arc.icloud.com; arc=none",
    "Authentication-Results: dmarc.icloud.com; dmarc=pass header.from=paulecom.com",
    "Authentication-Results: dkim-verifier.icloud.com; dkim=pass header.d=paulecom.com",
    "Authentication-Results: spf.icloud.com; spf=pass (spf.icloud.com: domain of",
    " paul@paulecom.com designates 74.125.227.9 as permitted sender)",
    "Received-SPF: pass (spf.icloud.com: domain of paul@paulecom.com)",
  ].join("\r\n");

  it("takes each method from the header that declares it", () => {
    const auth = parseAuthResults(ICLOUD);

    expect(auth.present).toBe(true);
    expect(auth.spf).toBe("pass");
    expect(auth.dkim).toBe("pass");
    expect(auth.dmarc).toBe("pass");
  });

  it("names whoever reached the DMARC verdict", () => {
    expect(parseAuthResults(ICLOUD).verifier).toBe("dmarc.icloud.com");
  });

  it("does not read an authserv-id as a result", () => {
    // "dkim-verifier.icloud.com" must not be mistaken for a dkim= result, and
    // bimi's reason="insufficient dmarc" must not be mistaken for dmarc=.
    const auth = parseAuthResults(
      'Authentication-Results: bimi.icloud.com; bimi=skipped reason="insufficient dmarc"'
    );
    expect(auth.present).toBe(false);
    expect(auth.dmarc).toBe("unknown");
  });

  it("still reads a provider that puts everything in one header", () => {
    const auth = parseAuthResults(
      "Authentication-Results: mx.google.com;\r\n" +
        "       dkim=pass header.i=@paulecom.com;\r\n" +
        "       spf=pass smtp.mailfrom=paul@paulecom.com;\r\n" +
        "       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=paulecom.com"
    );
    expect([auth.spf, auth.dkim, auth.dmarc]).toEqual(["pass", "pass", "pass"]);
    expect(auth.verifier).toBe("mx.google.com");
  });

  it("lets the accepting host win over a forwarder that prepended its own", () => {
    const auth = parseAuthResults(
      [
        "Authentication-Results: mx.google.com; dkim=pass; spf=pass; dmarc=pass",
        "Authentication-Results: relay.example.net; dkim=fail; spf=fail; dmarc=fail",
      ].join("\r\n")
    );
    expect([auth.spf, auth.dkim, auth.dmarc]).toEqual(["pass", "pass", "pass"]);
  });
});
