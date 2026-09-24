import { describe, expect, it } from "vitest";
import {
  ALERTED,
  alertText,
  escapeSlack,
  truncate,
  withoutQuotedTail,
  type AlertableInbound,
} from "@/lib/notify/inbound-alert";

const row = (over: Partial<AlertableInbound> = {}): AlertableInbound => ({
  id: 1,
  classification: "reply",
  from_email: "auspeplabs@gmail.com",
  subject: "Re: Quick question about Auspep Labs",
  snippet: "Yes",
  received_at: "2026-09-23T02:57:20.000Z",
  mailbox_label: "jobs",
  company: "Auspep Labs",
  campaign: "high-risk payments",
  ...over,
});

describe("what gets announced", () => {
  it("covers everything that matched real outreach", () => {
    expect([...ALERTED].sort()).toEqual(["auto_reply", "bounce", "reply", "unsubscribe"]);
  });

  // The unmatched bucket is whatever else lands in the mailbox. While `jobs`
  // is Paul's personal iCloud address that is his personal mail, and there
  // were 177 of those against 2 real replies.
  it("leaves the unmatched bucket alone", () => {
    expect(ALERTED.has("unmatched")).toBe(false);
  });
});

describe("alertText", () => {
  it("leads with what happened and who it was", () => {
    const text = alertText(row());
    expect(text.split("\n")[0]).toBe(
      "*Reply* from auspeplabs@gmail.com (Auspep Labs - high-risk payments)"
    );
  });

  it("quotes the body so a long reply stays one unit", () => {
    const text = alertText(row({ snippet: "Yes\nsend it over" }));
    expect(text).toContain("> Yes\n> send it over");
  });

  it("names the mailbox, because three of them send now", () => {
    expect(alertText(row({ mailbox_label: "pwp-2" }))).toContain("_via pwp-2_");
  });

  it("copes with no company and no campaign", () => {
    const text = alertText(row({ company: null, campaign: null }));
    expect(text.split("\n")[0]).toBe("*Reply* from auspeplabs@gmail.com");
  });

  it("labels an opt-out as one", () => {
    expect(alertText(row({ classification: "unsubscribe" }))).toContain("*Opt-out*");
  });
});

describe("snippet handling", () => {
  // A one-word answer above four hundred characters of quoted history reads
  // in Slack as a wall of Paul's own email with the reply lost at the top.
  it("drops the quoted original", () => {
    const body = 'Yes\n\nOn Tue, 22 Sept 2026, Paul Madut wrote:\n> Might not be relevant, but';
    expect(withoutQuotedTail(body)).toBe("Yes");
  });

  it("drops a bare quoted block too", () => {
    expect(withoutQuotedTail("Sounds good\n\n> original text here")).toBe("Sounds good");
  });

  it("leaves an unquoted reply whole", () => {
    expect(withoutQuotedTail("Yes please send it")).toBe("Yes please send it");
  });

  it("escapes what Slack would read as markup", () => {
    expect(escapeSlack("<b> & </b>")).toBe("&lt;b&gt; &amp; &lt;/b&gt;");
  });

  it("truncates with an ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc...");
  });
});
