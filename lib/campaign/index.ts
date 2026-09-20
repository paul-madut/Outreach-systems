import type { Db } from "@/lib/db";
import { fromSqliteBool, parseJson, toSqliteBool } from "@/lib/db";
import { DEFAULT_BANNED_PHRASES, DEFAULT_MAX_WORDS, type LintPolicy } from "@/lib/template/lint";
import type { SendWindow } from "@/lib/schedule/slots";
import { validateWindow } from "@/lib/schedule/slots";

/** Reading campaigns, mailboxes and steps out of the database. */

export interface MailboxRow {
  id: number;
  label: string;
  from_name: string;
  from_email: string;
  reply_to: string | null;
  provider: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  keychain_service: string;
  keychain_account: string;
  append_to_sent: number;
  timezone: string;
  daily_cap: number;
  min_gap_seconds: number;
  gap_jitter_seconds: number;
  status: string;
  paused_reason: string | null;
}

export interface CampaignRow {
  id: number;
  mailbox_id: number;
  name: string;
  description: string | null;
  timezone: string;
  window_start: string;
  window_end: string;
  send_days: string;
  new_per_day: number;
  auto_approve: number;
  footer_template: string | null;
  banned_phrases: string;
  max_words: number;
  status: string;
}

export interface StepRow {
  id: number;
  campaign_id: number;
  step_number: number;
  delay_days: number;
  subject_template: string;
  body_template: string;
  same_thread: number;
}

export function getMailbox(db: Db, id: number): MailboxRow {
  const row = db.prepare("select * from mailboxes where id = ?").get(id) as
    | MailboxRow
    | undefined;
  if (!row) throw new Error(`No mailbox with id ${id}.`);
  return row;
}

export function getCampaign(db: Db, id: number): CampaignRow {
  const row = db.prepare("select * from campaigns where id = ?").get(id) as
    | CampaignRow
    | undefined;
  if (!row) throw new Error(`No campaign with id ${id}.`);
  return row;
}

export function listSteps(db: Db, campaignId: number): StepRow[] {
  return db
    .prepare("select * from sequence_steps where campaign_id = ? order by step_number")
    .all(campaignId) as StepRow[];
}

export function getStep(db: Db, campaignId: number, stepNumber: number): StepRow | null {
  return (
    (db
      .prepare("select * from sequence_steps where campaign_id = ? and step_number = ?")
      .get(campaignId, stepNumber) as StepRow | undefined) ?? null
  );
}

/** The send window, in the shape the slotting code wants. */
export function windowOf(campaign: CampaignRow): SendWindow {
  const window: SendWindow = {
    start: campaign.window_start,
    end: campaign.window_end,
    days: parseJson<number[]>(campaign.send_days, [1, 2, 3, 4, 5]),
    timeZone: campaign.timezone,
  };
  validateWindow(window);
  return window;
}

/** The lint policy, with this campaign's extra banned phrases folded in. */
export function lintPolicyOf(campaign: CampaignRow): LintPolicy {
  const extra = parseJson<string[]>(campaign.banned_phrases, []);
  return {
    bannedPhrases: [...DEFAULT_BANNED_PHRASES, ...extra],
    maxWords: campaign.max_words || DEFAULT_MAX_WORDS,
  };
}

export function autoApproves(campaign: CampaignRow): boolean {
  return fromSqliteBool(campaign.auto_approve);
}

export function threadsFollowUps(step: StepRow): boolean {
  return fromSqliteBool(step.same_thread);
}

// ------------------------------------------------------------------ writing

export interface CreateMailboxInput {
  label: string;
  fromName: string;
  fromEmail: string;
  provider: "icloud" | "gmail" | "custom";
  keychainService: string;
  keychainAccount: string;
  timezone?: string;
  dailyCap?: number;
  minGapSeconds?: number;
  gapJitterSeconds?: number;
  smtpHost?: string;
  smtpPort?: number;
  imapHost?: string;
  imapPort?: number;
  replyTo?: string | null;
}

/**
 * Known provider endpoints, so a mailbox can be added by naming the provider.
 *
 * `appendToSent` is the detail that bites. iCloud does not file a copy of a
 * message sent over SMTP, so the tool has to APPEND one over IMAP. Gmail files
 * its own, and appending a second there puts every sent message in twice.
 */
const PROVIDERS = {
  icloud: {
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    appendToSent: true,
  },
  gmail: {
    smtpHost: "smtp.gmail.com",
    smtpPort: 587,
    imapHost: "imap.gmail.com",
    imapPort: 993,
    appendToSent: false,
  },
  custom: {
    smtpHost: "",
    smtpPort: 587,
    imapHost: "",
    imapPort: 993,
    appendToSent: true,
  },
} as const;

export function providerDefaults(provider: keyof typeof PROVIDERS) {
  return PROVIDERS[provider];
}

export function createMailbox(db: Db, input: CreateMailboxInput): number {
  const defaults = PROVIDERS[input.provider];
  const smtpHost = input.smtpHost ?? defaults.smtpHost;
  const imapHost = input.imapHost ?? defaults.imapHost;

  if (!smtpHost || !imapHost) {
    throw new Error("A custom mailbox needs both an SMTP host and an IMAP host.");
  }

  const result = db
    .prepare(
      `insert into mailboxes
         (label, from_name, from_email, reply_to, provider,
          smtp_host, smtp_port, smtp_user, imap_host, imap_port, imap_user,
          keychain_service, keychain_account, append_to_sent,
          timezone, daily_cap, min_gap_seconds, gap_jitter_seconds)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.label,
      input.fromName,
      input.fromEmail,
      input.replyTo ?? null,
      input.provider,
      smtpHost,
      input.smtpPort ?? defaults.smtpPort,
      input.fromEmail,
      imapHost,
      input.imapPort ?? defaults.imapPort,
      input.fromEmail,
      input.keychainService,
      input.keychainAccount,
      toSqliteBool(defaults.appendToSent),
      input.timezone ?? "America/Toronto",
      input.dailyCap ?? 20,
      input.minGapSeconds ?? 120,
      input.gapJitterSeconds ?? 60
    );

  return Number(result.lastInsertRowid);
}

export interface CreateCampaignInput {
  mailboxId: number;
  name: string;
  description?: string | null;
  timezone?: string;
  windowStart?: string;
  windowEnd?: string;
  sendDays?: number[];
  newPerDay?: number;
  autoApprove?: boolean;
  footerTemplate?: string | null;
  bannedPhrases?: string[];
  maxWords?: number;
}

export function createCampaign(db: Db, input: CreateCampaignInput): number {
  const result = db
    .prepare(
      `insert into campaigns
         (mailbox_id, name, description, timezone, window_start, window_end,
          send_days, new_per_day, auto_approve, footer_template,
          banned_phrases, max_words)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.mailboxId,
      input.name,
      input.description ?? null,
      input.timezone ?? "America/Toronto",
      input.windowStart ?? "09:00",
      input.windowEnd ?? "16:00",
      JSON.stringify(input.sendDays ?? [1, 2, 3, 4, 5]),
      input.newPerDay ?? 10,
      toSqliteBool(input.autoApprove ?? false),
      input.footerTemplate ?? null,
      JSON.stringify(input.bannedPhrases ?? []),
      input.maxWords ?? DEFAULT_MAX_WORDS
    );

  return Number(result.lastInsertRowid);
}

export interface UpsertStepInput {
  campaignId: number;
  stepNumber: number;
  subjectTemplate: string;
  bodyTemplate: string;
  delayDays?: number;
  sameThread?: boolean;
}

export function upsertStep(db: Db, input: UpsertStepInput): number {
  const result = db
    .prepare(
      `insert into sequence_steps
         (campaign_id, step_number, delay_days, subject_template, body_template, same_thread)
       values (?, ?, ?, ?, ?, ?)
       on conflict (campaign_id, step_number) do update set
         delay_days = excluded.delay_days,
         subject_template = excluded.subject_template,
         body_template = excluded.body_template,
         same_thread = excluded.same_thread`
    )
    .run(
      input.campaignId,
      input.stepNumber,
      input.delayDays ?? (input.stepNumber === 1 ? 0 : 3),
      input.subjectTemplate,
      input.bodyTemplate,
      toSqliteBool(input.sameThread ?? input.stepNumber > 1)
    );

  return Number(result.lastInsertRowid);
}

export function setCampaignStatus(
  db: Db,
  campaignId: number,
  status: "draft" | "active" | "paused" | "archived"
): void {
  db.prepare("update campaigns set status = ? where id = ?").run(status, campaignId);
}

export function setMailboxStatus(
  db: Db,
  mailboxId: number,
  status: "active" | "paused" | "archived",
  reason: string | null = null
): void {
  db.prepare("update mailboxes set status = ?, paused_reason = ? where id = ?").run(
    status,
    reason,
    mailboxId
  );
}
