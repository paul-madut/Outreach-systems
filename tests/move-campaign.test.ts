import { describe, expect, it } from "vitest";
import { createTestDb, seedCampaign, seedMessage } from "./helpers/db";
import { moveCampaign, renameMailbox, threadMailboxId } from "@/lib/campaign";
import type { Db } from "@/lib/db";

/**
 * Moving a campaign to a different mailbox.
 *
 * The case this is really about: Paul stops sending payments outreach from
 * his personal iCloud address and moves it to a domain bought for it. Mail is
 * already queued, and some of it belongs to conversations that have started.
 */

function secondMailbox(db: Db): number {
  const row = db
    .prepare(
      `insert into mailboxes
         (label, from_name, from_email, provider, smtp_host, smtp_user,
          imap_host, imap_user, keychain_service, keychain_account, timezone)
       values ('pwp-1', 'Paul Madut', 'paul@paulecom.com', 'gmail',
               'smtp.gmail.com', 'paul@paulecom.com',
               'imap.gmail.com', 'paul@paulecom.com',
               'gmail-smtp-outreach', 'paul@paulecom.com', 'UTC')`
    )
    .run();
  return Number(row.lastInsertRowid);
}

function mailboxOf(db: Db, messageId: number): number {
  return (db.prepare("select mailbox_id from messages where id = ?").get(messageId) as {
    mailbox_id: number;
  }).mailbox_id;
}

describe("moveCampaign", () => {
  it("repoints the campaign and everything it has queued", () => {
    const db = createTestDb();
    const seeded = seedCampaign(db);
    const target = secondMailbox(db);

    const draft = seedMessage(db, seeded, { status: "draft" });
    const scheduled = seedMessage(db, seeded, { status: "scheduled" });

    const result = moveCampaign(db, seeded.campaignId, target);

    expect(result).toEqual({ moved: 2, keptOnThread: 0 });
    expect(mailboxOf(db, draft.messageId)).toBe(target);
    expect(mailboxOf(db, scheduled.messageId)).toBe(target);
    expect(
      (db.prepare("select mailbox_id from campaigns where id = ?").get(seeded.campaignId) as {
        mailbox_id: number;
      }).mailbox_id
    ).toBe(target);
  });

  it("leaves a follow-up on the mailbox that started its thread", () => {
    const db = createTestDb();
    const seeded = seedCampaign(db);
    const target = secondMailbox(db);

    // Step 1 already went out from the original mailbox.
    const first = seedMessage(db, seeded, { status: "sent" });
    const followUp = db
      .prepare(
        `insert into messages
           (mailbox_id, enrollment_id, step_number, to_email, subject, body,
            message_id, status)
         values (?, ?, 2, 'a@store.com', 'Re: x', 'body', '<follow@x>', 'draft')`
      )
      .run(seeded.mailboxId, first.enrollmentId);

    const result = moveCampaign(db, seeded.campaignId, target);

    expect(result).toEqual({ moved: 0, keptOnThread: 1 });
    expect(mailboxOf(db, Number(followUp.lastInsertRowid))).toBe(seeded.mailboxId);
  });

  it("never rewrites what already went out", () => {
    const db = createTestDb();
    const seeded = seedCampaign(db);
    const target = secondMailbox(db);

    const sent = seedMessage(db, seeded, { status: "sent" });
    const cancelled = seedMessage(db, seeded, { status: "cancelled" });

    moveCampaign(db, seeded.campaignId, target);

    expect(mailboxOf(db, sent.messageId)).toBe(seeded.mailboxId);
    expect(mailboxOf(db, cancelled.messageId)).toBe(seeded.mailboxId);
  });

  it("refuses a mailbox that does not exist", () => {
    const db = createTestDb();
    const seeded = seedCampaign(db);
    expect(() => moveCampaign(db, seeded.campaignId, 999)).toThrow();
  });
});

describe("threadMailboxId", () => {
  it("is null until something has actually gone out", () => {
    const db = createTestDb();
    const seeded = seedCampaign(db);
    const message = seedMessage(db, seeded, { status: "scheduled" });

    expect(threadMailboxId(db, message.enrollmentId)).toBeNull();
  });

  it("is the mailbox of the first message that left", () => {
    const db = createTestDb();
    const seeded = seedCampaign(db);
    const message = seedMessage(db, seeded, { status: "sent" });

    expect(threadMailboxId(db, message.enrollmentId)).toBe(seeded.mailboxId);
  });

  // A send whose outcome is unknown may well have arrived, so the thread is
  // treated as started. Continuing it from a different address would be the
  // worse of the two mistakes.
  it("counts an uncertain send as having started the thread", () => {
    const db = createTestDb();
    const seeded = seedCampaign(db);
    const message = seedMessage(db, seeded, { status: "uncertain" });

    expect(threadMailboxId(db, message.enrollmentId)).toBe(seeded.mailboxId);
  });
});

describe("renameMailbox", () => {
  it("changes the label and nothing else", () => {
    const db = createTestDb();
    const seeded = seedCampaign(db);

    renameMailbox(db, seeded.mailboxId, "jobs");

    const row = db
      .prepare("select label, from_email from mailboxes where id = ?")
      .get(seeded.mailboxId) as { label: string; from_email: string };
    expect(row.label).toBe("jobs");
    expect(row.from_email).toBe("paul@example.com");
  });
});
