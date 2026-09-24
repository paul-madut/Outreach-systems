import { describe, expect, it } from "vitest";
import {
  buildContext,
  firstSentence,
  shortCompanyName,
  splitName,
  toTemplateKey,
} from "@/lib/template/context";
import {
  referencedFields,
  render,
  renderMessage,
  sectionFields,
} from "@/lib/template/render";
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

describe("conditional sections", () => {
  it("includes a section when the field has a value", () => {
    const result = render('Hi.\n\n{{#quote}}Your page says "{{quote}}".{{/quote}}\n\nThanks.', {
      quote: "We only accept crypto",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain('Your page says "We only accept crypto".');
  });

  it("drops a section when the field is missing, without failing the render", () => {
    // The point of sections: research is uneven, and a template written for a
    // prospect with a quote must still work for one without.
    const result = render('Hi.\n\n{{#quote}}Your page says "{{quote}}".{{/quote}}\n\nThanks.', {});
    expect(result).toEqual({ ok: true, text: "Hi.\n\nThanks." });
  });

  it("drops a section when the field is present but blank", () => {
    const result = render("A{{#q}} and {{q}}{{/q}}", { q: "   " });
    expect(result).toEqual({ ok: true, text: "A" });
  });

  it("supports an inverted section for the fallback wording", () => {
    const template = "{{#quote}}Your page says it.{{/quote}}{{^quote}}Your checkout shows it.{{/quote}}";
    expect(render(template, { quote: "x" })).toEqual({ ok: true, text: "Your page says it." });
    expect(render(template, {})).toEqual({ ok: true, text: "Your checkout shows it." });
  });

  it("does not count a field inside a dropped section as missing", () => {
    const result = render("Hi.{{#quote}} {{quote}} and {{second_quote}}{{/quote}}", {});
    expect(result.ok).toBe(true);
  });

  it("still fails on a missing field outside any section", () => {
    const result = render("Hi {{first_name}}.{{#quote}}{{quote}}{{/quote}}", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toEqual(["first_name"]);
  });

  it("handles nesting", () => {
    const template = "{{#a}}A{{#b}}B{{/b}}{{/a}}";
    expect(render(template, { a: "1", b: "1" })).toEqual({ ok: true, text: "AB" });
    expect(render(template, { a: "1" })).toEqual({ ok: true, text: "A" });
    expect(render(template, {})).toEqual({ ok: true, text: "" });
  });

  it("collapses the gap a dropped section leaves behind", () => {
    const template = "One.\n\n{{#missing}}Two.{{/missing}}\n\nThree.";
    const result = render(template, {});
    expect(result.ok).toBe(true);
    // Not "One.\n\n\n\nThree."
    if (result.ok) expect(result.text).toBe("One.\n\nThree.");
  });

  it("lists section fields separately from merge fields", () => {
    expect(sectionFields("{{#quote}}{{quote}}{{/quote}} {{company}}")).toEqual(["quote"]);
  });
});

describe("style rules ignore quoted text", () => {
  // These emails quote the prospect's own page. Their punctuation is evidence,
  // not a mistake for Paul to fix, and warning about it teaches him to ignore
  // warnings entirely.
  const quoted =
    'Your page says "Bank transfer only; the order number is the reference!".\n\nWorth a look?';

  it("does not warn on a semicolon inside a quote", () => {
    expect(lintMessage("Quick question", quoted).some((f) => f.rule === "semicolon")).toBe(false);
  });

  it("does not warn on an exclamation inside a quote", () => {
    expect(lintMessage("Quick question", quoted).some((f) => f.rule === "exclamation")).toBe(false);
  });

  it("still warns when Paul writes one himself", () => {
    const own = 'Your page says "cards are off". That is fixable; let me show you!';
    const rules = lintMessage("Quick question", own).map((f) => f.rule);
    expect(rules).toContain("semicolon");
    expect(rules).toContain("exclamation");
  });

  it("still blocks an em dash inside a quote, because it goes out either way", () => {
    const findings = lintMessage("Quick question", 'They say "cards — gone".');
    expect(findings.some((f) => f.rule === "no-unicode-dash")).toBe(true);
  });
});

describe("footer is excluded from the word count", () => {
  const footer = "Paul M\npaymentswithpaul.com\n\nReply with stop and I will not email you again.";

  it("does not count boilerplate against the target", () => {
    // 118 words of body, plus an 11 word footer. Only the footer pushes it over.
    const body = `${Array.from({ length: 118 }, () => "word").join(" ")}\n\n${footer}`;
    expect(lintMessage("Hi", body, DEFAULT_POLICY, { footer }).some((f) => f.rule === "too-long")).toBe(
      false
    );
    // Without telling the linter about the footer, the same text trips it.
    expect(lintMessage("Hi", body).some((f) => f.rule === "too-long")).toBe(true);
  });
});

describe("firstSentence", () => {
  it("cuts a long verbatim quote at a sentence boundary and marks the cut", () => {
    // A real quote from the peptide research tab.
    const quote =
      "We accept bank transfer payments. After placing your order, you will see our bank details (PAYID, BSB, and Account Number). Please use your order number as the payment reference.";
    expect(firstSentence(quote)).toBe(
      "We accept bank transfer payments. After placing your order, you will see our bank details (PAYID, BSB, and Account Number)..."
    );
  });

  it("keeps a question plus its answer together, which is the sharpest form", () => {
    const quote =
      "Which payment methods do you accept? Interac e-Transfer only. This keeps card processing fees out of the vial price.";
    expect(firstSentence(quote)).toBe(
      "Which payment methods do you accept? Interac e-Transfer only..."
    );
  });

  it("returns null when there is nothing worth shortening", () => {
    expect(firstSentence("Bank wire only.")).toBeNull();
    expect(firstSentence("We only accept crypto at this time")).toBeNull();
    expect(firstSentence("")).toBeNull();
  });

  it("does not cut on a decimal point", () => {
    const text =
      "Card rules 5.1 apply to every merchant in this category without exception whatsoever.";
    expect(firstSentence(text)).toBeNull();
  });
});

describe("derived _first fields", () => {
  it("exposes a shortened form alongside the full value", () => {
    const context = buildContext({
      contact: { email: "a@b.com" },
      prospect: {
        custom: {
          "Verbatim quote (the hook)":
            "We accept bank transfer payments. After placing your order, you will see our bank details. Use your order number.",
        },
      },
      sender,
    });

    expect(context.verbatim_quote_the_hook).toContain("Use your order number");
    expect(context.verbatim_quote_the_hook_first).toContain("...");
    expect(context.verbatim_quote_the_hook_first!.length).toBeLessThan(
      context.verbatim_quote_the_hook.length
    );
  });

  it("omits the field entirely when the value is already short", () => {
    const context = buildContext({
      contact: { email: "a@b.com" },
      prospect: { custom: { quote: "Bank wire only." } },
      sender,
    });

    // Absent rather than duplicated, so a template can branch on it.
    expect(context.quote_first).toBeUndefined();
  });
});

describe("shortCompanyName", () => {
  it("drops the research parenthetical", () => {
    // "Is that the case for Exo Club (Exodus)?" reads like a database row.
    expect(shortCompanyName("Exo Club (Exodus)")).toBe("Exo Club");
    expect(shortCompanyName("Arete Hemp LLC (wholesale)")).toBe("Arete Hemp");
    expect(shortCompanyName("Better Living Peptides (BLP Research)")).toBe("Better Living Peptides");
  });

  it("drops a legal suffix", () => {
    expect(shortCompanyName("BlueNex Labs Inc.")).toBe("BlueNex Labs");
    expect(shortCompanyName("Pure Progress Ltd")).toBe("Pure Progress");
  });

  it("stops a shouted name from shouting", () => {
    expect(shortCompanyName("E-CIGARETTES.CA INC.")).toBe("E-Cigarettes.Ca");
  });

  it("leaves a deliberate mixed-case name alone", () => {
    expect(shortCompanyName("CryptoBuyX")).toBe("CryptoBuyX");
    expect(shortCompanyName("Otie's Botanicals")).toBe("Otie's Botanicals");
  });

  it("never returns an empty name", () => {
    expect(shortCompanyName("LLC")).toBe("LLC");
  });
});

describe("off-topic quote warning", () => {
  it("flags a quote that says nothing about payments", () => {
    // Real case: a prospect whose research quote was its company registration.
    const findings = lintMessage(
      "Quick question",
      'Your own page says "Company Name: FORGETRADE LIMITED, a Hong Kong private company limited by shares".'
    );
    expect(findings.some((f) => f.rule === "off-topic-quote")).toBe(true);
    expect(hasBlockingFindings(findings)).toBe(false);
  });

  it("stays quiet when the quote is about payments", () => {
    const findings = lintMessage(
      "Quick question",
      'Your own page says "Do you accept credit cards? No, we do not, and we do not plan on it."'
    );
    expect(findings.some((f) => f.rule === "off-topic-quote")).toBe(false);
  });
});

describe("sections inside a line", () => {
  // The greeting branch pattern. Swallowing the newline after the losing
  // branch pulled the first paragraph up onto the greeting's line, so every
  // personalised job outreach email went out looking like a mistake.
  const GREETING =
    "{{#first_name}}Hi {{first_name}},{{/first_name}}{{^first_name}}Hello,{{/first_name}}\n\nI am a Carleton student.";

  it("keeps the paragraph break when the name is present", () => {
    const result = render(GREETING, { first_name: "Vivek" });
    expect(result.ok && result.text).toBe("Hi Vivek,\n\nI am a Carleton student.");
  });

  it("keeps the paragraph break when the name is missing", () => {
    const result = render(GREETING, {});
    expect(result.ok && result.text).toBe("Hello,\n\nI am a Carleton student.");
  });

  it("still drops the whole line for a section that owns one", () => {
    const result = render("One\n{{#quote}}\nQuoted: {{quote}}\n{{/quote}}\nTwo", {});
    expect(result.ok && result.text).toBe("One\nTwo");
  });

  it("leaves a mid-sentence branch unchanged", () => {
    const template = "Might not be relevant{{#first_name}} {{first_name}}{{/first_name}}, but";

    const named = render(template, { first_name: "Paul" });
    expect(named.ok && named.text).toBe("Might not be relevant Paul, but");

    const anonymous = render(template, {});
    expect(anonymous.ok && anonymous.text).toBe("Might not be relevant, but");
  });
});
