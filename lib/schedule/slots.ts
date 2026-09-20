import {
  addDays,
  isoDayOfWeek,
  localDateKey,
  localDateOf,
  nextSendDay,
  parseLocalTime,
  toInstant,
  type LocalDate,
} from "./tz";

/**
 * Slot assignment.
 *
 * Every message carries its own `scheduled_at`, so the worker never sleeps and
 * never needs to stay alive between sends. That is the whole reason the old
 * scripts needed `caffeinate` and a long-lived process.
 *
 * Pacing lives on the mailbox, not the campaign, because two campaigns can
 * share one mailbox and it is the mailbox that has a reputation to protect.
 * `occupied` therefore holds every already-placed send time for that mailbox
 * across all campaigns.
 *
 * Nothing here talks to the database, and the RNG is injected, so the whole
 * thing is deterministic under test.
 */

export interface SendWindow {
  /** "09:00" local. */
  start: string;
  /** "16:00" local. Must be after start. */
  end: string;
  /** ISO weekdays, Monday 1 through Sunday 7. */
  days: number[];
  timeZone: string;
}

export interface PacingLimits {
  /** Hard ceiling for the mailbox on any local day. Enforced again in SQL. */
  dailyCap: number;
  /** Minimum seconds between two sends from the same mailbox. */
  minGapSeconds: number;
  /** New step-1 sends to start per day. Planning input only. */
  newPerDay: number;
}

export type Rng = () => number;

const PLACEMENT_ATTEMPTS = 30;
const MAX_DAYS_SEARCHED = 370;
/** Never schedule in the next few minutes; the tick that would claim it may already be running. */
const EARLIEST_LEAD_MS = 5 * 60 * 1000;

export function validateWindow(window: SendWindow): void {
  const start = parseLocalTime(window.start);
  const end = parseLocalTime(window.end);
  if (start >= end) {
    throw new Error(
      `Send window start (${window.start}) must be before end (${window.end}).`
    );
  }
  if (window.days.length === 0) {
    throw new Error("Send window must allow at least one weekday.");
  }
  if (window.days.some((d) => d < 1 || d > 7)) {
    throw new Error("Send days must be ISO weekdays, 1 (Monday) through 7 (Sunday).");
  }
}

/**
 * Existing send times for a mailbox, bucketed by local calendar date.
 *
 * Built once per slotting run and mutated as slots are handed out, so a batch
 * of 50 contacts spaces itself correctly without re-reading the database.
 */
export class OccupancyMap {
  private readonly byDay = new Map<string, number[]>();

  constructor(instants: Date[], private readonly timeZone: string) {
    for (const instant of instants) {
      this.add(instant);
    }
  }

  add(instant: Date): void {
    const key = localDateKey(localDateOf(instant, this.timeZone));
    const bucket = this.byDay.get(key);
    if (bucket) {
      bucket.push(instant.getTime());
    } else {
      this.byDay.set(key, [instant.getTime()]);
    }
  }

  countOn(date: LocalDate): number {
    return this.byDay.get(localDateKey(date))?.length ?? 0;
  }

  timesOn(date: LocalDate): number[] {
    return this.byDay.get(localDateKey(date)) ?? [];
  }
}

/**
 * Fraction of a day's window still ahead of `now`.
 *
 * Without this, enrolling 20 contacts at 15:50 into a 09:00-16:00 window would
 * try to fit a full day's quota into ten minutes, and `pickTime` would fail
 * every one of them.
 */
function remainingShareOfDay(
  date: LocalDate,
  window: SendWindow,
  now: Date
): number {
  const open = toInstant(date, parseLocalTime(window.start), window.timeZone).getTime();
  const close = toInstant(date, parseLocalTime(window.end), window.timeZone).getTime();
  const span = close - open;
  if (span <= 0) return 0;
  const from = Math.max(open, now.getTime());
  return Math.max(0, Math.min(1, (close - from) / span));
}

/**
 * Pick a jittered instant inside one day's window that respects `minGapSeconds`.
 *
 * Random placement is tried first because evenly spaced sends look automated.
 * When the day is busy enough that random keeps colliding, it falls back to the
 * midpoint of the largest free gap, and returns null only when the day genuinely
 * cannot hold another send.
 */
export function pickTime(
  date: LocalDate,
  window: SendWindow,
  earliest: Date,
  occupied: number[],
  minGapSeconds: number,
  rng: Rng
): Date | null {
  const minGapMs = minGapSeconds * 1000;
  const open = toInstant(date, parseLocalTime(window.start), window.timeZone).getTime();
  const close = toInstant(date, parseLocalTime(window.end), window.timeZone).getTime();

  const lo = Math.max(open, earliest.getTime());
  const hi = close - 60_000;
  if (lo >= hi) return null;

  const sorted = [...occupied].sort((a, b) => a - b);
  const clearOf = (candidate: number) =>
    sorted.every((taken) => Math.abs(candidate - taken) >= minGapMs);

  for (let i = 0; i < PLACEMENT_ATTEMPTS; i += 1) {
    const candidate = Math.floor(lo + rng() * (hi - lo));
    if (clearOf(candidate)) {
      return new Date(candidate);
    }
  }

  // Deterministic fallback: the widest hole left in the day.
  const bounds = [lo - minGapMs, ...sorted.filter((t) => t >= lo && t <= hi), hi + minGapMs];
  let best = { start: 0, end: 0, size: -1 };
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const gapStart = bounds[i] + minGapMs;
    const gapEnd = bounds[i + 1] - minGapMs;
    const size = gapEnd - gapStart;
    if (size > best.size) best = { start: gapStart, end: gapEnd, size };
  }
  if (best.size >= 0) {
    const mid = Math.floor((best.start + best.end) / 2);
    if (mid >= lo && mid <= hi) return new Date(mid);
  }
  return null;
}

export interface Step1Assignment<T> {
  item: T;
  scheduledAt: Date;
}

/**
 * Assign step-1 send times across a batch of contacts.
 *
 * Input order is preserved, so sorting prospects by grade before calling this
 * is what puts the A-grade stores at the front of the queue.
 */
export function assignStep1Slots<T>(
  items: T[],
  window: SendWindow,
  limits: PacingLimits,
  occupied: OccupancyMap,
  now: Date,
  rng: Rng
): Step1Assignment<T>[] {
  validateWindow(window);

  const assignments: Step1Assignment<T>[] = [];
  const startedPerDay = new Map<string, number>();
  const earliest = new Date(now.getTime() + EARLIEST_LEAD_MS);

  let day = localDateOf(now, window.timeZone);

  for (const item of items) {
    let placed = false;

    for (let searched = 0; searched < MAX_DAYS_SEARCHED && !placed; searched += 1) {
      day = nextSendDay(day, window.days, window.timeZone);
      const key = localDateKey(day);
      const share = remainingShareOfDay(day, window, earliest);

      const startedToday = startedPerDay.get(key) ?? 0;
      const newQuota = Math.floor(limits.newPerDay * share);
      const capQuota = Math.floor(limits.dailyCap * share);

      if (startedToday < newQuota && occupied.countOn(day) < capQuota) {
        const at = pickTime(
          day,
          window,
          earliest,
          occupied.timesOn(day),
          limits.minGapSeconds,
          rng
        );
        if (at) {
          assignments.push({ item, scheduledAt: at });
          occupied.add(at);
          startedPerDay.set(key, startedToday + 1);
          placed = true;
          break;
        }
      }

      day = addDays(day, 1);
    }

    if (!placed) {
      throw new Error(
        "Could not place a send within a year. Check the campaign window, send days and caps."
      );
    }
  }

  return orderWithinDays(assignments, window.timeZone);
}

/**
 * Hand the earlier times of each day to the earlier items.
 *
 * `pickTime` jitters placement so a day's sends do not look machine-generated,
 * but that jitter should not decide which prospect goes first. Input order is
 * the priority order, so sorting a day's chosen times and reassigning them in
 * input order keeps grade A at the front while leaving the times themselves,
 * and therefore the gap and cap guarantees, untouched.
 */
function orderWithinDays<T>(
  assignments: Step1Assignment<T>[],
  timeZone: string
): Step1Assignment<T>[] {
  const timesByDay = new Map<string, number[]>();
  const dayOf = assignments.map((assignment) =>
    localDateKey(localDateOf(assignment.scheduledAt, timeZone))
  );

  dayOf.forEach((key, index) => {
    const bucket = timesByDay.get(key);
    const time = assignments[index].scheduledAt.getTime();
    if (bucket) bucket.push(time);
    else timesByDay.set(key, [time]);
  });

  for (const times of timesByDay.values()) {
    times.sort((a, b) => a - b);
  }

  const takenPerDay = new Map<string, number>();
  return assignments.map((assignment, index) => {
    const key = dayOf[index];
    const cursor = takenPerDay.get(key) ?? 0;
    takenPerDay.set(key, cursor + 1);
    return { item: assignment.item, scheduledAt: new Date(timesByDay.get(key)![cursor]) };
  });
}

/**
 * Slot a follow-up, measured from when the previous step ACTUALLY sent.
 *
 * Follow-ups are slotted one at a time, as the previous step is marked sent,
 * rather than precomputed at enrollment. Precomputing lets a paused campaign
 * make step 2 due before step 1 has gone out, and it wastes work on the
 * follow-ups that replies will cancel.
 */
export function nextFollowUpSlot(
  previousSentAt: Date,
  delayDays: number,
  window: SendWindow,
  limits: Pick<PacingLimits, "dailyCap" | "minGapSeconds">,
  occupied: OccupancyMap,
  now: Date,
  rng: Rng
): Date {
  validateWindow(window);

  const earliest = new Date(now.getTime() + EARLIEST_LEAD_MS);
  const from = addDays(localDateOf(previousSentAt, window.timeZone), delayDays);
  let day = nextSendDay(from, window.days, window.timeZone);

  for (let searched = 0; searched < MAX_DAYS_SEARCHED; searched += 1) {
    if (occupied.countOn(day) < limits.dailyCap) {
      const at = pickTime(
        day,
        window,
        earliest,
        occupied.timesOn(day),
        limits.minGapSeconds,
        rng
      );
      if (at) {
        occupied.add(at);
        return at;
      }
    }
    day = nextSendDay(addDays(day, 1), window.days, window.timeZone);
  }

  throw new Error(
    "Could not place a follow-up within a year. Check the campaign window and caps."
  );
}

/** Exposed for tests and for the campaign settings form. */
export { isoDayOfWeek, localDateOf, nextSendDay };
