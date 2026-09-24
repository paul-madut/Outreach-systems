import { describe, expect, it } from "vitest";
import { buildReplyContext } from "@/lib/reply/context";
import { createTestDb, seedCampaign, seedMessage } from "./helpers/db";
import { upsertStep } from "@/lib/campaign";
import type { Db } from "@/lib/db";

function seedInbound(db: Db, messageId: number, over: Record<string, unknown> = {}): number {
  const row = db
    .prepare(
      `insert into inbound_messages
         (mailbox_id, from_email, subject, snippet, classification, matched_message_id)
       values (1, ?, ?, ?, 'reply', ?)`
    )
    .run(
      over.from ?? "ws@store.com",
      over.subject ?? "Re: Quick question",
      over.snippet ?? "Yes, send it over",
      messageId
    );
  return Number(row.lastInsertRowid);
}

describe("buildReplyContext", () => {
  it("gathers the campaign, the sent message and the prospect", () => {
    const db = createTestDb();
    const seeded = seedCampaign(db);
    upsertStep(db, {
      campaignId: seeded.campaignId,
      stepNumber: 1,
      delayDays: 0,
      subjectTemplate: "Quick question about {{company}}",
      bodyTemplate: "Might not be relevant, but your page says...",
    });
    const message = seedMessage(db, seeded, { status: "sent" });
    const inboundId = seedInbound(db, message.messageId);

    const context = buildReplyContext(db, inboundId);

    expect(context.campaignName).toBe("high-risk payments");
    expect(context.campaignTemplate).toBe("Might not be relevant, but your page says...");
    expect(context.company).toBe("Otie's Botanicals");
    expect(context.vertical).toBe("kratom");
    expect(context.inboundBody).toBe("Yes, send it over");
  });

  // The research is the only thing that makes a reply specific rather than
  // generic, and it lives in free-text columns off the import.
  it("flattens the prospect research into readable keys", () => {
    const db = createTestDb();
    const seeded = seedCampaign(db);
    const message = seedMessage(db, seeded, { status: "sent" });
    const inboundId = seedInbound(db, message.messageId);

    expect(buildReplyContext(db, inboundId).research).toMatchObject({
      payment_methods_today: "Bitcoin, Ethereum",
    });
  });

  it("strips the quoted original from what they wrote", () => {
    const db = createTestDb();
    const seeded = seedCampaign(db);
    const message = seedMessage(db, seeded, { status: "sent" });
    const inboundId = seedInbound(db, message.messageId, {
      snippet: "Yes\n\nOn Tue, Paul Madut wrote:\n> the whole original email",
    });

    expect(buildReplyContext(db, inboundId).inboundBody).toBe("Yes");
  });

  it("returns prior attempts in order, so a reroll sees them all", () => {
    const db = createTestDb();
    const seeded = seedCampaign(db);
    const message = seedMessage(db, seeded, { status: "sent" });
    const inboundId = seedInbound(db, message.messageId);

    for (const [attempt, body] of [
      [1, "first draft"],
      [2, "second draft"],
    ] as const) {
      db.prepare(
        "insert into reply_suggestions (inbound_id, attempt, body, model) values (?, ?, ?, 'test')"
      ).run(inboundId, attempt, body);
    }

    expect(buildReplyContext(db, inboundId).priorAttempts).toEqual([
      "first draft",
      "second draft",
    ]);
  });

  // An unmatched message has no campaign and no sent message behind it, and
  // it is still worth drafting a reply to.
  it("works for a message that matched nothing", () => {
    const db = createTestDb();
    seedCampaign(db);
    const row = db
      .prepare(
        `insert into inbound_messages (mailbox_id, from_email, subject, snippet, classification)
         values (1, 'someone@else.com', 'Hello', 'Are you taking clients?', 'unmatched')`
      )
      .run();

    const context = buildReplyContext(db, Number(row.lastInsertRowid));
    expect(context.campaignName).toBeNull();
    expect(context.sentBody).toBeNull();
    expect(context.inboundBody).toBe("Are you taking clients?");
  });

  it("refuses an id that does not exist", () => {
    expect(() => buildReplyContext(createTestDb(), 999)).toThrow(/No inbound message/);
  });
});
