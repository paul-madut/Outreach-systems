import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blockingReason } from "@/lib/reply/send";
import { addSuppression } from "@/lib/suppressions";
import { createTestDb, seedCampaign, seedMessage } from "./helpers/db";
import type { Db } from "@/lib/db";

/**
 * The refusals, which are the whole point.
 *
 * Sending a reply is the one thing in the interface that reaches a real
 * person outside the worker's pacing, so what stops it matters more than
 * what it does when it goes.
 */

const inbound = (over: Record<string, unknown> = {}) =>
  ({ id: 1, from_email: "ws@store.com", classification: "reply", ...over }) as never;

let db: Db;

beforeEach(() => {
  db = createTestDb();
  process.env.OUTREACH_LIVE = "1";
});

afterEach(() => {
  delete process.env.OUTREACH_LIVE;
});

describe("blockingReason", () => {
  it("lets a normal reply through", () => {
    expect(blockingReason(db, inbound(), "Thanks, sending it over today.")).toBeNull();
  });

  // The flag exists to stop a dev run emailing a prospect, and a reply is a
  // message to a prospect like any other.
  it("refuses when live sending is off", () => {
    delete process.env.OUTREACH_LIVE;
    expect(blockingReason(db, inbound(), "Anything")).toMatch(/Live sending is off/);
  });

  it("refuses an empty reply", () => {
    expect(blockingReason(db, inbound(), "   ")).toBe("The reply is empty.");
  });

  // Paul's hard rule, and the same gate every outgoing message passes.
  it("refuses an em dash", () => {
    expect(blockingReason(db, inbound(), "Sure — sending it over.")).toMatch(/dash/i);
  });

  // Somebody who opted out does not get a reply, however well meant.
  it("refuses a recipient on the do-not-contact list", () => {
    addSuppression(db, "email", "ws@store.com", "Replied stop", "test");
    expect(blockingReason(db, inbound(), "Thanks for letting me know.")).toMatch(
      /do-not-contact list/
    );
  });

  it("refuses a domain-level suppression too", () => {
    addSuppression(db, "domain", "store.com", "Bounced", "test");
    expect(blockingReason(db, inbound(), "Hello there.")).toMatch(/do-not-contact/);
  });

  describe("when something already went", () => {
    function recordReply(status: string) {
      const seeded = seedCampaign(db);
      const message = seedMessage(db, seeded, { status: "sent" });
      const row = db
        .prepare(
          `insert into inbound_messages (mailbox_id, from_email, classification, matched_message_id)
           values (1, 'ws@store.com', 'reply', ?)`
        )
        .run(message.messageId);
      const inboundId = Number(row.lastInsertRowid);

      db.prepare(
        `insert into sent_replies
           (inbound_id, mailbox_id, to_email, subject, body, message_id, status)
         values (?, ?, 'ws@store.com', 'Re: x', 'body', ?, ?)`
      ).run(inboundId, seeded.mailboxId, `<reply-${status}@x>`, status);

      return inboundId;
    }

    it("refuses a second send", () => {
      const id = recordReply("sent");
      expect(blockingReason(db, inbound({ id }), "Again")).toMatch(/already been sent/);
    });

    // An unknown outcome may well have arrived. Sending again to find out is
    // the worse of the two mistakes.
    it("refuses while an outcome is unknown", () => {
      const id = recordReply("uncertain");
      expect(blockingReason(db, inbound({ id }), "Again")).toMatch(/already in flight|unknown/);
    });

    it("allows a retry after a send that definitely failed", () => {
      const id = recordReply("failed");
      expect(blockingReason(db, inbound({ id }), "Trying again")).toBeNull();
    });
  });
});
