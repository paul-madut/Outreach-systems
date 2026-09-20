import { describe, expect, it } from "vitest";
import { buildContext, splitName, toTemplateKey } from "@/lib/template/context";
import { referencedFields, render, renderMessage } from "@/lib/template/render";
import { DEFAULT_POLICY, hasBlockingFindings, lintMessage } from "@/lib/template/lint";

const sender = { name: "Paul Madut", email: "paul@example.com" };

describe("toTemplateKey", () => {
  it("slugs real sheet headers", () => {
    expect(toTemplateKey("Payment methods today")).toBe("payment_methods_today");
    expect(toTemplateKey("Verbatim quote (the hook)")).toBe("verbatim_quote_the_hook");
    expect(toTemplateKey("Subject (agent fills)")).toBe("subject_agent_fills");
    expect(toTemplateKey("  Grade  ")).toBe("grade");
  });
});

describe("splitName", () => {
  it("handles missing, single and multi-word names", () => {
    expect(splitName(null)).toEqual({ first: "", last: "" });
    expect(splitName("Joel")).toEqual({ first: "Joel", last: "" });
    expect(splitName("Mike Van Der Berg")).toEqual({
      first: "Mike",
      last: "Van Der Berg",
    });
  });
});

describe("buildContext", () => {
  it("exposes custom columns as merge fields", () => {
    const context = buildContext({
      contact: { email: "support@store.com" },
      prospect: {
        company: "Otie's Botanicals",
        domain: "otiesbotanicals.com",
        custom: {
          "Payment methods today": "Bitcoin, Ethereum (10% off)",
          "Verbatim quote (the hook)": "Kratom companies are considered 'High Risk'",
        },
      },
      sender,
    });

    expect(context.payment_methods_today).toBe("Bitcoin, Ethereum (10% off)");
    expect(context.domain).toBe("otiesbotanicals.com");
  });

  it("never lets a custom column shadow the real recipient", () => {
    const context = buildContext({
      contact: { email: "real@store.com", custom: { Email: "wrong@store.com" } },
      prospect: { custom: { email: "alsowrong@store.com" } },
      sender,
    });

    expect(context.email).toBe("real@store.com");
  });

  it("joins array values, which is how `lanes` arrives from research JSON", () => {
    const context = buildContext({
      contact: { email: "a@b.com" },
      prospect: { custom: { lanes: ["US", "GLP-1"] } },
      sender,
    });

    expect(context.lanes).toBe("US, GLP-1");
  });
});

describe("render", () => {
  it("substitutes known fields", () => {
    const result = render("Saw {{domain}} takes {{payment_methods_today}}.", {
      domain: "example.com",
      payment_methods_today: "Zelle",
    });

    expect(result).toEqual({ ok: true, text: "Saw example.com takes Zelle." });
  });

  it("fails loudly on a missing field rather than sending a placeholder", () => {
    const result = render("Hi {{first_name}},", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toEqual(["first_name"]);
  });

  it("treats an empty value as missing", () => {
    const result = render("Hi {{first_name}},", { first_name: "" });
    expect(result.ok).toBe(false);
  });

  it("uses a fallback for role addresses", () => {
    const result = render("Hi {{first_name|there}},", { first_name: "" });
    expect(result).toEqual({ ok: true, text: "Hi there," });
  });

  it("collects every missing field at once", () => {
    const result = render("{{a}} {{b}} {{a}} {{c}}", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toEqual(["a", "b", "c"]);
  });

  it("tolerates whitespace inside the braces", () => {
    expect(render("{{ domain }}", { domain: "x.com" })).toEqual({
      ok: true,
      text: "x.com",
    });
  });
});

describe("referencedFields", () => {
  it("lists each field once", () => {
    expect(referencedFields("{{a}} {{b|x}} {{a}}")).toEqual(["a", "b"]);
  });
});

describe("renderMessage", () => {
  it("passes an agent-written draft straight through", () => {
    // This is the whole mechanism for per-row drafts: the sheet's Subject and
    // Body columns import as custom fields, and step 1 is just {{subject}}.
    const result = renderMessage("{{subject}}", "{{body}}", {
      subject: "Quick question",
      body: "Hello,\n\nYour FAQ reads...",
    });

    expect(result).toEqual({
      ok: true,
      subject: "Quick question",
      body: "Hello,\n\nYour FAQ reads...",
    });
  });

  it("merges missing fields from subject and body", () => {
    const result = renderMessage("{{a}}", "{{b}}", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toEqual(["a", "b"]);
  });
});

describe("lintMessage", () => {
  const clean = "Your FAQ says you only take Zelle.\n\nThat is worth a look.";

  it("passes clean copy", () => {
    expect(lintMessage("Quick question", clean)).toEqual([]);
  });

  it("blocks an em dash", () => {
    const findings = lintMessage("Quick question", "Cards are down — that hurts.");
    expect(findings.some((f) => f.rule === "no-unicode-dash")).toBe(true);
    expect(hasBlockingFindings(findings)).toBe(true);
  });

  it("blocks an en dash, which the old build script let through", () => {
    const findings = lintMessage("Quick question", "Rules 5.1 – 5.4 apply.");
    expect(findings.some((f) => f.rule === "no-unicode-dash")).toBe(true);
  });

  it("blocks fabricated claims from the brief", () => {
    const findings = lintMessage(
      "Quick question",
      "I have migrated 40+ high-risk stores with zero freezes."
    );
    const banned = findings.filter((f) => f.rule === "banned-claim");
    expect(banned.length).toBeGreaterThan(0);
    expect(hasBlockingFindings(findings)).toBe(true);
  });

  it("blocks a leftover merge field", () => {
    const findings = lintMessage("Quick question", "Hi {{first_name}},");
    expect(findings.some((f) => f.rule === "unresolved-field")).toBe(true);
  });

  it("blocks an empty subject or body", () => {
    expect(lintMessage("", clean).some((f) => f.rule === "empty-subject")).toBe(true);
    expect(lintMessage("Hi", "  ").some((f) => f.rule === "empty-body")).toBe(true);
  });

  it("warns without blocking on style", () => {
    const findings = lintMessage(
      "Quick question",
      "I hope this email finds you well! We should talk; it matters."
    );
    const rules = findings.map((f) => f.rule);
    expect(rules).toContain("stock-opener");
    expect(rules).toContain("exclamation");
    expect(rules).toContain("semicolon");
    expect(hasBlockingFindings(findings)).toBe(false);
  });

  it("warns past the word target", () => {
    const long = Array.from({ length: DEFAULT_POLICY.maxWords + 5 }, () => "word").join(" ");
    const findings = lintMessage("Quick question", long);
    expect(findings.some((f) => f.rule === "too-long")).toBe(true);
    expect(hasBlockingFindings(findings)).toBe(false);
  });

  it("takes extra banned phrases per campaign", () => {
    const findings = lintMessage("Quick question", "We guarantee approval in 24 hours.", {
      bannedPhrases: ["guarantee approval"],
      maxWords: 120,
    });
    expect(findings.some((f) => f.rule === "banned-claim")).toBe(true);
  });
});
