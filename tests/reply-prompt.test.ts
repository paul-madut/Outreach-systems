import { describe, expect, it } from "vitest";
import { buildPrompt, SYSTEM_PROMPT } from "@/lib/reply/prompt";
import { withoutQuotedTail, type ReplyContext } from "@/lib/reply/context";

const context = (over: Partial<ReplyContext> = {}): ReplyContext => ({
  inboundBody: "Yes",
  inboundSubject: "Re: Quick question about Auspep Labs",
  fromEmail: "auspeplabs@gmail.com",
  classification: "reply",
  campaignName: "high-risk payments",
  campaignTemplate: "Might not be relevant, but your own page says...",
  sentSubject: "Quick question about Auspep Labs",
  sentBody: "Two things happen when cards are off.",
  company: "Auspep Labs",
  vertical: "research peptides",
  research: { payment_methods_today: "Bank transfer only", country: "Australia" },
  priorAttempts: [],
  ...over,
});

describe("the system prompt", () => {
  // Paul's hard rule, enforced by the linter on every outgoing message. A
  // draft that needs hand-editing to remove them is not saving him anything.
  it("forbids em and en dashes", () => {
    expect(SYSTEM_PROMPT).toContain("Never an em dash or an en dash");
  });

  // A reply to a job-outreach message written as a payments consultant is
  // worse than no reply, so the persona comes from the campaign rather than
  // being baked in.
  it("names both kinds of outreach rather than assuming one", () => {
    expect(SYSTEM_PROMPT).toMatch(/payments consulting/);
    expect(SYSTEM_PROMPT).toMatch(/looking for fintech work/);
  });

  it("rules out a reply that only acknowledges", () => {
    expect(SYSTEM_PROMPT).toContain("is not a reply; it is a read receipt");
  });

  it("forbids inventing facts about the prospect's business", () => {
    expect(SYSTEM_PROMPT).toMatch(/Never invent facts/);
  });

  it("asks for the body only, because the footer is appended", () => {
    expect(SYSTEM_PROMPT).toContain("Write the reply body only");
  });
});

describe("buildPrompt", () => {
  it("carries what they actually wrote", () => {
    expect(buildPrompt(context())).toContain("## What they wrote back\nYes");
  });

  it("carries the campaign angle and the message they received", () => {
    const prompt = buildPrompt(context());
    expect(prompt).toContain("high-risk payments");
    expect(prompt).toContain("Two things happen when cards are off.");
  });

  it("carries the research as readable lines", () => {
    expect(buildPrompt(context())).toContain("- payment methods today: Bank transfer only");
  });

  it("leaves out sections it has nothing for", () => {
    const prompt = buildPrompt(
      context({ campaignName: null, campaignTemplate: null, sentBody: null, research: {} })
    );
    expect(prompt).not.toContain("## The campaign this came from");
    expect(prompt).not.toContain("## What we know about them");
  });

  // A reroll that has not been told what it already wrote returns the same
  // reply with the words moved around.
  it("shows a reroll what it already produced", () => {
    const prompt = buildPrompt(context({ priorAttempts: ["Great, sending it over now."] }));
    expect(prompt).toContain("## Drafts already rejected");
    expect(prompt).toContain("Great, sending it over now.");
    expect(prompt).toContain("not a rephrasing");
  });

  it("says nothing about rejected drafts on the first attempt", () => {
    expect(buildPrompt(context())).not.toContain("Drafts already rejected");
  });

  it("copes with a body that could not be read", () => {
    expect(buildPrompt(context({ inboundBody: "" }))).toContain("could not be read");
  });
});

describe("withoutQuotedTail", () => {
  it("drops the quoted original so the model sees only the reply", () => {
    const body = "Yes\n\nOn Tue, 22 Sept 2026, Paul Madut wrote:\n> Might not be relevant";
    expect(withoutQuotedTail(body)).toBe("Yes");
  });

  it("leaves an unquoted reply whole", () => {
    expect(withoutQuotedTail("Yes please send it")).toBe("Yes please send it");
  });
});
