import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import { toIso } from "@/lib/db";
import { createCampaign, createMailbox, upsertStep, setCampaignStatus } from "@/lib/campaign";
import {
  approveDrafts,
  dryRender,
  enrollContacts,
  previewEnrollment,
  updateDraft,
} from "@/lib/enroll";
import { createNextStep, ensureNextSteps } from "@/lib/enroll/next-step";
import { claimDueMessages, markSent } from "@/lib/worker/claim";
import { addSuppression } from "@/lib/suppressions";
import { createTestDb } from "./helpers/db";

let db: Db;
let mailboxId: number;
let campaignId: number;

/** Deterministic RNG so slot placement is reproducible. */
function rng() {
  let a = 42;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Monday 2026-09-21, 09:30 UTC. Inside a 09:00-16:00 UTC weekday window. */
const NOW = new Date("2026-09-21T09:30:00Z");

function addProspect(
  company: string,
  options: { email?: string | null; grade?: string; hold?: string | null; custom?: object } = {}
): number {
  const { email = `${company.toLowerCase().replace(/\W+/g, "")}@store.com`, grade = "A", hold = null, custom = {} } =
    options;

  const prospect = db
    .prepare(
      "insert into prospects (company, company_key, domain, grade, hold_reason, custom) values (?, ?, ?, ?, ?, ?)"
    )
    .run(
      company,
      company.toLowerCase().replace(/\W+/g, "-"),
      `${company.toLowerCase().replace(/\W+/g, "")}.com`,
      grade,
      hold,
      JSON.stringify(custom)
    );

  const contact = db
    .prepare("insert into contacts (prospect_id, email, channel) values (?, ?, ?)")
    .run(prospect.lastInsertRowid, email, email ? "email" : "contact_form");

  return Number(contact.lastInsertRowid);
}

beforeEach(() => {
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
    name: "high-risk payments",
    timezone: "UTC",
    windowStart: "09:00",
    windowEnd: "16:00",
    sendDays: [1, 2, 3, 4, 5],
    newPerDay: 10,
  });
  upsertStep(db, {
    campaignId,
    stepNumber: 1,
    subjectTemplate: "Quick question",
    bodyTemplate: "Hello {{first_name|there}},\n\nAbout {{company}}.",
  });
  setCampaignStatus(db, campaignId, "active");
});

afterEach(() => {
  db.close();
});

describe("previewEnrollment", () => {
  it("separates who can be enrolled from who cannot, with a reason", () => {
    addProspect("Ready");
    addProspect("OnHold", { hold: "unverified claims" });
    addProspect("NoEmail", { email: null });
    addProspect("Suppressed", { email: "blocked@bad.com" });
    addSuppression(db, "email", "blocked@bad.com", "Asked to stop");

    const preview = previewEnrollment(db, campaignId);

    expect(preview.eligible.map((e) => e.company)).toEqual(["Ready"]);
    const reasons = Object.fromEntries(preview.ineligible.map((i) => [i.company, i.reason]));
    expect(reasons.OnHold).toContain("On hold");
    expect(reasons.NoEmail).toContain("No email address");
    expect(reasons.Suppressed).toContain("Suppressed");
  });

  it("puts grade A first, which decides who is emailed first", () => {
    addProspect("CeeCorp", { grade: "C" });
    addProspect("AyeCorp", { grade: "A" });
    addProspect("BeeCorp", { grade: "B" });

    expect(previewEnrollment(db, campaignId).eligible.map((e) => e.company)).toEqual([
      "AyeCorp",
      "BeeCorp",
      "CeeCorp",
    ]);
  });

  it("excludes a contact already enrolled", () => {
    addProspect("Ready");
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });

    const preview = previewEnrollment(db, campaignId);
    expect(preview.eligible).toHaveLength(0);
    expect(preview.ineligible[0].reason).toContain("Already enrolled");
  });
});

describe("dryRender", () => {
  it("renders with merge fields from the prospect's custom columns", () => {
    upsertStep(db, {
      campaignId,
      stepNumber: 1,
      subjectTemplate: "Quick question",
      bodyTemplate: "You take {{payment_methods_today}}.",
    });
    addProspect("Otie", { custom: { payment_methods_today: "Bitcoin only" } });

    const preview = previewEnrollment(db, campaignId);
    const result = dryRender(db, campaignId, preview.eligible);

    expect(result.rendered[0].body).toContain("Bitcoin only");
    expect(result.failed).toHaveLength(0);
  });

  it("sends the per-row draft when the step is {{subject}} and {{body}}", () => {
    // This is the whole mechanism for agent-written emails in the sheet.
    upsertStep(db, {
      campaignId,
      stepNumber: 1,
      subjectTemplate: "{{subject}}",
      bodyTemplate: "{{body}}",
    });
    addProspect("Otie", {
      custom: { subject: "Your checkout is down", body: "Hello,\n\nI noticed..." },
    });

    const result = dryRender(db, campaignId, previewEnrollment(db, campaignId).eligible);
    expect(result.rendered[0].subject).toBe("Your checkout is down");
    expect(result.rendered[0].body).toContain("I noticed");
  });

  it("reports a missing field instead of sending a placeholder", () => {
    upsertStep(db, {
      campaignId,
      stepNumber: 1,
      subjectTemplate: "Quick question",
      bodyTemplate: "Your {{nonexistent_field}} is down.",
    });
    addProspect("Otie");

    const result = dryRender(db, campaignId, previewEnrollment(db, campaignId).eligible);
    expect(result.rendered).toHaveLength(0);
    expect(result.failed[0].missing).toEqual(["nonexistent_field"]);
  });

  it("separates out a message carrying a banned claim", () => {
    upsertStep(db, {
      campaignId,
      stepNumber: 1,
      subjectTemplate: "Quick question",
      bodyTemplate: "I have migrated 40+ high-risk stores with zero freezes.",
    });
    addProspect("Otie");

    const result = dryRender(db, campaignId, previewEnrollment(db, campaignId).eligible);
    expect(result.rendered).toHaveLength(0);
    expect(result.blocked[0].findings.some((f) => f.rule === "banned-claim")).toBe(true);
  });

  it("appends the campaign footer", () => {
    db.prepare("update campaigns set footer_template = ? where id = ?").run(
      "Reply and I will not email again.\n123 Example St, Ottawa ON",
      campaignId
    );
    addProspect("Otie");

    const result = dryRender(db, campaignId, previewEnrollment(db, campaignId).eligible);
    expect(result.rendered[0].body).toContain("123 Example St");
  });
});

describe("enrollContacts", () => {
  it("queues step 1 as a draft for review", () => {
    addProspect("Otie");
    const result = enrollContacts(db, campaignId, { now: NOW, rng: rng() });

    expect(result).toMatchObject({ enrolled: 1, drafted: 1, scheduled: 0 });

    const message = db.prepare("select status, step_number, message_id from messages").get() as {
      status: string;
      step_number: number;
      message_id: string;
    };
    expect(message.status).toBe("draft");
    expect(message.step_number).toBe(1);
    // The id exists before sending, so a retry reuses it.
    expect(message.message_id).toMatch(/^<.+@.+>$/);
  });

  it("schedules straight away when the campaign auto-approves", () => {
    db.prepare("update campaigns set auto_approve = 1 where id = ?").run(campaignId);
    addProspect("Otie");

    const result = enrollContacts(db, campaignId, { now: NOW, rng: rng() });
    expect(result.scheduled).toBe(1);
    expect(result.drafted).toBe(0);
  });

  it("does not enrol a contact whose message will not render", () => {
    // A half-enrolled contact with no step 1 would sit in the campaign forever.
    upsertStep(db, {
      campaignId,
      stepNumber: 1,
      subjectTemplate: "Quick question",
      bodyTemplate: "{{missing}}",
    });
    addProspect("Otie");

    const result = enrollContacts(db, campaignId, { now: NOW, rng: rng() });
    expect(result.enrolled).toBe(0);
    expect(result.failed).toHaveLength(1);

    const enrollments = db.prepare("select count(*) as n from enrollments").get() as { n: number };
    expect(enrollments.n).toBe(0);
  });

  it("spaces sends inside the window and respects new_per_day", () => {
    for (let i = 0; i < 25; i += 1) addProspect(`Store${i}`);

    const result = enrollContacts(db, campaignId, { now: NOW, rng: rng() });
    expect(result.enrolled).toBe(25);

    const rows = db
      .prepare("select scheduled_at from messages order by scheduled_at")
      .all() as { scheduled_at: string }[];

    const perDay = new Map<string, number>();
    for (const row of rows) {
      const day = row.scheduled_at.slice(0, 10);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
      const hour = Number(row.scheduled_at.slice(11, 13));
      expect(hour).toBeGreaterThanOrEqual(9);
      expect(hour).toBeLessThan(16);
    }
    for (const count of perDay.values()) expect(count).toBeLessThanOrEqual(10);
  });

  it("writes nothing on a dry run", () => {
    addProspect("Otie");
    const result = enrollContacts(db, campaignId, { now: NOW, rng: rng(), dryRun: true });

    expect(result.enrolled).toBe(1);
    const messages = db.prepare("select count(*) as n from messages").get() as { n: number };
    expect(messages.n).toBe(0);
  });
});

describe("approveDrafts", () => {
  it("moves a clean draft into the queue", () => {
    addProspect("Otie");
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });

    const draft = db.prepare("select id from messages").get() as { id: number };
    const result = approveDrafts(db, [draft.id]);

    expect(result.approved).toBe(1);
    const status = db.prepare("select status from messages where id = ?").get(draft.id) as {
      status: string;
    };
    expect(status.status).toBe("scheduled");
  });

  it("refuses to approve a message whose recipient was suppressed after rendering", () => {
    // A suppression added between enrollment and approval has to be honoured,
    // which is why linting runs again here rather than trusting the earlier pass.
    addProspect("Otie", { email: "support@otie.com" });
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });
    addSuppression(db, "email", "support@otie.com", "Replied asking to stop");

    const draft = db.prepare("select id from messages").get() as { id: number };
    const result = approveDrafts(db, [draft.id]);

    expect(result.approved).toBe(0);
    expect(result.blocked[0].findings[0].rule).toBe("suppressed");
  });

  it("refuses a draft edited to contain an em dash", () => {
    addProspect("Otie");
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });
    const draft = db.prepare("select id from messages").get() as { id: number };

    updateDraft(db, draft.id, "Quick question", "Cards are down — that hurts.");
    const result = approveDrafts(db, [draft.id]);

    expect(result.approved).toBe(0);
    expect(result.blocked[0].findings.some((f) => f.rule === "no-unicode-dash")).toBe(true);
  });
});

describe("createNextStep", () => {
  function enrolAndSend() {
    addProspect("Otie");
    db.prepare("update campaigns set auto_approve = 1 where id = ?").run(campaignId);
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });

    const claimed = claimDueMessages(db, { limit: 1, now: new Date("2026-09-21T15:00:00Z") });
    markSent(db, claimed[0].id, "250 ok");
    return db.prepare("select id from enrollments").get() as { id: number };
  }

  beforeEach(() => {
    upsertStep(db, {
      campaignId,
      stepNumber: 2,
      delayDays: 3,
      subjectTemplate: "ignored when threading",
      bodyTemplate: "Following up on {{company}}.",
    });
  });

  it("queues step 2 threaded onto step 1", () => {
    const enrollment = enrolAndSend();
    const outcome = createNextStep(db, enrollment.id, { now: NOW, rng: rng() });

    expect(outcome.created).toBe(true);

    const step2 = db.prepare("select * from messages where step_number = 2").get() as {
      subject: string;
      in_reply_to: string;
      references_header: string;
      status: string;
    };
    const step1 = db.prepare("select message_id from messages where step_number = 1").get() as {
      message_id: string;
    };

    // Gmail needs a matching subject to thread, not just References.
    expect(step2.subject).toBe("Re: Quick question");
    expect(step2.in_reply_to).toBe(step1.message_id);
    expect(step2.references_header).toContain(step1.message_id);
  });

  it("measures the delay from when step 1 actually sent, not from enrollment", () => {
    const enrollment = enrolAndSend();

    // Pin the real send time. markSent stamps the wall clock, which is correct
    // in production but would make this assertion depend on today's date.
    db.prepare(
      "update messages set sent_at = ? where enrollment_id = ? and step_number = 1"
    ).run("2026-09-21T15:00:00.000Z", enrollment.id);
    db.prepare("update enrollments set last_sent_at = ? where id = ?").run(
      "2026-09-21T15:00:00.000Z",
      enrollment.id
    );

    createNextStep(db, enrollment.id, { now: NOW, rng: rng() });

    const step2 = db.prepare("select scheduled_at from messages where step_number = 2").get() as {
      scheduled_at: string;
    };
    // Sent Monday the 21st, so a 3 day delay lands Thursday the 24th.
    expect(step2.scheduled_at.slice(0, 10)).toBe("2026-09-24");
  });

  it("rolls a follow-up off a weekend onto the next send day", () => {
    const enrollment = enrolAndSend();
    // Wednesday the 23rd plus 3 days is Saturday the 26th.
    db.prepare(
      "update messages set sent_at = ? where enrollment_id = ? and step_number = 1"
    ).run("2026-09-23T15:00:00.000Z", enrollment.id);

    createNextStep(db, enrollment.id, { now: NOW, rng: rng() });

    const step2 = db.prepare("select scheduled_at from messages where step_number = 2").get() as {
      scheduled_at: string;
    };
    expect(step2.scheduled_at.slice(0, 10)).toBe("2026-09-28");
  });

  it("does not create a follow-up for an enrollment that replied", () => {
    const enrollment = enrolAndSend();
    db.prepare("update enrollments set status = 'replied' where id = ?").run(enrollment.id);

    const outcome = createNextStep(db, enrollment.id, { now: NOW, rng: rng() });
    expect(outcome.created).toBe(false);
    expect(outcome.reason).toContain("replied");
  });

  it("does not create a follow-up for a suppressed address", () => {
    const enrollment = enrolAndSend();
    addSuppression(db, "email", "otie@store.com", "Opted out");

    const outcome = createNextStep(db, enrollment.id, { now: NOW, rng: rng() });
    expect(outcome.created).toBe(false);
    expect(outcome.reason).toContain("suppressed");
  });

  it("marks the enrollment complete when the sequence runs out", () => {
    db.prepare("delete from sequence_steps where step_number = 2").run();
    const enrollment = enrolAndSend();

    const outcome = createNextStep(db, enrollment.id, { now: NOW, rng: rng() });
    expect(outcome.created).toBe(false);

    const status = db.prepare("select status from enrollments where id = ?").get(enrollment.id) as {
      status: string;
    };
    expect(status.status).toBe("completed");
  });

  it("is idempotent, so a crash after sending is repaired not duplicated", () => {
    const enrollment = enrolAndSend();
    createNextStep(db, enrollment.id, { now: NOW, rng: rng() });
    const second = createNextStep(db, enrollment.id, { now: NOW, rng: rng() });

    expect(second.created).toBe(false);
    expect(second.reason).toContain("already exists");

    const count = db
      .prepare("select count(*) as n from messages where step_number = 2")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("does not send step 2 before step 1 has gone out", () => {
    addProspect("Otie");
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });
    const enrollment = db.prepare("select id from enrollments").get() as { id: number };

    const outcome = createNextStep(db, enrollment.id, { now: NOW, rng: rng() });
    expect(outcome.created).toBe(false);
    expect(outcome.reason).toContain("has not sent yet");
  });
});

describe("ensureNextSteps", () => {
  it("repairs an enrollment left with nothing queued", () => {
    upsertStep(db, {
      campaignId,
      stepNumber: 2,
      delayDays: 3,
      subjectTemplate: "x",
      bodyTemplate: "Following up.",
    });
    db.prepare("update campaigns set auto_approve = 1 where id = ?").run(campaignId);
    addProspect("Otie");
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });

    const claimed = claimDueMessages(db, { limit: 1, now: new Date("2026-09-21T15:00:00Z") });
    markSent(db, claimed[0].id, "250 ok");

    // Simulates a crash between marking sent and creating the next step.
    const outcomes = ensureNextSteps(db, { now: NOW, rng: rng() });
    expect(outcomes.filter((o) => o.created)).toHaveLength(1);

    // And the repair does not run twice.
    expect(ensureNextSteps(db, { now: NOW, rng: rng() }).filter((o) => o.created)).toHaveLength(0);
  });

  it("ignores enrollments that still have something queued", () => {
    addProspect("Otie");
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });
    expect(ensureNextSteps(db, { now: NOW, rng: rng() })).toHaveLength(0);
  });

  it("ignores an enrollment that has never sent", () => {
    const contactId = addProspect("Otie");
    db.prepare("insert into enrollments (campaign_id, contact_id) values (?, ?)").run(
      campaignId,
      contactId
    );
    expect(ensureNextSteps(db, { now: NOW, rng: rng() })).toHaveLength(0);
  });
});

describe("mailbox provider defaults", () => {
  it("appends to Sent for iCloud but not for Gmail", () => {
    // Gmail files its own copy; a second append puts every message in twice.
    const gmail = createMailbox(db, {
      label: "jobs",
      fromName: "Paul Madut",
      fromEmail: "paul@gmail.com",
      provider: "gmail",
      keychainService: "gmail-smtp-outreach",
      keychainAccount: "paul@gmail.com",
    });

    const rows = db
      .prepare("select label, append_to_sent, smtp_host from mailboxes order by id")
      .all() as { label: string; append_to_sent: number; smtp_host: string }[];

    expect(rows.find((r) => r.label === "payments")).toMatchObject({
      append_to_sent: 1,
      smtp_host: "smtp.mail.me.com",
    });
    expect(rows.find((r) => r.label === "jobs")).toMatchObject({
      append_to_sent: 0,
      smtp_host: "smtp.gmail.com",
    });
    expect(gmail).toBeGreaterThan(0);
  });

  it("refuses a custom mailbox with no hosts", () => {
    expect(() =>
      createMailbox(db, {
        label: "broken",
        fromName: "x",
        fromEmail: "x@y.com",
        provider: "custom",
        keychainService: "s",
        keychainAccount: "a",
      })
    ).toThrow();
  });
});

describe("scheduling interaction", () => {
  it("shares the mailbox cap across two campaigns", () => {
    // The cap belongs to the mailbox, so a second campaign on the same mailbox
    // must not get its own full day's quota.
    const second = createCampaign(db, {
      mailboxId,
      name: "second campaign",
      timezone: "UTC",
      windowStart: "09:00",
      windowEnd: "16:00",
      sendDays: [1, 2, 3, 4, 5],
      newPerDay: 10,
    });
    upsertStep(db, {
      campaignId: second,
      stepNumber: 1,
      subjectTemplate: "Hi",
      bodyTemplate: "About {{company}}.",
    });
    setCampaignStatus(db, second, "active");

    for (let i = 0; i < 15; i += 1) addProspect(`First${i}`);
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });

    const before = db
      .prepare("select scheduled_at from messages order by scheduled_at")
      .all() as { scheduled_at: string }[];
    const firstDay = before[0].scheduled_at.slice(0, 10);
    const firstDayCount = before.filter((r) => r.scheduled_at.startsWith(firstDay)).length;

    for (let i = 0; i < 15; i += 1) addProspect(`Second${i}`);
    enrollContacts(db, second, { now: NOW, rng: rng() });

    const all = db.prepare("select scheduled_at from messages").all() as {
      scheduled_at: string;
    }[];
    const onFirstDay = all.filter((r) => r.scheduled_at.startsWith(firstDay)).length;

    expect(firstDayCount).toBeLessThanOrEqual(20);
    expect(onFirstDay).toBeLessThanOrEqual(20);
  });

  it("never schedules a send in the past", () => {
    for (let i = 0; i < 5; i += 1) addProspect(`Store${i}`);
    enrollContacts(db, campaignId, { now: NOW, rng: rng() });

    const rows = db.prepare("select scheduled_at from messages").all() as {
      scheduled_at: string;
    }[];
    for (const row of rows) {
      expect(new Date(row.scheduled_at).getTime()).toBeGreaterThan(NOW.getTime());
    }
    expect(toIso(NOW)).toBe("2026-09-21T09:30:00.000Z");
  });
});
