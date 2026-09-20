import { describe, expect, it } from "vitest";
import {
  classifyInbound,
  senderAddress,
  unquotedText,
  type InboundMessage,
} from "@/lib/mail/classify-inbound";
import { messageIdsIn, parseDsn } from "@/lib/mail/parse-dsn";
import { matchInbound, type SentLookup } from "@/lib/mail/match-inbound";
import { isFreemailDomain } from "@/lib/mail/freemail-domains";

function message(partial: Partial<InboundMessage> & { from?: string }): InboundMessage {
  const { from, headers, ...rest } = partial;
  return {
    headers: { from: from ?? "someone@store.com", ...headers },
    text: "",
    ...rest,
  };
}

describe("parseDsn", () => {
  it("reads a standard RFC 3464 report", () => {
    const dsn = parseDsn(
      [
        "Final-Recipient: rfc822; support@deadstore.com",
        "Action: failed",
        "Status: 5.1.1",
        "Diagnostic-Code: smtp; 550 5.1.1 <support@deadstore.com> User unknown",
      ].join("\n")
    );

    expect(dsn.status).toBe("5.1.1");
    expect(dsn.action).toBe("failed");
    expect(dsn.recipient).toBe("support@deadstore.com");
    expect(dsn.hard).toBe(true);
    expect(dsn.soft).toBe(false);
  });

  it("separates a soft bounce from a hard one", () => {
    const dsn = parseDsn("Action: delayed\nStatus: 4.2.2\n");
    expect(dsn.soft).toBe(true);
    expect(dsn.hard).toBe(false);
  });

  it("falls back to a code embedded in Exchange prose", () => {
    const dsn = parseDsn(
      "Your message couldn't be delivered. Remote server returned 5.4.1 Recipient address rejected."
    );
    expect(dsn.status).toBe("5.4.1");
    expect(dsn.hard).toBe(true);
  });

  it("normalises a bare SMTP code", () => {
    const dsn = parseDsn("The mail system responded: 550 relay not permitted\n");
    expect(dsn.status).toBe("5.0.0");
    expect(dsn.hard).toBe(true);
  });

  it("strips angle brackets from the recipient", () => {
    const dsn = parseDsn("Final-Recipient: rfc822; <Support@Store.COM>\nStatus: 5.1.1");
    expect(dsn.recipient).toBe("support@store.com");
  });

  it("returns nulls when there is nothing to parse", () => {
    const dsn = parseDsn("hello there");
    expect(dsn.status).toBeNull();
    expect(dsn.hard).toBe(false);
    expect(dsn.soft).toBe(false);
  });
});

describe("messageIdsIn", () => {
  it("pulls quoted ids out of a bounce body", () => {
    const ids = messageIdsIn(
      "Original message headers:\nMessage-ID: <abc123@mail.example.com>\nTo: x@y.com"
    );
    expect(ids).toContain("<abc123@mail.example.com>");
  });
});

describe("unquotedText", () => {
  it("drops > quoted history", () => {
    const body = "No thanks.\n\n> On Tuesday Paul wrote:\n> unsubscribe me";
    expect(unquotedText(body)).not.toContain("unsubscribe");
  });

  it("stops at the On ... wrote: separator", () => {
    const body = "Not interested.\nOn Mon, Sep 21, 2026 at 9:00 AM Paul Madut wrote:\nunsubscribe";
    expect(unquotedText(body)).not.toContain("unsubscribe");
  });

  it("stops at an Original Message separator", () => {
    const body = "Nope.\n----- Original Message -----\nunsubscribe";
    expect(unquotedText(body)).not.toContain("unsubscribe");
  });
});

describe("classifyInbound", () => {
  it("classifies a multipart delivery-status report as a bounce", () => {
    const result = classifyInbound(
      message({
        from: "MAILER-DAEMON@mx.google.com",
        headers: {
          from: "MAILER-DAEMON@mx.google.com",
          subject: "Delivery Status Notification (Failure)",
          contentType: 'multipart/report; report-type=delivery-status; boundary="x"',
          returnPath: "<>",
        },
        text: "Address not found",
        raw: "Final-Recipient: rfc822; support@deadstore.com\nAction: failed\nStatus: 5.1.1",
      })
    );

    expect(result.classification).toBe("bounce");
    expect(result.dsn?.hard).toBe(true);
    expect(result.suppress).toBe("support@deadstore.com");
  });

  it("does not suppress on a soft bounce", () => {
    const result = classifyInbound(
      message({
        headers: {
          from: "postmaster@store.com",
          subject: "Delayed delivery",
          contentType: "multipart/report; report-type=delivery-status",
        },
        text: "will retry",
        raw: "Final-Recipient: rfc822; support@store.com\nAction: delayed\nStatus: 4.2.2",
      })
    );

    expect(result.classification).toBe("bounce");
    expect(result.dsn?.soft).toBe(true);
    expect(result.suppress).toBeUndefined();
  });

  it("detects an Exchange NDR with no report content type", () => {
    const result = classifyInbound(
      message({
        headers: {
          from: "postmaster@corp.example.com",
          subject: "Undeliverable: Quick question",
        },
        text: "Your message to support@corp.example.com couldn't be delivered. 5.1.1",
      })
    );

    expect(result.classification).toBe("bounce");
  });

  it("reads a null Return-Path as a notification", () => {
    const result = classifyInbound(
      message({
        headers: { from: "weird-bounce@relay.net", returnPath: "<>", subject: "problem" },
        text: "550 5.1.1 unknown",
      })
    );
    expect(result.classification).toBe("bounce");
  });

  it("classifies an out-of-office as an auto reply and keeps the sequence alive", () => {
    const result = classifyInbound(
      message({
        headers: {
          from: "owner@store.com",
          subject: "Automatic reply: Quick question",
          autoSubmitted: "auto-replied",
        },
        text: "I am out of the office until Monday.",
      })
    );

    expect(result.classification).toBe("auto_reply");
    expect(result.suppress).toBeUndefined();
  });

  it("classifies a helpdesk ticket acknowledgement as an auto reply", () => {
    // The failure that matters: most prospects are support@ addresses behind a
    // helpdesk, and a ticket receipt must not look like a human answer.
    const result = classifyInbound(
      message({
        headers: { from: "support@store.com", subject: "[Ticket #48219] Quick question" },
        text: "Thanks for contacting us. We have received your message and will reply shortly.",
      })
    );

    expect(result.classification).toBe("auto_reply");
  });

  it("honours Auto-Submitted: no as a genuine reply", () => {
    const result = classifyInbound(
      message({
        headers: { from: "owner@store.com", subject: "Re: Quick question", autoSubmitted: "no" },
        text: "Sure, send it over.",
      })
    );
    expect(result.classification).toBe("reply");
  });

  it("treats Precedence: bulk as automated", () => {
    const result = classifyInbound(
      message({
        headers: { from: "news@store.com", subject: "Newsletter", precedence: "bulk" },
        text: "This month at the store",
      })
    );
    expect(result.classification).toBe("auto_reply");
  });

  it("treats a List-Id as a mailing list, not a reply", () => {
    const result = classifyInbound(
      message({
        headers: { from: "list@store.com", subject: "Digest", listId: "<news.store.com>" },
        text: "Weekly digest",
      })
    );
    expect(result.classification).toBe("auto_reply");
  });

  it("classifies an opt-out and suppresses the sender", () => {
    const result = classifyInbound(
      message({
        headers: { from: "Owner <owner@store.com>", subject: "Re: Quick question" },
        text: "Please remove me from your list.",
      })
    );

    expect(result.classification).toBe("unsubscribe");
    expect(result.suppress).toBe("owner@store.com");
  });

  it("does not read Paul's own quoted footer as an opt-out", () => {
    const result = classifyInbound(
      message({
        headers: { from: "owner@store.com", subject: "Re: Quick question" },
        text: "Yes let's talk.\n\n> Reply unsubscribe and I will not email again.",
      })
    );

    expect(result.classification).toBe("reply");
  });

  it("prefers auto_reply over an unsubscribe word in a vacation footer", () => {
    const result = classifyInbound(
      message({
        headers: {
          from: "owner@store.com",
          subject: "Out of office",
          autoSubmitted: "auto-generated",
        },
        text: "Away until Monday. To unsubscribe from these notices, click here.",
      })
    );

    expect(result.classification).toBe("auto_reply");
  });

  it("classifies a plain human reply", () => {
    const result = classifyInbound(
      message({
        headers: { from: "owner@store.com", subject: "Re: Quick question" },
        text: "What would this cost?",
      })
    );

    expect(result.classification).toBe("reply");
  });
});

describe("senderAddress", () => {
  it("strips a display name and lowercases", () => {
    expect(senderAddress("Joel Smith <Joel@Store.com>")).toBe("joel@store.com");
    expect(senderAddress("plain@store.com")).toBe("plain@store.com");
  });
});

describe("isFreemailDomain", () => {
  it("knows consumer domains from company ones", () => {
    expect(isFreemailDomain("gmail.com")).toBe(true);
    expect(isFreemailDomain("OUTLOOK.COM")).toBe(true);
    expect(isFreemailDomain("otiesbotanicals.com")).toBe(false);
  });
});

describe("matchInbound", () => {
  const lookup: SentLookup = {
    byMessageId: new Map([
      ["<step1@outreach.example>", "msg-1"],
      ["<step2@outreach.example>", "msg-2"],
    ]),
    byRecipient: new Map([
      ["support@store.com", ["msg-2", "msg-1"]],
      ["dead@store.com", ["msg-3"]],
    ]),
    byRecipientDomain: new Map([
      ["store.com", ["msg-2", "msg-1"]],
      ["gmail.com", ["msg-9"]],
    ]),
  };

  it("matches on In-Reply-To", () => {
    const hit = matchInbound(
      message({ headers: { from: "x@store.com", inReplyTo: "<step1@outreach.example>" } }),
      lookup
    );
    expect(hit).toEqual({ messageId: "msg-1", method: "in_reply_to" });
  });

  it("walks References newest first", () => {
    const hit = matchInbound(
      message({
        headers: {
          from: "x@store.com",
          references: ["<step1@outreach.example>", "<step2@outreach.example>"],
        },
      }),
      lookup
    );
    expect(hit).toEqual({ messageId: "msg-2", method: "references" });
  });

  it("finds the original id quoted inside a bounce", () => {
    const hit = matchInbound(
      message({
        headers: { from: "MAILER-DAEMON@mx.google.com" },
        raw: "Original headers:\nMessage-ID: <step1@outreach.example>",
      }),
      lookup
    );
    expect(hit).toEqual({ messageId: "msg-1", method: "dsn_body" });
  });

  it("falls back to X-Failed-Recipients", () => {
    const hit = matchInbound(
      message({
        headers: { from: "MAILER-DAEMON@relay.net", xFailedRecipients: "dead@store.com" },
      }),
      lookup
    );
    expect(hit).toEqual({ messageId: "msg-3", method: "failed_recipient" });
  });

  it("falls back to the exact address when headers were stripped", () => {
    const hit = matchInbound(message({ headers: { from: "Support <support@store.com>" } }), lookup);
    expect(hit).toEqual({ messageId: "msg-2", method: "sender_address" });
  });

  it("matches a colleague on the same company domain", () => {
    const hit = matchInbound(message({ headers: { from: "owner@store.com" } }), lookup);
    expect(hit).toEqual({ messageId: "msg-2", method: "sender_domain" });
  });

  it("refuses to match on a freemail domain", () => {
    const hit = matchInbound(message({ headers: { from: "stranger@gmail.com" } }), lookup);
    expect(hit).toBeNull();
  });

  it("ignores a loose match older than the window", () => {
    const now = new Date("2026-09-20T12:00:00Z");
    const hit = matchInbound(
      message({ headers: { from: "support@store.com" } }),
      lookup,
      {
        now,
        looseMatchWindowDays: 45,
        sentAt: new Map([
          ["msg-2", new Date("2026-01-01T00:00:00Z")],
          ["msg-1", new Date("2026-01-01T00:00:00Z")],
        ]),
      }
    );
    expect(hit).toBeNull();
  });

  it("still matches on threading headers outside the loose window", () => {
    const now = new Date("2026-09-20T12:00:00Z");
    const hit = matchInbound(
      message({ headers: { from: "support@store.com", inReplyTo: "<step1@outreach.example>" } }),
      lookup,
      {
        now,
        looseMatchWindowDays: 45,
        sentAt: new Map([["msg-1", new Date("2026-01-01T00:00:00Z")]]),
      }
    );
    expect(hit).toEqual({ messageId: "msg-1", method: "in_reply_to" });
  });

  it("returns null when nothing matches", () => {
    const hit = matchInbound(message({ headers: { from: "nobody@elsewhere.org" } }), lookup);
    expect(hit).toBeNull();
  });
});
