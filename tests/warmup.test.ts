import { describe, expect, it } from "vitest";
import { describeWarmup, effectiveDailyCap, warmupState, type WarmupFields } from "@/lib/schedule/warmup";
import { daysBetween, parseLocalDate } from "@/lib/schedule/tz";

const mailbox = (over: Partial<WarmupFields> = {}): WarmupFields => ({
  timezone: "America/Toronto",
  daily_cap: 25,
  warmup_started_on: "2026-09-23",
  warmup_start_cap: 5,
  warmup_daily_increment: 2,
  ...over,
});

/** Noon in Toronto on a given local date, so the day is unambiguous. */
const noonToronto = (iso: string) => new Date(`${iso}T16:00:00.000Z`);

describe("warmup ramp", () => {
  it("uses the full cap when no ramp is configured", () => {
    const state = warmupState(mailbox({ warmup_started_on: null }), noonToronto("2026-09-23"));
    expect(state).toMatchObject({ cap: 25, day: null, complete: true, pending: false });
  });

  it("starts at the start cap on day one", () => {
    const state = warmupState(mailbox(), noonToronto("2026-09-23"));
    expect(state.day).toBe(1);
    expect(state.cap).toBe(5);
    expect(state.complete).toBe(false);
  });

  it("climbs by the increment each day", () => {
    const caps = ["2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26"].map((day) =>
      effectiveDailyCap(mailbox(), noonToronto(day))
    );
    expect(caps).toEqual([5, 7, 9, 11]);
  });

  it("stops at the ceiling and never exceeds it", () => {
    expect(effectiveDailyCap(mailbox(), noonToronto("2026-10-03"))).toBe(25);
    expect(effectiveDailyCap(mailbox(), noonToronto("2026-12-25"))).toBe(25);
  });

  it("reports the date the ramp completes", () => {
    // 5 + 2n >= 25 needs n = 10, so day 11, which is 10 days after the start.
    expect(warmupState(mailbox(), noonToronto("2026-09-23")).fullOn).toBe("2026-10-03");
    expect(effectiveDailyCap(mailbox(), noonToronto("2026-10-03"))).toBe(25);
    expect(warmupState(mailbox(), noonToronto("2026-10-03")).complete).toBe(true);
  });

  it("sends nothing before the ramp's start date", () => {
    const state = warmupState(mailbox(), noonToronto("2026-09-20"));
    expect(state.pending).toBe(true);
    expect(state.cap).toBe(0);
  });

  it("counts days in the mailbox's timezone, not UTC", () => {
    // 03:00 UTC on the 24th is still the 23rd in Toronto, so still day one.
    const utcNextDay = new Date("2026-09-24T03:00:00.000Z");
    expect(warmupState(mailbox(), utcNextDay).day).toBe(1);
    expect(warmupState(mailbox({ timezone: "UTC" }), utcNextDay).day).toBe(2);
  });

  it("counts a DST boundary as one day, not as 23 hours", () => {
    // Toronto leaves DST on 2026-11-01. A ramp spanning it must not skip or
    // repeat a day, which is the bug adding 24h to an instant would cause.
    const start = mailbox({ warmup_started_on: "2026-10-30", daily_cap: 100 });
    const before = warmupState(start, new Date("2026-10-31T16:00:00.000Z"));
    const after = warmupState(start, new Date("2026-11-02T17:00:00.000Z"));
    expect(before.day).toBe(2);
    expect(after.day).toBe(4);
    expect(daysBetween(parseLocalDate("2026-10-30"), parseLocalDate("2026-11-02"))).toBe(3);
  });

  it("treats a zero increment as a fixed reduced cap that never completes", () => {
    const fixed = mailbox({ warmup_daily_increment: 0 });
    expect(effectiveDailyCap(fixed, noonToronto("2026-12-25"))).toBe(5);
    expect(warmupState(fixed, noonToronto("2026-12-25")).fullOn).toBeNull();
  });

  it("never exceeds the ceiling when the start cap is already above it", () => {
    const state = warmupState(mailbox({ warmup_start_cap: 40 }), noonToronto("2026-09-23"));
    expect(state.cap).toBe(25);
    expect(state.complete).toBe(true);
  });

  it("describes itself for the dashboard", () => {
    expect(describeWarmup(warmupState(mailbox(), noonToronto("2026-09-25")))).toBe(
      "day 3: 9 a day, 25 from 2026-10-03"
    );
    expect(describeWarmup(warmupState(mailbox({ warmup_started_on: null }), new Date()))).toBe(
      "25 a day, no ramp"
    );
  });
});

describe("local date helpers", () => {
  it("rejects a date that does not exist", () => {
    expect(() => parseLocalDate("2026-02-30")).toThrow(/does not exist/);
    expect(() => parseLocalDate("23-09-2026")).toThrow(/Expected YYYY-MM-DD/);
  });

  it("counts backwards as negative", () => {
    expect(daysBetween(parseLocalDate("2026-09-25"), parseLocalDate("2026-09-23"))).toBe(-2);
  });
});
