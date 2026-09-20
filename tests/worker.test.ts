import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db";
import { createCampaign, createMailbox, setCampaignStatus, upsertStep } from "@/lib/campaign";
import { enrollContacts } from "@/lib/enroll";
import { runSendTick } from "@/lib/worker/send-tick";
import { classifySmtpError } from "@/lib/mail/smtp";
import { applyInbound, buildSentLookup, type PollResult } from "@/lib/worker/poll-mailbox";
import { getMailbox } from "@/lib/campaign";
import type { FetchedMessage } from "@/lib/mail/imap";
import { isSuppressed } from "@/lib/suppressions";
import { createTestDb } from "./helpers/db";

let db: Db;
let mailboxId: number;
let campaignId: number;

/** Monday, inside a 09:00-16:00 UTC window. */
const NOW = new Date("2026-09-21T10:00:00Z");
/** A few minutes later, so a message made due at NOW can be claimed. */
const TICK = new Date("2026-09-21T10:05:00Z");

/**
 * Bring scheduled messages forward so they are due.
 *
 * Enrollment jitters each send somewhere inside the window, which is correct
 * but makes "is it due yet" depend on the RNG. These tests are about the send
 * path, so the slot is pinned instead.
 */
function makeDue(database: Db, at = NOW): void {
  database
    .prepare("update messages set scheduled_at = ? where status = 'scheduled'")
    .run(at.toISOString());
}

function rng() {
  let a = 7;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addProspect(company: string, email: string): number {
  const prospect = db
    .prepare("insert into prospects (company, company_key, domain, grade) values (?, ?, ?, 'A')")
    .run(company, company.toLowerCase(), `${company.toLowerCase()}.com`);
  const contact = db
    .prepare("insert into contacts (prospect_id, email, channel) values (?, ?, 'email')")
    .run(prospect.lastInsertRowid, email);
  return Number(contact.lastInsertRowid);
}

beforeEach(() => {
  vi.stubEnv("OUTREACH_LIVE", "0");
  vi.stubEnv("REDIRECT_ALL_TO", "");

  db = createTestDb();
  mailboxId = createMailbox(db, {
    label: "payments",
    fromName: "Paul Madut",
    fromEmail: "paul@send.example.com",
    provider: "icloud",
    keychainService: "icloud-smtp-outreach",
    keychainAccount: "paul@send.example.com",
    timezone: "UTC",
    dailyCap: 20,
    minGapSeconds: 0,
    gapJitterSeconds: 0,
  });
  campaignId = createCampaign(db, {
    mailboxId,
    name: "payments",
    timezone: "UTC",
    windowStart: "09:00",
    windowEnd: "16:00",
    sendDays: [1, 2, 3, 4, 5],
    newPerDay: 20,
    autoApprove: true,
  });
  upsertStep(db, {
    campaignId,
    stepNumber: 1,
    subjectTemplate: "Quick question",
    bodyTemplate: "About {{company}}.",
  });
  upsertStep(db, {
    campaignId,
    stepNumber: 2,
    delayDays: 3,
    subjectTemplate: "ignored",
    bodyTemplate: "Following up on {{company}}.",
  });
  setCampaignStatus(db, campaignId, "active");
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
});

/** Always succeeds, and records what it was asked to send. */
function recordingSender() {
  const sent: { to: string; subject: string; messageId: string }[] = [];
  return {
    sent,
    send: async (_mailbox: unknown, message: { to: string; subject: string; messageId: string }) => {
      sent.push({ to: message.to, subject: message.subject, messageId: message.messageId });
      return { response: "250 queued" };
    },
  };
}

function smtpError(overrides: Record<string, unknown>): Error {
  return Object.assign(new Error("smtp failure"), overrides);
}

describe("classifySmtpError", () => {
  it("treats any response code as proof nothing was accepted", () => {
    const soft = classifySmtpError(smtpError({ responseCode: 451, response: "451 try later" }));
    expect(soft).toMatchObject({ certainty: "not-sent", permanent: false });

    const hard = classifySmtpError(smtpError({ responseCode: 550, response: "550 no such user" }));
    expect(hard).toMatchObject({ certainty: "not-sent", permanent: true });
  });

  it("flags an authentication failure so the mailbox can be paused", () => {
    expect(classifySmtpError(smtpError({ responseCode: 535 })).authFailure).toBe(true);
    expect(classifySmtpError(smtpError({ code: "EAUTH" })).authFailure).toBe(true);
  });

  it("treats a failure before DATA as definitely not sent", () => {
    for (const command of ["CONN", "EHLO", "STARTTLS", "AUTH", "RCPT TO"]) {
      expect(classifySmtpError(smtpError({ command })).certainty).toBe("not-sent");
    }
  });

  it("treats a dropped socket at DATA as ambiguous", () => {
    // The server may have accepted and queued the message before the
    // connection died. Retrying could deliver it twice.
    const result = classifySmtpError(smtpError({ command: "DATA", code: "ESOCKET" }));
    expect(result.certainty).toBe("ambiguous");
    expect(result.message).toContain("delivery is unknown");
  });
});

describe("runSendTick", () => {
  it("sends nothing when OUTREACH_LIVE is not set", () => {
    addProspect("Otie", "otie@store.com");
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });
    makeDue(db);

    return runSendTick(db, { now: TICK, rng: rng(), limit: 5 }).then((result) => {
      expect(result.live).toBe(false);
      expect(result.sent).toBe(0);
      expect(result.claimed).toBe(1);
      expect(result.notes.join(" ")).toContain("Would have sent");

      const status = db.prepare("select status from messages").get() as { status: string };
      expect(status.status).toBe("scheduled");
    });
  });

  it("sends and records the outcome", async () => {
    addProspect("Otie", "otie@store.com");
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });
    makeDue(db);
    const sender = recordingSender();

    const result = await runSendTick(db, { now: TICK, rng: rng(), sender: sender.send });

    expect(result.sent).toBe(1);
    expect(sender.sent[0].to).toBe("otie@store.com");

    const message = db.prepare("select status, sent_at, smtp_response from messages where step_number = 1").get() as {
      status: string;
      sent_at: string;
      smtp_response: string;
    };
    expect(message.status).toBe("sent");
    expect(message.smtp_response).toBe("250 queued");
  });

  it("queues the follow-up once step 1 has gone out", async () => {
    addProspect("Otie", "otie@store.com");
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });
    makeDue(db);
    const sender = recordingSender();

    const result = await runSendTick(db, { now: TICK, rng: rng(), sender: sender.send });
    expect(result.followUpsCreated).toBe(1);

    const step2 = db.prepare("select status, in_reply_to from messages where step_number = 2").get() as {
      status: string;
      in_reply_to: string;
    };
    expect(step2.in_reply_to).toBe(sender.sent[0].messageId);
  });

  it("reroutes everything to REDIRECT_ALL_TO", async () => {
    vi.stubEnv("REDIRECT_ALL_TO", "paul@example.com");
    addProspect("Otie", "otie@store.com");
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });
    makeDue(db);
    const sender = recordingSender();

    await runSendTick(db, { now: TICK, rng: rng(), sender: sender.send });
    expect(sender.sent[0].to).toBe("paul@example.com");
  });

  it("parks an ambiguous failure rather than retrying it", async () => {
    addProspect("Otie", "otie@store.com");
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });
    makeDue(db);

    const result = await runSendTick(db, {
      now: TICK,
      rng: rng(),
      sender: async () => {
        throw smtpError({ command: "DATA", code: "ESOCKET" });
      },
    });

    expect(result.uncertain).toBe(1);
    const message = db.prepare("select status from messages").get() as { status: string };
    expect(message.status).toBe("uncertain");
  });

  it("reschedules a soft failure", async () => {
    addProspect("Otie", "otie@store.com");
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });
    makeDue(db);

    const result = await runSendTick(db, {
      now: TICK,
      rng: rng(),
      sender: async () => {
        throw smtpError({ responseCode: 451, response: "451 try later" });
      },
    });

    expect(result.released).toBe(1);
    const message = db.prepare("select status from messages").get() as { status: string };
    expect(message.status).toBe("scheduled");
  });

  it("pauses the mailbox on an auth failure and stops the run", async () => {
    // Bad credentials mean every remaining send fails the same way, and
    // grinding through the queue only burns the mailbox.
    for (let i = 0; i < 4; i += 1) addProspect(`Store${i}`, `s${i}@store.com`);
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });
    makeDue(db);

    let attempts = 0;
    const result = await runSendTick(db, {
      now: TICK,
      rng: rng(),
      limit: 4,
      sender: async () => {
        attempts += 1;
        throw smtpError({ responseCode: 535, response: "535 bad credentials" });
      },
    });

    expect(attempts).toBe(1);
    expect(result.mailboxesPaused).toEqual(["payments"]);

    const mailbox = getMailbox(db, mailboxId);
    expect(mailbox.status).toBe("paused");
    expect(mailbox.paused_reason).toContain("Authentication failed");

    // The rest went back to the queue rather than being burned.
    const stuck = db
      .prepare("select count(*) as n from messages where status = 'sending'")
      .get() as { n: number };
    expect(stuck.n).toBe(0);
  });

  it("pauses after two failures in a row", async () => {
    for (let i = 0; i < 4; i += 1) addProspect(`Store${i}`, `s${i}@store.com`);
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });
    makeDue(db);

    let attempts = 0;
    const result = await runSendTick(db, {
      now: TICK,
      rng: rng(),
      limit: 4,
      sender: async () => {
        attempts += 1;
        throw smtpError({ responseCode: 451, response: "451 greylisted" });
      },
    });

    expect(attempts).toBe(2);
    expect(result.mailboxesPaused).toEqual(["payments"]);
  });

  it("does nothing when nothing is due", async () => {
    const result = await runSendTick(db, { now: NOW, rng: rng() });
    expect(result).toMatchObject({ claimed: 0, sent: 0 });
  });
});

// ------------------------------------------------------------- reply poller

function inbound(overrides: Partial<FetchedMessage> & { from: string }): FetchedMessage {
  const { from, headers, ...rest } = overrides;
  return {
    uid: 1,
    folder: "INBOX",
    receivedAt: new Date("2026-09-21T12:00:00Z"),
    headers: { from, ...headers },
    text: "",
    ...rest,
  } as FetchedMessage;
}

function emptyResult(): PollResult {
  return {
    mailbox: "payments",
    fetched: 0,
    replies: 0,
    autoReplies: 0,
    bounces: 0,
    unsubscribes: 0,
    unmatched: 0,
    stopped: 0,
    suppressed: 0,
    notes: [],
  };
}

describe("applyInbound", () => {
  async function sendStepOne(email = "otie@store.com") {
    addProspect("Otie", email);
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });
    makeDue(db);
    const sender = recordingSender();
    await runSendTick(db, { now: TICK, rng: rng(), sender: sender.send });
    return sender.sent[0].messageId;
  }

  it("stops the sequence on a human reply and cancels the follow-up", async () => {
    const messageId = await sendStepOne();
    const result = emptyResult();

    applyInbound(
      db,
      getMailbox(db, mailboxId),
      inbound({
        from: "Owner <otie@store.com>",
        headers: {
          from: "Owner <otie@store.com>",
          subject: "Re: Quick question",
          messageId: "<reply-1@store.com>",
          inReplyTo: messageId,
        },
        text: "What would this cost?",
      }),
      buildSentLookup(db, mailboxId),
      result
    );

    expect(result.replies).toBe(1);
    expect(result.stopped).toBeGreaterThanOrEqual(1);

    const enrollment = db.prepare("select status from enrollments").get() as { status: string };
    expect(enrollment.status).toBe("replied");

    const step2 = db.prepare("select status from messages where step_number = 2").get() as {
      status: string;
    };
    expect(step2.status).toBe("cancelled");
  });

  it("lets the sequence continue through a helpdesk auto-reply", async () => {
    // The failure that matters most: most recipients are support@ addresses,
    // and a ticket receipt must not read as a human answer.
    const messageId = await sendStepOne("support@store.com");
    const result = emptyResult();

    applyInbound(
      db,
      getMailbox(db, mailboxId),
      inbound({
        from: "support@store.com",
        headers: {
          from: "support@store.com",
          subject: "[Ticket #4821] Quick question",
          messageId: "<auto-1@store.com>",
          inReplyTo: messageId,
          autoSubmitted: "auto-replied",
        },
        text: "Thanks for contacting us. We have received your message.",
      }),
      buildSentLookup(db, mailboxId),
      result
    );

    expect(result.autoReplies).toBe(1);
    expect(result.stopped).toBe(0);

    const enrollment = db.prepare("select status from enrollments").get() as { status: string };
    expect(enrollment.status).toBe("active");

    const step2 = db.prepare("select status from messages where step_number = 2").get() as {
      status: string;
    };
    expect(step2.status).toBe("scheduled");
  });

  it("suppresses and stops on a hard bounce", async () => {
    const messageId = await sendStepOne("dead@store.com");
    const result = emptyResult();

    applyInbound(
      db,
      getMailbox(db, mailboxId),
      inbound({
        from: "MAILER-DAEMON@store.com",
        headers: {
          from: "MAILER-DAEMON@store.com",
          subject: "Delivery Status Notification (Failure)",
          messageId: "<dsn-1@store.com>",
          contentType: "multipart/report; report-type=delivery-status",
          returnPath: "<>",
          references: [messageId],
        },
        text: "Address not found",
        raw: `Final-Recipient: rfc822; dead@store.com\nAction: failed\nStatus: 5.1.1\nMessage-ID: ${messageId}`,
      }),
      buildSentLookup(db, mailboxId),
      result
    );

    expect(result.bounces).toBe(1);
    expect(isSuppressed(db, "dead@store.com")).toBe(true);

    const enrollment = db.prepare("select status from enrollments").get() as { status: string };
    expect(enrollment.status).toBe("bounced");
  });

  it("does not suppress on a soft bounce", async () => {
    const messageId = await sendStepOne("full@store.com");
    const result = emptyResult();

    applyInbound(
      db,
      getMailbox(db, mailboxId),
      inbound({
        from: "MAILER-DAEMON@store.com",
        headers: {
          from: "MAILER-DAEMON@store.com",
          subject: "Delayed",
          messageId: "<dsn-2@store.com>",
          contentType: "multipart/report; report-type=delivery-status",
          references: [messageId],
        },
        text: "will retry",
        raw: `Final-Recipient: rfc822; full@store.com\nAction: delayed\nStatus: 4.2.2\nMessage-ID: ${messageId}`,
      }),
      buildSentLookup(db, mailboxId),
      result
    );

    expect(result.bounces).toBe(1);
    // Temporary, so suppressing would retire a live prospect.
    expect(isSuppressed(db, "full@store.com")).toBe(false);

    const enrollment = db.prepare("select status from enrollments").get() as { status: string };
    expect(enrollment.status).toBe("active");
  });

  it("suppresses on an opt-out", async () => {
    const messageId = await sendStepOne("owner@store.com");
    const result = emptyResult();

    applyInbound(
      db,
      getMailbox(db, mailboxId),
      inbound({
        from: "owner@store.com",
        headers: {
          from: "owner@store.com",
          subject: "Re: Quick question",
          messageId: "<opt-1@store.com>",
          inReplyTo: messageId,
        },
        text: "Please remove me from your list.",
      }),
      buildSentLookup(db, mailboxId),
      result
    );

    expect(result.unsubscribes).toBe(1);
    expect(isSuppressed(db, "owner@store.com")).toBe(true);

    const enrollment = db.prepare("select status from enrollments").get() as { status: string };
    expect(enrollment.status).toBe("stopped");
  });

  it("records an unmatched message without touching any sequence", async () => {
    await sendStepOne();
    const result = emptyResult();

    applyInbound(
      db,
      getMailbox(db, mailboxId),
      inbound({
        from: "stranger@elsewhere.org",
        headers: { from: "stranger@elsewhere.org", subject: "Hello", messageId: "<x@y.com>" },
        text: "Do you want to buy backlinks",
      }),
      buildSentLookup(db, mailboxId),
      result
    );

    expect(result.unmatched).toBe(1);
    const enrollment = db.prepare("select status from enrollments").get() as { status: string };
    expect(enrollment.status).toBe("active");
  });

  it("ignores a message it has already applied", async () => {
    // A re-poll must not stop a sequence the user deliberately restarted.
    const messageId = await sendStepOne();
    const message = inbound({
      from: "otie@store.com",
      headers: {
        from: "otie@store.com",
        subject: "Re: Quick question",
        messageId: "<reply-dup@store.com>",
        inReplyTo: messageId,
      },
      text: "Interested.",
    });

    const first = emptyResult();
    applyInbound(db, getMailbox(db, mailboxId), message, buildSentLookup(db, mailboxId), first);
    expect(first.replies).toBe(1);

    const second = emptyResult();
    applyInbound(db, getMailbox(db, mailboxId), message, buildSentLookup(db, mailboxId), second);
    expect(second.replies).toBe(0);
    expect(second.fetched).toBe(0);
  });

  it("stops a colleague's sequence at the same company", async () => {
    const messageId = await sendStepOne("owner@store.com");

    // A second contact at the same prospect, separately enrolled.
    const prospect = db.prepare("select id from prospects limit 1").get() as { id: number };
    const colleague = db
      .prepare("insert into contacts (prospect_id, email, channel) values (?, ?, 'email')")
      .run(prospect.id, "cfo@store.com");
    db.prepare("insert into enrollments (campaign_id, contact_id) values (?, ?)").run(
      campaignId,
      colleague.lastInsertRowid
    );

    const result = emptyResult();
    applyInbound(
      db,
      getMailbox(db, mailboxId),
      inbound({
        from: "owner@store.com",
        headers: {
          from: "owner@store.com",
          subject: "Re: Quick question",
          messageId: "<reply-2@store.com>",
          inReplyTo: messageId,
        },
        text: "Not right now thanks.",
      }),
      buildSentLookup(db, mailboxId),
      result
    );

    const statuses = db
      .prepare("select status from enrollments order by id")
      .all() as { status: string }[];
    expect(statuses.map((s) => s.status).sort()).toEqual(["replied", "stopped"]);
  });
});

describe("buildSentLookup", () => {
  it("indexes by message id, address and domain", async () => {
    addProspect("Otie", "otie@store.com");
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });
    makeDue(db);
    const sender = recordingSender();
    await runSendTick(db, { now: TICK, rng: rng(), sender: sender.send });

    const lookup = buildSentLookup(db, mailboxId);
    expect(lookup.byMessageId.has(sender.sent[0].messageId)).toBe(true);
    expect(lookup.byRecipient.has("otie@store.com")).toBe(true);
    expect(lookup.byRecipientDomain.has("store.com")).toBe(true);
  });
});
