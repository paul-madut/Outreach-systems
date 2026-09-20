import { describe, expect, it } from "vitest";
import { TZDate } from "@date-fns/tz";
import {
  OccupancyMap,
  assignStep1Slots,
  nextFollowUpSlot,
  validateWindow,
  type PacingLimits,
  type SendWindow,
} from "@/lib/schedule/slots";
import {
  addDays,
  isoDayOfWeek,
  localDateOf,
  nextSendDay,
  parseLocalTime,
  toInstant,
} from "@/lib/schedule/tz";

const TZ = "America/Toronto";

const WEEKDAYS: SendWindow = {
  start: "09:00",
  end: "16:00",
  days: [1, 2, 3, 4, 5],
  timeZone: TZ,
};

const LIMITS: PacingLimits = {
  dailyCap: 40,
  minGapSeconds: 120,
  newPerDay: 20,
};

/** Deterministic RNG so slot placement is reproducible under test. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Local wall-clock reading of an instant, for assertions. */
function localParts(instant: Date) {
  const zoned = new TZDate(instant, TZ);
  return {
    hour: zoned.getHours(),
    minute: zoned.getMinutes(),
    isoDay: zoned.getDay() === 0 ? 7 : zoned.getDay(),
    date: `${zoned.getFullYear()}-${String(zoned.getMonth() + 1).padStart(2, "0")}-${String(
      zoned.getDate()
    ).padStart(2, "0")}`,
  };
}

function minutesOfDay(instant: Date): number {
  const { hour, minute } = localParts(instant);
  return hour * 60 + minute;
}

describe("parseLocalTime", () => {
  it("parses and rejects", () => {
    expect(parseLocalTime("09:00")).toBe(540);
    expect(parseLocalTime("16:30:00")).toBe(990);
    expect(() => parseLocalTime("25:00")).toThrow();
    expect(() => parseLocalTime("9am")).toThrow();
  });
});

describe("validateWindow", () => {
  it("rejects an inverted window", () => {
    expect(() => validateWindow({ ...WEEKDAYS, start: "16:00", end: "09:00" })).toThrow();
  });

  it("rejects no send days", () => {
    expect(() => validateWindow({ ...WEEKDAYS, days: [] })).toThrow();
  });

  it("rejects out-of-range weekdays", () => {
    expect(() => validateWindow({ ...WEEKDAYS, days: [0, 1] })).toThrow();
  });
});

describe("calendar helpers", () => {
  it("treats Monday as 1 and Sunday as 7", () => {
    expect(isoDayOfWeek({ year: 2026, month: 9, day: 21 }, TZ)).toBe(1);
    expect(isoDayOfWeek({ year: 2026, month: 9, day: 20 }, TZ)).toBe(7);
  });

  it("skips the weekend", () => {
    const saturday = { year: 2026, month: 9, day: 19 };
    expect(nextSendDay(saturday, [1, 2, 3, 4, 5], TZ)).toEqual({
      year: 2026,
      month: 9,
      day: 21,
    });
  });

  it("crosses a month boundary", () => {
    expect(addDays({ year: 2026, month: 10, day: 30 }, 3)).toEqual({
      year: 2026,
      month: 11,
      day: 2,
    });
  });

  it("keeps a wall-clock time across the DST boundary", () => {
    // DST ends Sunday 2026-11-01 in America/Toronto, so these two 09:00 local
    // times sit at different UTC offsets. Adding 24h to an instant would put
    // the second one at 08:00 local, outside a 09:00 window.
    const beforeDst = toInstant({ year: 2026, month: 10, day: 30 }, 540, TZ);
    const afterDst = toInstant({ year: 2026, month: 11, day: 2 }, 540, TZ);

    expect(localParts(beforeDst).hour).toBe(9);
    expect(localParts(afterDst).hour).toBe(9);

    const hoursApart = (afterDst.getTime() - beforeDst.getTime()) / 3_600_000;
    expect(hoursApart).toBe(73); // 72 calendar hours plus the hour DST gives back
  });
});

describe("assignStep1Slots", () => {
  const now = new Date(toInstant({ year: 2026, month: 9, day: 21 }, 8 * 60, TZ)); // Mon 08:00

  it("places every contact inside the window on an allowed weekday", () => {
    const items = Array.from({ length: 50 }, (_, i) => `contact-${i}`);
    const slots = assignStep1Slots(
      items,
      WEEKDAYS,
      LIMITS,
      new OccupancyMap([], TZ),
      now,
      mulberry32(1)
    );

    expect(slots).toHaveLength(50);
    for (const { scheduledAt } of slots) {
      const parts = localParts(scheduledAt);
      expect(parts.isoDay).toBeLessThanOrEqual(5);
      expect(minutesOfDay(scheduledAt)).toBeGreaterThanOrEqual(540);
      expect(minutesOfDay(scheduledAt)).toBeLessThan(960);
      expect(scheduledAt.getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it("honours newPerDay", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const slots = assignStep1Slots(
      items,
      WEEKDAYS,
      LIMITS,
      new OccupancyMap([], TZ),
      now,
      mulberry32(2)
    );

    const perDay = new Map<string, number>();
    for (const { scheduledAt } of slots) {
      const key = localParts(scheduledAt).date;
      perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }
    for (const count of perDay.values()) {
      expect(count).toBeLessThanOrEqual(LIMITS.newPerDay);
    }
  });

  it("keeps at least minGapSeconds between sends on the same day", () => {
    const items = Array.from({ length: 40 }, (_, i) => i);
    const slots = assignStep1Slots(
      items,
      WEEKDAYS,
      LIMITS,
      new OccupancyMap([], TZ),
      now,
      mulberry32(3)
    );

    const byDay = new Map<string, number[]>();
    for (const { scheduledAt } of slots) {
      const key = localParts(scheduledAt).date;
      byDay.set(key, [...(byDay.get(key) ?? []), scheduledAt.getTime()]);
    }
    for (const times of byDay.values()) {
      const sorted = [...times].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(LIMITS.minGapSeconds * 1000);
      }
    }
  });

  it("preserves input order, so grade A goes out first", () => {
    // Jitter decides what the times look like, not who gets the early ones.
    const items = Array.from({ length: 45 }, (_, i) => i);
    const slots = assignStep1Slots(
      items,
      WEEKDAYS,
      LIMITS,
      new OccupancyMap([], TZ),
      now,
      mulberry32(4)
    );

    expect(slots.map((s) => s.item)).toEqual(items);

    // Send times must never go backwards as you walk the input order.
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i].scheduledAt.getTime()).toBeGreaterThan(
        slots[i - 1].scheduledAt.getTime()
      );
    }
  });

  it("pushes to the next day when enrolled near the end of the window", () => {
    // 15:50 on a Monday leaves ten minutes. A full day's quota cannot fit, so
    // most of the batch has to land on Tuesday.
    const lateMonday = new Date(toInstant({ year: 2026, month: 9, day: 21 }, 15 * 60 + 50, TZ));
    const items = Array.from({ length: 10 }, (_, i) => i);
    const slots = assignStep1Slots(
      items,
      WEEKDAYS,
      LIMITS,
      new OccupancyMap([], TZ),
      lateMonday,
      mulberry32(5)
    );

    const mondayCount = slots.filter((s) => localParts(s.scheduledAt).date === "2026-09-21").length;
    expect(mondayCount).toBeLessThan(items.length);
    for (const { scheduledAt } of slots) {
      expect(scheduledAt.getTime()).toBeGreaterThan(lateMonday.getTime());
    }
  });

  it("respects the mailbox cap already consumed by another campaign", () => {
    // The cap lives on the mailbox, so slots taken by a sibling campaign have
    // to be visible here or two campaigns would each send a full day's quota.
    const tuesday = { year: 2026, month: 9, day: 22 };
    const taken = Array.from({ length: 40 }, (_, i) =>
      toInstant(tuesday, 9 * 60 + i * 10, TZ)
    );

    const slots = assignStep1Slots(
      Array.from({ length: 5 }, (_, i) => i),
      WEEKDAYS,
      { ...LIMITS, dailyCap: 40 },
      new OccupancyMap(taken, TZ),
      now,
      mulberry32(6)
    );

    for (const { scheduledAt } of slots) {
      expect(localParts(scheduledAt).date).not.toBe("2026-09-22");
    }
  });

  it("is deterministic for a given seed", () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    const run = (seed: number) =>
      assignStep1Slots(
        items,
        WEEKDAYS,
        LIMITS,
        new OccupancyMap([], TZ),
        now,
        mulberry32(seed)
      ).map((s) => s.scheduledAt.toISOString());

    expect(run(7)).toEqual(run(7));
  });
});

describe("nextFollowUpSlot", () => {
  it("lands delayDays later at the right local time across DST", () => {
    // Friday 2026-10-30 send, 3 day delay, lands Monday 2026-11-02 in EST.
    const sentAt = new Date(toInstant({ year: 2026, month: 10, day: 30 }, 10 * 60, TZ));
    const now = sentAt;

    const slot = nextFollowUpSlot(
      sentAt,
      3,
      WEEKDAYS,
      { dailyCap: 40, minGapSeconds: 120 },
      new OccupancyMap([], TZ),
      now,
      mulberry32(8)
    );

    const parts = localParts(slot);
    expect(parts.date).toBe("2026-11-02");
    expect(parts.isoDay).toBe(1);
    expect(minutesOfDay(slot)).toBeGreaterThanOrEqual(540);
    expect(minutesOfDay(slot)).toBeLessThan(960);
  });

  it("rolls a weekend landing onto Monday", () => {
    // Wednesday plus 3 days is Saturday.
    const sentAt = new Date(toInstant({ year: 2026, month: 9, day: 23 }, 10 * 60, TZ));
    const slot = nextFollowUpSlot(
      sentAt,
      3,
      WEEKDAYS,
      { dailyCap: 40, minGapSeconds: 120 },
      new OccupancyMap([], TZ),
      sentAt,
      mulberry32(9)
    );

    expect(localParts(slot).date).toBe("2026-09-28");
    expect(localParts(slot).isoDay).toBe(1);
  });

  it("never schedules in the past when the delay has already elapsed", () => {
    const sentAt = new Date(toInstant({ year: 2026, month: 9, day: 21 }, 10 * 60, TZ));
    const now = new Date(toInstant({ year: 2026, month: 10, day: 5 }, 11 * 60, TZ));

    const slot = nextFollowUpSlot(
      sentAt,
      3,
      WEEKDAYS,
      { dailyCap: 40, minGapSeconds: 120 },
      new OccupancyMap([], TZ),
      now,
      mulberry32(10)
    );

    expect(slot.getTime()).toBeGreaterThan(now.getTime());
  });

  it("skips to the next day when the target day is at cap", () => {
    const sentAt = new Date(toInstant({ year: 2026, month: 9, day: 21 }, 10 * 60, TZ));
    const thursday = { year: 2026, month: 9, day: 24 };
    const full = Array.from({ length: 40 }, (_, i) => toInstant(thursday, 9 * 60 + i * 10, TZ));

    const slot = nextFollowUpSlot(
      sentAt,
      3,
      WEEKDAYS,
      { dailyCap: 40, minGapSeconds: 120 },
      new OccupancyMap(full, TZ),
      sentAt,
      mulberry32(11)
    );

    expect(localParts(slot).date).not.toBe("2026-09-24");
  });
});

describe("OccupancyMap", () => {
  it("buckets by local date, not UTC date", () => {
    // 20:00 Toronto on 2026-09-21 is 00:00 UTC on 2026-09-22.
    const evening = toInstant({ year: 2026, month: 9, day: 21 }, 20 * 60, TZ);
    const map = new OccupancyMap([evening], TZ);

    expect(map.countOn({ year: 2026, month: 9, day: 21 })).toBe(1);
    expect(map.countOn({ year: 2026, month: 9, day: 22 })).toBe(0);
  });

  it("agrees with localDateOf", () => {
    const evening = toInstant({ year: 2026, month: 9, day: 21 }, 20 * 60, TZ);
    expect(localDateOf(evening, TZ)).toEqual({ year: 2026, month: 9, day: 21 });
  });
});
