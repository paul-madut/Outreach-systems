import { addDays, daysBetween, localDateKey, localDateOf, parseLocalDate } from "./tz";

/**
 * The sending ramp.
 *
 * A brand new domain has no reputation, and the fastest way to lose the little
 * it earns is to send thirty messages on its first morning. The ramp raises a
 * mailbox's cap by a fixed step each local day until it reaches `daily_cap`,
 * which stays the ceiling.
 *
 * This is pure so the schedule can be asserted without a clock or a database,
 * and so the settings page and the worker cannot disagree about what today's
 * cap is: both call it.
 */

export interface WarmupFields {
  timezone: string;
  daily_cap: number;
  /** Local calendar date the ramp begins, or null for no ramp. */
  warmup_started_on: string | null;
  warmup_start_cap: number;
  warmup_daily_increment: number;
}

export interface WarmupState {
  /** The cap in force right now. This is what the claim gate uses. */
  cap: number;
  /** The mailbox's configured ceiling. */
  ceiling: number;
  /** 1 on the first day of the ramp. Null when no ramp is configured. */
  day: number | null;
  /** The ramp has reached the ceiling, or there is no ramp. */
  complete: boolean;
  /** The start date is still in the future, so nothing may send yet. */
  pending: boolean;
  /** Local date the cap first reaches the ceiling. Null if it never will. */
  fullOn: string | null;
}

/**
 * Where a mailbox is in its ramp.
 *
 * A start date in the future gives a cap of zero rather than the ceiling. The
 * tool's rule is to never send a message it is not certain it should send, and
 * "the ramp has not started" is not a reason to send at full rate.
 */
export function warmupState(mailbox: WarmupFields, now: Date): WarmupState {
  const ceiling = mailbox.daily_cap;

  if (!mailbox.warmup_started_on) {
    return { cap: ceiling, ceiling, day: null, complete: true, pending: false, fullOn: null };
  }

  const start = parseLocalDate(mailbox.warmup_started_on);
  const day = daysBetween(start, localDateOf(now, mailbox.timezone)) + 1;

  if (day < 1) {
    return {
      cap: 0,
      ceiling,
      day,
      complete: false,
      pending: true,
      fullOn: localDateKey(start),
    };
  }

  const stepped = mailbox.warmup_start_cap + mailbox.warmup_daily_increment * (day - 1);
  const cap = Math.max(0, Math.min(ceiling, stepped));

  return {
    cap,
    ceiling,
    day,
    complete: cap >= ceiling,
    pending: false,
    fullOn: cap >= ceiling ? null : fullCapDate(mailbox, start),
  };
}

/** The cap the claim gate enforces for this mailbox today. */
export function effectiveDailyCap(mailbox: WarmupFields, now: Date): number {
  return warmupState(mailbox, now).cap;
}

/**
 * The local date the ramp first reaches the ceiling.
 *
 * Null when the increment is zero or negative, which is a fixed reduced cap
 * rather than a ramp and never arrives anywhere.
 */
function fullCapDate(mailbox: WarmupFields, start: ReturnType<typeof parseLocalDate>): string | null {
  const climb = mailbox.daily_cap - mailbox.warmup_start_cap;
  if (climb <= 0) return localDateKey(start);
  if (mailbox.warmup_daily_increment <= 0) return null;

  const daysNeeded = Math.ceil(climb / mailbox.warmup_daily_increment);
  return localDateKey(addDays(start, daysNeeded));
}

/** One line for the settings page and the CLI. */
export function describeWarmup(state: WarmupState): string {
  if (state.day === null) return `${state.cap} a day, no ramp`;
  if (state.pending) return `ramp starts ${state.fullOn}, nothing sends before then`;
  if (state.complete) return `${state.cap} a day, ramp complete`;
  return `day ${state.day}: ${state.cap} a day, ${state.ceiling} from ${state.fullOn ?? "never"}`;
}

export interface WarmupSettings {
  /** YYYY-MM-DD in the mailbox's own timezone. */
  startOn: string;
  startCap: number;
  dailyIncrement: number;
}

export class InvalidWarmupError extends Error {}

/**
 * Validate a ramp before it reaches the database.
 *
 * Shared by the CLI and the dashboard so the two cannot drift, and so a bad
 * value is rejected in one place rather than in two slightly different ones.
 */
export function validateWarmup(settings: WarmupSettings): void {
  try {
    parseLocalDate(settings.startOn);
  } catch (error) {
    throw new InvalidWarmupError((error as Error).message);
  }

  const { startCap, dailyIncrement } = settings;
  if (!Number.isInteger(startCap) || startCap < 0) {
    throw new InvalidWarmupError("The starting cap must be a whole number of messages, zero or more.");
  }
  if (!Number.isInteger(dailyIncrement) || dailyIncrement < 0) {
    throw new InvalidWarmupError("The daily step must be a whole number of messages, zero or more.");
  }
}
