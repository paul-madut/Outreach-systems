import { openDb, toIso, type Db } from "@/lib/db";

/**
 * A throwaway in-memory database with the real schema applied.
 *
 * `:memory:` means every test gets a clean database with no files to clean up,
 * and `lib/db/schema.sql` is the same file the app uses, so a schema change is
 * covered by these tests automatically.
 */
export function createTestDb(): Db {
  return openDb(":memory:");
}

export interface SeedOptions {
  dailyCap?: number;
  minGapSeconds?: number;
  gapJitterSeconds?: number;
  timezone?: string;
  windowStart?: string;
  windowEnd?: string;
  sendDays?: number[];
  mailboxStatus?: string;
  campaignStatus?: string;
  newPerDay?: number;
}

export interface Seeded {
  mailboxId: number;
  campaignId: number;
  prospectId: number;
}

/** A mailbox, a campaign and a prospect, with wide-open pacing by default. */
export function seedCampaign(db: Db, options: SeedOptions = {}): Seeded {
  const {
    dailyCap = 100,
    minGapSeconds = 0,
    gapJitterSeconds = 0,
    timezone = "UTC",
    windowStart = "00:00",
    windowEnd = "23:59",
    sendDays = [1, 2, 3, 4, 5, 6, 7],
    mailboxStatus = "active",
    campaignStatus = "active",
    newPerDay = 50,
  } = options;

  const mailbox = db
    .prepare(
      `insert into mailboxes
         (label, from_name, from_email, provider, smtp_host, smtp_user,
          imap_host, imap_user, keychain_service, keychain_account,
          timezone, daily_cap, min_gap_seconds, gap_jitter_seconds, status)
       values ('payments', 'Paul Madut', 'paul@example.com', 'icloud',
               'smtp.mail.me.com', 'paul@example.com',
               'imap.mail.me.com', 'paul@example.com',
               'icloud-smtp-outreach', 'paul@example.com',
               ?, ?, ?, ?, ?)`
    )
    .run(timezone, dailyCap, minGapSeconds, gapJitterSeconds, mailboxStatus);

  const campaign = db
    .prepare(
      `insert into campaigns
         (mailbox_id, name, timezone, window_start, window_end, send_days,
          new_per_day, status)
       values (?, 'high-risk payments', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      mailbox.lastInsertRowid,
      timezone,
      windowStart,
      windowEnd,
      JSON.stringify(sendDays),
      newPerDay,
      campaignStatus
    );

  const prospect = db
    .prepare(
      `insert into prospects (company, company_key, domain, vertical, grade, custom)
       values ('Otie''s Botanicals', 'oties-botanicals', 'otiesbotanicals.com',
               'kratom', 'A', '{"payment_methods_today":"Bitcoin, Ethereum"}')`
    )
    .run();

  return {
    mailboxId: Number(mailbox.lastInsertRowid),
    campaignId: Number(campaign.lastInsertRowid),
    prospectId: Number(prospect.lastInsertRowid),
  };
}

let sequence = 0;

/** A contact, its enrollment and one message, scheduled and due by default. */
export function seedMessage(
  db: Db,
  seeded: Seeded,
  options: {
    email?: string;
    scheduledAt?: Date | null;
    stepNumber?: number;
    status?: string;
  } = {}
): { contactId: number; enrollmentId: number; messageId: number } {
  sequence += 1;
  const {
    email = `support+${sequence}@store.com`,
    scheduledAt = new Date(Date.now() - 60_000),
    stepNumber = 1,
    status = "scheduled",
  } = options;

  const contact = db
    .prepare(
      `insert into contacts (prospect_id, email, channel) values (?, ?, 'email')`
    )
    .run(seeded.prospectId, email);

  const enrollment = db
    .prepare(`insert into enrollments (campaign_id, contact_id) values (?, ?)`)
    .run(seeded.campaignId, contact.lastInsertRowid);

  const message = db
    .prepare(
      `insert into messages
         (mailbox_id, enrollment_id, step_number, to_email, subject, body,
          message_id, scheduled_at, status)
       values (?, ?, ?, ?, 'Quick question', 'Hello,', ?, ?, ?)`
    )
    .run(
      seeded.mailboxId,
      enrollment.lastInsertRowid,
      stepNumber,
      email,
      `<msg-${sequence}@outreach.local>`,
      scheduledAt ? toIso(scheduledAt) : null,
      status
    );

  return {
    contactId: Number(contact.lastInsertRowid),
    enrollmentId: Number(enrollment.lastInsertRowid),
    messageId: Number(message.lastInsertRowid),
  };
}

/** Add a follow-up step to an existing enrollment. */
export function seedFollowUp(
  db: Db,
  seeded: Seeded,
  enrollmentId: number,
  options: { stepNumber?: number; scheduledAt?: Date; status?: string } = {}
): number {
  sequence += 1;
  const {
    stepNumber = 2,
    scheduledAt = new Date(Date.now() - 60_000),
    status = "scheduled",
  } = options;

  const result = db
    .prepare(
      `insert into messages
         (mailbox_id, enrollment_id, step_number, to_email, subject, body,
          message_id, scheduled_at, status)
       values (?, ?, ?, 'followup@store.com', 'Re: Quick question', 'following up',
               ?, ?, ?)`
    )
    .run(
      seeded.mailboxId,
      enrollmentId,
      stepNumber,
      `<followup-${sequence}@outreach.local>`,
      toIso(scheduledAt),
      status
    );

  return Number(result.lastInsertRowid);
}

export function statusOf(db: Db, messageId: number): string {
  const row = db.prepare("select status from messages where id = ?").get(messageId) as {
    status: string;
  };
  return row.status;
}

/** Clear the pacing gate so a test can claim again without waiting. */
export function resetPacing(db: Db, mailboxId: number): void {
  db.prepare("update mailboxes set next_send_after = null where id = ?").run(mailboxId);
}
