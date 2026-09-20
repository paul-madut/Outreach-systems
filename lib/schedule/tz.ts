import { TZDate } from "@date-fns/tz";

/**
 * Timezone helpers for slotting.
 *
 * The one rule: never build a send time by adding 24 hours to an instant.
 * Across a DST boundary that lands an hour outside the sending window, which
 * for a 09:00-16:00 campaign means an email at 08:00 or 17:00 local. Every slot
 * here is built from a local calendar date plus a local wall-clock time,
 * resolved through an IANA zone.
 */

export interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

/** "09:30" or "09:30:00" as minutes past local midnight. */
export function parseLocalTime(value: string): number {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid local time: ${value}`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`Invalid local time: ${value}`);
  }
  return hours * 60 + minutes;
}

export function localDateOf(instant: Date, timeZone: string): LocalDate {
  const zoned = new TZDate(instant, timeZone);
  return {
    year: zoned.getFullYear(),
    month: zoned.getMonth() + 1,
    day: zoned.getDate(),
  };
}

/**
 * A local calendar date plus minutes past local midnight, as a real instant.
 *
 * TZDate resolves the offset for that wall-clock moment, so 2026-11-02 09:00
 * in America/Toronto is EST while 2026-10-30 09:00 is EDT, and both are 09:00
 * to the recipient.
 */
export function toInstant(
  date: LocalDate,
  minutesFromMidnight: number,
  timeZone: string
): Date {
  const hours = Math.floor(minutesFromMidnight / 60);
  const minutes = minutesFromMidnight % 60;
  return new Date(
    new TZDate(date.year, date.month - 1, date.day, hours, minutes, 0, 0, timeZone).getTime()
  );
}

/** ISO weekday for a local date. Monday is 1, Sunday is 7. */
export function isoDayOfWeek(date: LocalDate, timeZone: string): number {
  const zoned = new TZDate(date.year, date.month - 1, date.day, 12, 0, 0, 0, timeZone);
  const day = zoned.getDay(); // 0 = Sunday
  return day === 0 ? 7 : day;
}

/** Move a local calendar date by whole days, with no reference to instants. */
export function addDays(date: LocalDate, days: number): LocalDate {
  // UTC arithmetic is safe here because this is calendar math on a bare date,
  // not on a point in time.
  const utc = Date.UTC(date.year, date.month - 1, date.day);
  const moved = new Date(utc + days * 86_400_000);
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
  };
}

export function sameLocalDate(a: LocalDate, b: LocalDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

export function localDateKey(date: LocalDate): string {
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${date.year}-${month}-${day}`;
}

/**
 * The first allowed send day on or after `date`.
 *
 * Bounded at 7 iterations. `allowedDays` is validated non-empty by the caller,
 * so a campaign configured with no send days fails loudly at save time rather
 * than spinning here.
 */
export function nextSendDay(
  date: LocalDate,
  allowedDays: number[],
  timeZone: string
): LocalDate {
  let candidate = date;
  for (let i = 0; i < 7; i += 1) {
    if (allowedDays.includes(isoDayOfWeek(candidate, timeZone))) {
      return candidate;
    }
    candidate = addDays(candidate, 1);
  }
  throw new Error("No allowed send day found. Check the campaign's send_days.");
}
