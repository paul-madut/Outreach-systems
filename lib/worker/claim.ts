import type { Db } from "@/lib/db";
import { nowIso, parseJson, toIso } from "@/lib/db";
import { isoDayOfWeek, localDateOf, parseLocalTime, toInstant } from "@/lib/schedule/tz";
import { effectiveDailyCap } from "@/lib/schedule/warmup";

/**
 * Claiming work.
 *
 * With one worker holding a lock, this is a transaction rather than the
 * lease-and-reaper dance a serverless queue needs. What survives from that
 * design is the part that has nothing to do with concurrency:
 *
 *   SMTP and the database still do not share a transaction. A crash between
 *   the server accepting a message and the row being marked 'sent' leaves an
 *   ambiguous row, so those go to 'uncertain' and wait for a human. A missed
 *   send costs a click. A duplicate burns a prospect.
 */

export interface ClaimedMessage {
  id: number;
  mailbox_id: number;
  enrollment_id: number;
  step_number: number;
  to_email: string;
  subject: string;
  body: string;
  message_id: string;
  in_reply_to: string | null;
  references_header: string | null;
  attempts: number;
}

interface MailboxRow {
  id: number;
  timezone: string;
  daily_cap: number;
  warmup_started_on: string | null;
  warmup_start_cap: number;
  warmup_daily_increment: number;
  min_gap_seconds: number;
  gap_jitter_seconds: number;
  next_send_after: string | null;
}

interface CampaignWindowRow {
  campaign_id: number;
  timezone: string;
  window_start: string;
  window_end: string;
  send_days: string;
}

/**
 * Sweep messages left in 'sending' by a worker that died.
 *
 * Safe to call only at worker startup, while the lock is held. At that moment
 * no send is in flight, so any 'sending' row is orphaned by definition. They
 * become 'uncertain' rather than 'scheduled': the previous worker may well
 * have delivered them.
 */
export function sweepOrphans(db: Db): number {
  const result = db
    .prepare(
      `update messages
          set status = 'uncertain',
              error = 'Worker exited before reporting the result. Delivery unknown, not retried automatically.'
        where status = 'sending'`
    )
    .run();
  return result.changes;
}

/** Whether a campaign may send right now, in its own timezone. */
export function campaignIsOpen(campaign: CampaignWindowRow, now: Date): boolean {
  const days = parseJson<number[]>(campaign.send_days, []);
  const today = localDateOf(now, campaign.timezone);

  if (!days.includes(isoDayOfWeek(today, campaign.timezone))) return false;

  const open = toInstant(today, parseLocalTime(campaign.window_start), campaign.timezone);
  const close = toInstant(today, parseLocalTime(campaign.window_end), campaign.timezone);

  return now >= open && now < close;
}

/** Sends counted against a mailbox's cap for its current local day. */
export function usedToday(db: Db, mailbox: MailboxRow, now: Date): number {
  const today = localDateOf(now, mailbox.timezone);
  const dayStart = toIso(toInstant(today, 0, mailbox.timezone));

  // In-flight work counts. A message sitting in 'sending' or 'uncertain' may
  // already have been delivered, so it must not free a slot.
  const row = db
    .prepare(
      `select count(*) as n
         from messages
        where mailbox_id = ?
          and (
            (status = 'sent' and sent_at >= ?)
            or (status in ('sending', 'uncertain') and claimed_at >= ?)
          )`
    )
    .get(mailbox.id, dayStart, dayStart) as { n: number };

  return row.n;
}

export interface ClaimOptions {
  /** Most messages to take in one tick. */
  limit?: number;
  now?: Date;
  /** Injected for tests so pacing jitter is reproducible. */
  rng?: () => number;
}

/**
 * Claim whatever is due, respecting every gate.
 *
 * All of it runs in one transaction so a crash mid-claim cannot leave a
 * half-updated queue. The gates are checked here rather than in the caller
 * because this is the only place that sees them together.
 */
export function claimDueMessages(db: Db, options: ClaimOptions = {}): ClaimedMessage[] {
  const { limit = 1, now = new Date(), rng = Math.random } = options;
  const nowIsoString = toIso(now);

  const claim = db.transaction((): ClaimedMessage[] => {
    const mailboxes = db
      .prepare(
        `select id, timezone, daily_cap, min_gap_seconds, gap_jitter_seconds, next_send_after,
                warmup_started_on, warmup_start_cap, warmup_daily_increment
           from mailboxes
          where status = 'active'
            and (next_send_after is null or next_send_after <= ?)
          order by id`
      )
      .all(nowIsoString) as MailboxRow[];

    const claimed: ClaimedMessage[] = [];

    for (const mailbox of mailboxes) {
      if (claimed.length >= limit) break;

      // The ramp lowers today's ceiling for a young mailbox. Enforced here,
      // inside the same transaction as the cap, so it cannot be bypassed by
      // any other path into the queue.
      const capToday = effectiveDailyCap(mailbox, now);
      const room = Math.min(capToday - usedToday(db, mailbox, now), limit - claimed.length);
      if (room <= 0) continue;

      // Follow-ups first. A step 2 slipping past its slot is worse than a step
      // 1 starting a day late, because that thread is already open.
      const candidates = db
        .prepare(
          `select m.id, m.mailbox_id, m.enrollment_id, m.step_number, m.to_email,
                  m.subject, m.body, m.message_id, m.in_reply_to, m.references_header,
                  m.attempts,
                  c.id   as campaign_id,
                  c.timezone, c.window_start, c.window_end, c.send_days
             from messages m
             join enrollments e on e.id = m.enrollment_id
             join campaigns   c on c.id = e.campaign_id
            where m.mailbox_id = ?
              and m.status = 'scheduled'
              and m.scheduled_at <= ?
              and e.status = 'active'
              and c.status = 'active'
            order by (m.step_number > 1) desc, m.scheduled_at, m.id`
        )
        .all(mailbox.id, nowIsoString) as (ClaimedMessage & CampaignWindowRow)[];

      let takenFromMailbox = 0;

      for (const candidate of candidates) {
        if (takenFromMailbox >= room) break;
        if (!campaignIsOpen(candidate, now)) continue;

        db.prepare(
          `update messages
              set status = 'sending', claimed_at = ?, attempts = attempts + 1
            where id = ? and status = 'scheduled'`
        ).run(nowIsoString, candidate.id);

        claimed.push({
          id: candidate.id,
          mailbox_id: candidate.mailbox_id,
          enrollment_id: candidate.enrollment_id,
          step_number: candidate.step_number,
          to_email: candidate.to_email,
          subject: candidate.subject,
          body: candidate.body,
          message_id: candidate.message_id,
          in_reply_to: candidate.in_reply_to,
          references_header: candidate.references_header,
          attempts: candidate.attempts + 1,
        });
        takenFromMailbox += 1;
      }

      if (takenFromMailbox > 0) {
        const gap =
          mailbox.min_gap_seconds + Math.floor(rng() * (mailbox.gap_jitter_seconds + 1));
        db.prepare("update mailboxes set next_send_after = ? where id = ?").run(
          toIso(new Date(now.getTime() + gap * 1000)),
          mailbox.id
        );
      }
    }

    return claimed;
  });

  return claim();
}

// ------------------------------------------------------------------ results

export function markSent(db: Db, messageId: number, smtpResponse: string | null): boolean {
  const sentAt = nowIso();

  const update = db
    .prepare(
      `update messages
          set status = 'sent', sent_at = ?, smtp_response = ?, error = null
        where id = ? and status in ('sending', 'uncertain')`
    )
    .run(sentAt, smtpResponse, messageId);

  if (update.changes === 0) return false;

  const row = db
    .prepare("select enrollment_id, step_number from messages where id = ?")
    .get(messageId) as { enrollment_id: number; step_number: number };

  db.prepare(
    `update enrollments
        set current_step = max(current_step, ?), last_sent_at = ?
      where id = ?`
  ).run(row.step_number, sentAt, row.enrollment_id);

  return true;
}

/**
 * Return a message to the queue after a failure that is KNOWN not to have
 * sent: a 4xx reply, or a socket error during connect, EHLO, STARTTLS or AUTH.
 * Anything at or after DATA is ambiguous and belongs in `markUncertain`.
 */
export function releaseMessage(
  db: Db,
  messageId: number,
  error: string,
  retryInSeconds = 900,
  maxAttempts = 3
): "scheduled" | "failed" | null {
  const row = db
    .prepare("select attempts, status from messages where id = ?")
    .get(messageId) as { attempts: number; status: string } | undefined;

  if (!row || !["sending", "uncertain"].includes(row.status)) return null;

  const status = row.attempts >= maxAttempts ? "failed" : "scheduled";
  const scheduledAt =
    status === "scheduled" ? toIso(new Date(Date.now() + retryInSeconds * 1000)) : null;

  db.prepare(
    `update messages
        set status = ?,
            scheduled_at = coalesce(?, scheduled_at),
            claimed_at = null,
            error = ?
      where id = ?`
  ).run(status, scheduledAt, error, messageId);

  return status;
}

/** The send may or may not have happened. Never retried automatically. */
export function markUncertain(db: Db, messageId: number, error: string): boolean {
  const result = db
    .prepare(
      `update messages set status = 'uncertain', error = ? where id = ? and status = 'sending'`
    )
    .run(error, messageId);
  return result.changes > 0;
}

/**
 * Stop a sequence and cancel what it still has queued.
 *
 * Cancels only 'draft' and 'scheduled' rows. A message already claimed is in
 * flight and beyond recall, and rewriting it would misreport what was sent.
 */
export function stopEnrollment(
  db: Db,
  enrollmentId: number,
  status: "replied" | "bounced" | "stopped" | "completed",
  reason: string
): number {
  const stop = db.transaction(() => {
    db.prepare("update enrollments set status = ?, stop_reason = ? where id = ?").run(
      status,
      reason,
      enrollmentId
    );

    return db
      .prepare(
        `update messages set status = 'cancelled', error = ?
          where enrollment_id = ? and status in ('draft', 'scheduled')`
      )
      .run(reason, enrollmentId).changes;
  });

  return stop();
}
