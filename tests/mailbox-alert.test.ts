import { describe, expect, it } from "vitest";
import { pauseAlertText, type PausedMailbox } from "@/lib/notify/mailbox-alert";
import { createTestDb, seedCampaign } from "./helpers/db";
import { setMailboxStatus } from "@/lib/campaign";

const mailbox = (over: Partial<PausedMailbox> = {}): PausedMailbox => ({
  id: 1,
  label: "jobs",
  from_email: "paul.madut@icloud.com",
  paused_reason: "2 failures in a row: getaddrinfo ENOTFOUND smtp.mail.me.com",
  queued: 21,
  ...over,
});

describe("pauseAlertText", () => {
  it("leads with the mailbox, because that is what stopped", () => {
    expect(pauseAlertText(mailbox()).split("\n")[0]).toBe(
      "*Mailbox paused: jobs* (paul.madut@icloud.com)"
    );
  });

  it("quotes the reason the worker recorded", () => {
    expect(pauseAlertText(mailbox())).toContain("> 2 failures in a row: getaddrinfo ENOTFOUND");
  });

  // The count is what makes the urgency legible: a pause is silent otherwise.
  it("says how much is stranded", () => {
    expect(pauseAlertText(mailbox())).toContain("21 messages are waiting");
    expect(pauseAlertText(mailbox({ queued: 1 }))).toContain("1 message is waiting");
  });

  it("carries the command to undo it", () => {
    expect(pauseAlertText(mailbox({ label: "pwp-2" }))).toContain("pnpm mailbox resume pwp-2");
  });

  it("copes with a pause nobody gave a reason for", () => {
    expect(pauseAlertText(mailbox({ paused_reason: null }))).toContain("No reason recorded");
  });
});

describe("the pause marker", () => {
  // Without this a mailbox that pauses, is resumed and pauses again goes
  // quiet the second time, which is the time you most need to hear about it.
  it("is cleared on resume so a second pause announces itself", () => {
    const db = createTestDb();
    const { mailboxId } = seedCampaign(db);

    setMailboxStatus(db, mailboxId, "paused", "first");
    db.prepare("update mailboxes set pause_notified_at = 'x' where id = ?").run(mailboxId);

    setMailboxStatus(db, mailboxId, "active", null);

    const row = db
      .prepare("select pause_notified_at from mailboxes where id = ?")
      .get(mailboxId) as { pause_notified_at: string | null };
    expect(row.pause_notified_at).toBeNull();
  });

  it("survives a re-pause that has not been announced yet", () => {
    const db = createTestDb();
    const { mailboxId } = seedCampaign(db);

    setMailboxStatus(db, mailboxId, "paused", "first");
    db.prepare("update mailboxes set pause_notified_at = 'x' where id = ?").run(mailboxId);
    setMailboxStatus(db, mailboxId, "paused", "still broken");

    const row = db
      .prepare("select pause_notified_at from mailboxes where id = ?")
      .get(mailboxId) as { pause_notified_at: string | null };
    expect(row.pause_notified_at).toBe("x");
  });
});
