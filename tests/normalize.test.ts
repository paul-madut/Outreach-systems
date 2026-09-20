import { describe, expect, it } from "vitest";
import {
  companyKey,
  emailDomain,
  extractPhone,
  normalizeDomain,
  normalizeEmail,
  normalizeGrade,
  normalizeVertical,
  parseChannel,
  parseHoldReason,
  looksLikeInbox,
  parseSheetBoolean,
} from "@/lib/import/normalize";

// Every input below is a value that appears in Paul's actual research sheets.

describe("parseChannel", () => {
  it("reads the plain enum values", () => {
    expect(parseChannel("email")).toEqual({ channel: "email", detail: null });
    expect(parseChannel("contact form only")).toEqual({
      channel: "contact_form",
      detail: null,
    });
  });

  it("keeps the full cell as detail when it carries a phone number", () => {
    expect(parseChannel("phone only: (860-329-7187)")).toEqual({
      channel: "phone",
      detail: "phone only: (860-329-7187)",
    });
  });

  it("treats WhatsApp as a phone channel", () => {
    const parsed = parseChannel("WhatsApp only: +1 (416) 303-6969");
    expect(parsed.channel).toBe("phone");
    expect(parsed.detail).toContain("416");
  });

  it("prefers email when a cell lists email plus another channel", () => {
    const parsed = parseChannel("email; phone: +40 750 437 038");
    expect(parsed.channel).toBe("email");
    expect(parsed.detail).toContain("phone");
  });

  it("does not read an incidental mention of email as a sendable address", () => {
    // Real row. It says plainly that there is no usable address, while using
    // the word "email" twice. A naive word match queues an unsendable prospect.
    const parsed = parseChannel(
      "phone only: 778 943 3625 (contact page email renders as 'email protected')"
    );
    expect(parsed.channel).toBe("phone");
  });

  it("keeps a phone number attached to a contact-form-only prospect", () => {
    const parsed = parseChannel("contact form only; phone: +61 485 689 121");
    expect(parsed.channel).toBe("contact_form");
    expect(parsed.detail).toContain("+61");
  });

  it("drops detail when the cell says nothing beyond the channel", () => {
    expect(parseChannel("email").detail).toBeNull();
    expect(parseChannel("email published").detail).toBeNull();
    expect(parseChannel("contact form only").detail).toBeNull();
  });

  it("maps every no-contact variant to none", () => {
    expect(parseChannel("no contact found").channel).toBe("none");
    expect(parseChannel("no contact page (404)").channel).toBe("none");
    expect(parseChannel("").channel).toBe("none");
    expect(parseChannel(null).channel).toBe("none");
  });
});

describe("extractPhone", () => {
  it("finds a number inside free text", () => {
    expect(extractPhone("phone only: (860-329-7187)")).toBe("860-329-7187");
    expect(extractPhone("no number here")).toBeNull();
  });
});

describe("normalizeDomain", () => {
  it("reduces a URL to a bare host", () => {
    expect(normalizeDomain("https://otiesbotanicals.com/payment-shipping/")).toBe(
      "otiesbotanicals.com"
    );
    expect(normalizeDomain("https://www.keepshooting.com/pay-with-crypto")).toBe(
      "keepshooting.com"
    );
  });

  it("keeps a subdomain, which is a different storefront", () => {
    expect(normalizeDomain("bulk.chunkyacademy.com")).toBe("bulk.chunkyacademy.com");
  });

  it("strips a port and trailing dot", () => {
    expect(normalizeDomain("example.com:443")).toBe("example.com");
    expect(normalizeDomain("example.com.")).toBe("example.com");
  });

  it("rejects values that are not hosts", () => {
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
  });
});

describe("normalizeVertical", () => {
  it("folds the casing split in the sheet", () => {
    expect(normalizeVertical("kratom")).toBe("kratom");
    expect(normalizeVertical("Kratom")).toBe("kratom");
    expect(normalizeVertical("  THCa   wholesale ")).toBe("thca wholesale");
  });
});

describe("normalizeEmail", () => {
  it("lowercases the mixed-case addresses in the sheet", () => {
    expect(normalizeEmail("Enquiries@bioplexpeptides.co.uk")).toBe(
      "enquiries@bioplexpeptides.co.uk"
    );
    expect(normalizeEmail("Info@supernaturalbotanicals.com")).toBe(
      "info@supernaturalbotanicals.com"
    );
  });

  it("unwraps a display name", () => {
    expect(normalizeEmail("Joel <joel@store.com>")).toBe("joel@store.com");
  });

  it("rejects prose and blanks", () => {
    expect(normalizeEmail("contact form only")).toBeNull();
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe("emailDomain", () => {
  it("splits the host off", () => {
    expect(emailDomain("support@store.com")).toBe("store.com");
    expect(emailDomain("broken")).toBeNull();
  });
});

describe("companyKey", () => {
  it("gives domainless rows something to dedupe on", () => {
    expect(companyKey("Loop (Loop Financial)")).toBe("loop-loop-financial");
    expect(companyKey("Arete Hemp LLC")).toBe("arete-hemp");
    expect(companyKey("Tetra Trust (Tetra Digital Group)")).toBe(
      "tetra-trust-tetra-digital-group"
    );
  });

  it("returns null for an empty company", () => {
    expect(companyKey("")).toBeNull();
  });
});

describe("normalizeGrade", () => {
  it("accepts A, B and C only", () => {
    expect(normalizeGrade("A")).toBe("A");
    expect(normalizeGrade("b")).toBe("B");
    expect(normalizeGrade("")).toBeNull();
    expect(normalizeGrade("A+")).toBeNull();
  });
});

describe("parseSheetBoolean", () => {
  it("reads the yes/blank convention", () => {
    expect(parseSheetBoolean("yes")).toBe(true);
    expect(parseSheetBoolean("YES")).toBe(true);
    expect(parseSheetBoolean("")).toBe(false);
    expect(parseSheetBoolean(null)).toBe(false);
  });
});

describe("parseHoldReason", () => {
  it("treats any reason as a hold", () => {
    expect(parseHoldReason("looks like a scam site")).toBe("looks like a scam site");
    expect(parseHoldReason("yes")).toBe("yes");
  });

  it("treats blank and explicit no as clear", () => {
    expect(parseHoldReason("")).toBeNull();
    expect(parseHoldReason("no")).toBeNull();
    expect(parseHoldReason(null)).toBeNull();
  });
});

describe("looksLikeInbox", () => {
  // Real Contact 1 values from the fintech sheet.
  it("catches shared mailboxes", () => {
    expect(looksLikeInbox("Squads Talent", "Published talent inbox")).toBe(true);
    expect(looksLikeInbox("Coalition support/general inbox", null)).toBe(true);
    expect(looksLikeInbox("Verafin general enquiries", null)).toBe(true);
    expect(looksLikeInbox("Hummingbird Jobs", "Hiring inbox")).toBe(true);
    expect(looksLikeInbox("Careers inbox", null)).toBe(true);
    expect(looksLikeInbox("KOHO Talent team", null)).toBe(true);
  });

  it("catches a bare address in the name field", () => {
    expect(looksLikeInbox("talent@sqds.io", null)).toBe(true);
  });

  it("catches it from the title alone", () => {
    expect(looksLikeInbox("Acme", "General company inbox")).toBe(true);
    expect(looksLikeInbox("Zip Press/Newsroom", "Published company inbox (newsroom)")).toBe(true);
  });

  it("leaves real people alone", () => {
    expect(looksLikeInbox("Ryan Bozarth", "Co-Founder & CEO")).toBe(false);
    expect(looksLikeInbox("Nassim Eddequiouaq", "CEO, Bastion")).toBe(false);
    expect(looksLikeInbox("Jana Hill", "Chief People Officer")).toBe(false);
    expect(looksLikeInbox("Kim Nguyen", "Chief People Officer")).toBe(false);
  });

  it("does not match a word merely contained in a name", () => {
    // "hello" must not catch Hellon, "info" must not catch Infosys' founder.
    expect(looksLikeInbox("Marta Hellon", "VP Engineering")).toBe(false);
    expect(looksLikeInbox("Sam Teaming", "CTO")).toBe(false);
  });

  it("is false when there is nothing to judge", () => {
    expect(looksLikeInbox(null, null)).toBe(false);
    expect(looksLikeInbox("", "")).toBe(false);
  });
});
