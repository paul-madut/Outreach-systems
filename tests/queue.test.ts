import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import {
  claimDueMessages,
  markSent,
  markUncertain,
  releaseMessage,
  stopEnrollment,
  sweepOrphans,
  usedToday,
} from "@/lib/worker/claim";
import {
  createTestDb,
  resetPacing,
  seedCampaign,
  seedFollowUp,
  seedMessage,
  statusOf,
} from "./helpers/db";

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

describe("schema", () => {
  it("applies cleanly", () => {
    const tables = db
      .prepare(
        `select name from sqlite_master
          where type = 'table' and name not like 'sqlite_%' order by name`
      )
      .all() as { name: string }[];

    expect(tables.map((t) => t.name)).toEqual([
      "campaigns",
      "contacts",
      "enrollments",
      "imap_cursors",
      "imports",
      "inbound_messages",
      "mailboxes",
      "messages",
      "prospects",
      "sequence_steps",
      "suppressions",
    ]);
  });

  it("dedupes prospects on domain, and domainless ones on company key", () => {
    seedCampaign(db);

    expect(() =>
      db
        .prepare("insert into prospects (company, domain) values ('Otie again', ?)")
        .run("otiesbotanicals.com")
    ).toThrow();

    db.prepare("insert into prospects (company, company_key) values ('No Domain', 'no-domain')").run();

    // A plain nullable unique index would have allowed this second one.
    expect(() =>
      db
        .prepare("insert into prospects (company, company_key) values ('No Domain', 'no-domain')")
        .run()
    ).toThrow();
  });

  it("refuses an email-channel contact with no address", () => {
    const seeded = seedCampaign(db);
    expect(() =>
      db
        .prepare("insert into contacts (prospect_id, channel) values (?, 'email')")
        .run(seeded.prospectId)
    ).toThrow();
  });

  it("dedupes contacts on email regardless of case", () => {
    const seeded = seedCampaign(db);
    db.prepare("insert into contacts (prospect_id, email, channel) values (?, ?, 'email')").run(
      seeded.prospectId,
      "support@store.com"
    );

    expect(() =>
      db
        .prepare("insert into contacts (prospect_id, email, channel) values (?, ?, 'email')")
        .run(seeded.prospectId, "Support@Store.com")
    ).toThrow();
  });

  it("enforces one enrollment per contact per campaign", () => {
    const seeded = seedCampaign(db);
    const { contactId } = seedMessage(db, seeded);

    expect(() =>
      db
        .prepare("insert into enrollments (campaign_id, contact_id) values (?, ?)")
        .run(seeded.campaignId, contactId)
    ).toThrow();
  });

  it("enforces one message per step per enrollment", () => {
    // This is what makes an "ensure next steps" pass safe to re-run.
    const seeded = seedCampaign(db);
    const { enrollmentId } = seedMessage(db, seeded);

    expect(() => seedFollowUp(db, seeded, enrollmentId, { stepNumber: 1 })).toThrow();
  });

  it("rejects an inverted send window", () => {
    const seeded = seedCampaign(db);
    expect(() =>
      db
        .prepare("update campaigns set window_start = '17:00', window_end = '09:00' where id = ?")
        .run(seeded.campaignId)
    ).toThrow();
  });

  it("requires a scheduled message to have a time", () => {
    const seeded = seedCampaign(db);
    expect(() => seedMessage(db, seeded, { scheduledAt: null })).toThrow();
  });
});

describe("claimDueMessages", () => {
  it("claims a due message", () => {
    const seeded = seedCampaign(db);
    const { messageId } = seedMessage(db, seeded);

    const claimed = claimDueMessages(db, { limit: 10 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(messageId);
    expect(claimed[0].attempts).toBe(1);
    expect(statusOf(db, messageId)).toBe("sending");
  });

  it("never returns the same message twice", () => {
    const seeded = seedCampaign(db);
    seedMessage(db, seeded);

    expect(claimDueMessages(db, { limit: 10 })).toHaveLength(1);
    resetPacing(db, seeded.mailboxId);
    expect(claimDueMessages(db, { limit: 10 })).toHaveLength(0);
  });

  it("does not claim a message scheduled in the future", () => {
    const seeded = seedCampaign(db);
    seedMessage(db, seeded, { scheduledAt: new Date(Date.now() + 3_600_000) });
    expect(claimDueMessages(db, { limit: 10 })).toHaveLength(0);
  });

  it("does not claim a draft awaiting review", () => {
    const seeded = seedCampaign(db);
    seedMessage(db, seeded, { status: "draft" });
    expect(claimDueMessages(db, { limit: 10 })).toHaveLength(0);
  });

  it("respects the mailbox daily cap", () => {
    const seeded = seedCampaign(db, { dailyCap: 2 });
    for (let i = 0; i < 5; i += 1) seedMessage(db, seeded);

    expect(claimDueMessages(db, { limit: 10 })).toHaveLength(2);

    // In-flight work still counts, so a second tick finds no room.
    resetPacing(db, seeded.mailboxId);
    expect(claimDueMessages(db, { limit: 10 })).toHaveLength(0);
  });

  it("counts sent messages against the cap", () => {
    const seeded = seedCampaign(db, { dailyCap: 2 });
    const first = seedMessage(db, seeded);
    seedMessage(db, seeded);
    seedMessage(db, seeded);

    claimDueMessages(db, { limit: 1 });
    markSent(db, first.messageId, "250 ok");

    resetPacing(db, seeded.mailboxId);
    // One sent plus one still in flight fills a cap of 2.
    expect(claimDueMessages(db, { limit: 10 })).toHaveLength(1);
  });

  it("honours the per-tick limit", () => {
    const seeded = seedCampaign(db);
    for (let i = 0; i < 5; i += 1) seedMessage(db, seeded);
    expect(claimDueMessages(db, { limit: 1 })).toHaveLength(1);
  });

  it("skips a paused mailbox", () => {
    const seeded = seedCampaign(db, { mailboxStatus: "paused" });
    seedMessage(db, seeded);
    expect(claimDueMessages(db, { limit: 10 })).toHaveLength(0);
  });

  it("skips a paused campaign", () => {
    const seeded = seedCampaign(db, { campaignStatus: "paused" });
    seedMessage(db, seeded);
    expect(claimDueMessages(db, { limit: 10 })).toHaveLength(0);
  });

  it("skips an enrollment that already replied", () => {
    const seeded = seedCampaign(db);
    const { enrollmentId } = seedMessage(db, seeded);
    db.prepare("update enrollments set status = 'replied' where id = ?").run(enrollmentId);

    expect(claimDueMessages(db, { limit: 10 })).toHaveLength(0);
  });

  it("will not send outside the campaign window", () => {
    const seeded = seedCampaign(db, {
      timezone: "UTC",
      windowStart: "09:00",
      windowEnd: "16:00",
    });
    seedMessage(db, seeded);

    // 03:00 UTC is outside a 09:00-16:00 UTC window.
    const beforeOpen = new Date("2026-09-21T03:00:00Z");
    expect(claimDueMessages(db, { limit: 10, now: beforeOpen })).toHaveLength(0);

    const insideWindow = new Date("2026-09-21T10:00:00Z");
    expect(claimDueMessages(db, { limit: 10, now: insideWindow })).toHaveLength(1);
  });

  it("will not send on a day the campaign excludes", () => {
    // 2026-09-21 is a Monday, 2026-09-20 a Sunday.
    const seeded = seedCampaign(db, { timezone: "UTC", sendDays: [1, 2, 3, 4, 5] });
    seedMessage(db, seeded);

    expect(
      claimDueMessages(db, { limit: 10, now: new Date("2026-09-20T10:00:00Z") })
    ).toHaveLength(0);
    expect(
      claimDueMessages(db, { limit: 10, now: new Date("2026-09-21T10:00:00Z") })
    ).toHaveLength(1);
  });

  it("reads the window in the campaign's own timezone", () => {
    const seeded = seedCampaign(db, {
      timezone: "America/Toronto",
      windowStart: "09:00",
      windowEnd: "16:00",
    });
    seedMessage(db, seeded);

    // 13:00 UTC is 09:00 in Toronto during EDT, so this is just inside.
    expect(
      claimDueMessages(db, { limit: 10, now: new Date("2026-09-21T13:30:00Z") })
    ).toHaveLength(1);
  });

  it("paces the mailbox after a claim", () => {
    const seeded = seedCampaign(db, { minGapSeconds: 120, gapJitterSeconds: 0 });
    seedMessage(db, seeded);
    seedMessage(db, seeded);

    expect(claimDueMessages(db, { limit: 1 })).toHaveLength(1);
    // No reset: the gate must hold the next tick off by itself.
    expect(claimDueMessages(db, { limit: 1 })).toHaveLength(0);
  });

  it("prefers follow-ups over new first touches", () => {
    const seeded = seedCampaign(db);
    seedMessage(db, seeded);
    const withFollowUp = seedMessage(db, seeded);
    seedFollowUp(db, seeded, withFollowUp.enrollmentId);

    const claimed = claimDueMessages(db, { limit: 1 });
    expect(claimed[0].step_number).toBe(2);
  });
});

describe("usedToday", () => {
  it("counts against the mailbox's local day, not UTC", () => {
    // 01:00 UTC on the 21st is 21:00 on the 20th in Toronto, so a send then
    // belongs to the 20th and must not consume the 21st's quota.
    const seeded = seedCampaign(db, { timezone: "America/Toronto" });
    const { messageId } = seedMessage(db, seeded);

    db.prepare("update messages set status = 'sent', sent_at = ? where id = ?").run(
      "2026-09-21T01:00:00.000Z",
      messageId
    );

    const mailbox = db
      .prepare("select * from mailboxes where id = ?")
      .get(seeded.mailboxId) as never;

    expect(usedToday(db, mailbox, new Date("2026-09-21T02:00:00Z"))).toBe(1);
    expect(usedToday(db, mailbox, new Date("2026-09-21T16:00:00Z"))).toBe(0);
  });
});

describe("sweepOrphans", () => {
  it("moves a dead worker's in-flight rows to uncertain, not back to scheduled", () => {
    const seeded = seedCampaign(db);
    const { messageId } = seedMessage(db, seeded);
    claimDueMessages(db, { limit: 1 });

    expect(sweepOrphans(db)).toBe(1);
    expect(statusOf(db, messageId)).toBe("uncertain");

    // The whole point: an ambiguous send is never silently resent.
    resetPacing(db, seeded.mailboxId);
    expect(claimDueMessages(db, { limit: 10 })).toHaveLength(0);
  });

  it("leaves everything else alone", () => {
    const seeded = seedCampaign(db);
    const { messageId } = seedMessage(db, seeded);
    expect(sweepOrphans(db)).toBe(0);
    expect(statusOf(db, messageId)).toBe("scheduled");
  });
});

describe("markSent", () => {
  it("marks sent and advances the enrollment", () => {
    const seeded = seedCampaign(db);
    const { messageId, enrollmentId } = seedMessage(db, seeded);
    claimDueMessages(db, { limit: 1 });

    expect(markSent(db, messageId, "250 queued")).toBe(true);
    expect(statusOf(db, messageId)).toBe("sent");

    const enrollment = db
      .prepare("select current_step, last_sent_at from enrollments where id = ?")
      .get(enrollmentId) as { current_step: number; last_sent_at: string };

    expect(enrollment.current_step).toBe(1);
    expect(enrollment.last_sent_at).toBeTruthy();
  });

  it("can resolve an uncertain row by hand", () => {
    const seeded = seedCampaign(db);
    const { messageId } = seedMessage(db, seeded);
    claimDueMessages(db, { limit: 1 });
    markUncertain(db, messageId, "socket closed after DATA");

    expect(statusOf(db, messageId)).toBe("uncertain");
    expect(markSent(db, messageId, "confirmed in Sent folder")).toBe(true);
    expect(statusOf(db, messageId)).toBe("sent");
  });

  it("refuses a message that was never claimed", () => {
    const seeded = seedCampaign(db);
    const { messageId } = seedMessage(db, seeded);
    expect(markSent(db, messageId, "250 ok")).toBe(false);
  });
});

describe("releaseMessage", () => {
  it("reschedules with backoff below the attempt limit", () => {
    const seeded = seedCampaign(db);
    const { messageId } = seedMessage(db, seeded);
    claimDueMessages(db, { limit: 1 });

    expect(releaseMessage(db, messageId, "451 try later")).toBe("scheduled");
    expect(statusOf(db, messageId)).toBe("scheduled");

    // The backoff has to put it out of reach of the very next tick.
    resetPacing(db, seeded.mailboxId);
    expect(claimDueMessages(db, { limit: 10 })).toHaveLength(0);
  });

  it("fails permanently at the attempt limit", () => {
    const seeded = seedCampaign(db);
    const { messageId } = seedMessage(db, seeded);
    claimDueMessages(db, { limit: 1 });
    db.prepare("update messages set attempts = 3 where id = ?").run(messageId);

    expect(releaseMessage(db, messageId, "550 rejected")).toBe("failed");
    expect(statusOf(db, messageId)).toBe("failed");
  });
});

describe("stopEnrollment", () => {
  it("cancels queued steps but not one already in flight", () => {
    const seeded = seedCampaign(db);
    const { enrollmentId, messageId } = seedMessage(db, seeded);
    const followUpId = seedFollowUp(db, seeded, enrollmentId, {
      scheduledAt: new Date(Date.now() + 3 * 86_400_000),
    });

    claimDueMessages(db, { limit: 1 });

    expect(stopEnrollment(db, enrollmentId, "replied", "Replied 2026-09-20")).toBe(1);
    expect(statusOf(db, followUpId)).toBe("cancelled");
    // In flight and beyond recall. Cancelling would misreport what was sent.
    expect(statusOf(db, messageId)).toBe("sending");
  });

  it("cancels drafts too", () => {
    const seeded = seedCampaign(db);
    const { enrollmentId } = seedMessage(db, seeded, { status: "draft" });
    expect(stopEnrollment(db, enrollmentId, "stopped", "manual")).toBe(1);
  });
});
