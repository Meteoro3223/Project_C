import { describe, expect, it } from "vitest";
import { availableMinutes } from "./availability.js";
import type { Weekday, WeeklyAvailability } from "./types.js";

/** Capacity of 180 min on weekdays and 120 min on the weekend. */
const WEEKDAY_180_WEEKEND_120: Readonly<Record<Weekday, number>> = {
  1: 180,
  2: 180,
  3: 180,
  4: 180,
  5: 180,
  6: 120,
  7: 120,
};

const NO_CAPACITY: Readonly<Record<Weekday, number>> = {
  1: 0,
  2: 0,
  3: 0,
  4: 0,
  5: 0,
  6: 0,
  7: 0,
};

const ONLY_SATURDAY_300: Readonly<Record<Weekday, number>> = {
  1: 0,
  2: 0,
  3: 0,
  4: 0,
  5: 0,
  6: 300,
  7: 0,
};

/** A distinct capacity per ISO weekday, so a wrong weekday is always visible. */
const DISTINCT_WEEKDAY_CAPACITY: Readonly<Record<Weekday, number>> = {
  1: 10,
  2: 20,
  3: 30,
  4: 40,
  5: 50,
  6: 60,
  7: 70,
};

interface Case {
  readonly name: string;
  readonly timezone: string;
  readonly minutesByWeekday: Readonly<Record<Weekday, number>>;
  /** ISO instant; weekdays in the comments below are local to `timezone`. */
  readonly now: string;
  readonly dueAt: string;
  readonly expected: number;
}

const CASES: readonly Case[] = [
  {
    name: "counts whole days in a normal week (Mon -> Thu)",
    timezone: "Europe/Madrid",
    minutesByWeekday: WEEKDAY_180_WEEKEND_120,
    now: "2026-10-12T07:00:00Z", // Mon 09:00
    dueAt: "2026-10-15T07:00:00Z", // Thu 09:00 -> Mon + Tue + Wed
    expected: 540,
  },
  {
    name: "applies the weekend rate (Fri -> Mon)",
    timezone: "Europe/Madrid",
    minutesByWeekday: WEEKDAY_180_WEEKEND_120,
    now: "2026-10-16T07:00:00Z", // Fri 09:00
    dueAt: "2026-10-19T07:00:00Z", // Mon 09:00 -> Fri + Sat + Sun
    expected: 420,
  },
  {
    name: "returns 0 for a deadline later today",
    timezone: "Europe/Madrid",
    minutesByWeekday: WEEKDAY_180_WEEKEND_120,
    now: "2026-10-12T07:00:00Z", // Mon 09:00
    dueAt: "2026-10-12T16:00:00Z", // Mon 18:00, same civil date
    expected: 0,
  },
  {
    name: "returns 0 for an overdue deadline",
    timezone: "Europe/Madrid",
    minutesByWeekday: WEEKDAY_180_WEEKEND_120,
    now: "2026-10-12T07:00:00Z", // Mon 09:00
    dueAt: "2026-10-09T16:00:00Z", // previous Fri 18:00
    expected: 0,
  },
  {
    name: "counts the deadline's civil date, not its UTC date (late-evening deadline)",
    timezone: "Europe/Madrid",
    minutesByWeekday: WEEKDAY_180_WEEKEND_120,
    now: "2026-10-14T07:00:00Z", // Wed 09:00
    dueAt: "2026-10-15T22:30:00Z", // Fri 16 Oct 00:30 local -> Wed + Thu
    expected: 360,
  },
  {
    name: "counts now's civil date, not its UTC date (just after local midnight)",
    timezone: "Europe/Madrid",
    minutesByWeekday: WEEKDAY_180_WEEKEND_120,
    now: "2026-10-14T22:30:00Z", // Thu 15 Oct 00:30 local
    dueAt: "2026-10-16T04:00:00Z", // Fri 06:00 -> Thu only
    expected: 180,
  },
  {
    name: "uses the post-transition offset after the spring DST change (CEST, +2)",
    timezone: "Europe/Madrid",
    minutesByWeekday: WEEKDAY_180_WEEKEND_120,
    now: "2026-03-29T22:30:00Z", // Mon 30 Mar 00:30 local (CEST, +2)
    dueAt: "2026-03-31T22:30:00Z", // Wed 1 Apr 00:30 local -> Mon + Tue
    expected: 360,
  },
  {
    name: "uses the post-transition offset after the autumn DST change (CET, +1)",
    timezone: "Europe/Madrid",
    minutesByWeekday: WEEKDAY_180_WEEKEND_120,
    now: "2026-10-25T22:30:00Z", // Sun 25 Oct 23:30 local (CET, +1)
    dueAt: "2026-10-26T23:30:00Z", // Tue 27 Oct 00:30 local -> Sun + Mon
    expected: 300,
  },
  {
    name: "spans the spring DST change (2026-03-29) and counts calendar days, not hours",
    timezone: "Europe/Madrid",
    minutesByWeekday: WEEKDAY_180_WEEKEND_120,
    now: "2026-03-27T11:00:00Z", // Fri 12:00 CET (+1), before the change
    dueAt: "2026-03-31T10:00:00Z", // Tue 12:00 CEST (+2) -> Fri + Sat + Sun + Mon
    expected: 600,
  },
  {
    name: "spans the autumn DST change (2026-10-25) and counts calendar days, not hours",
    timezone: "Europe/Madrid",
    minutesByWeekday: WEEKDAY_180_WEEKEND_120,
    now: "2026-10-24T10:00:00Z", // Sat 12:00 CEST (+2), before the change
    dueAt: "2026-10-27T11:00:00Z", // Tue 12:00 CET (+1) -> Sat + Sun + Mon
    expected: 420,
  },
  {
    name: "treats a day whose capacity is 0 as one day of no availability",
    timezone: "Europe/Madrid",
    minutesByWeekday: NO_CAPACITY,
    now: "2026-10-12T07:00:00Z", // Mon
    dueAt: "2026-10-15T07:00:00Z", // Thu -> three days, all 0
    expected: 0,
  },
  {
    name: "sums only the days whose capacity is non-zero",
    timezone: "Europe/Madrid",
    minutesByWeekday: ONLY_SATURDAY_300,
    now: "2026-10-16T07:00:00Z", // Fri
    dueAt: "2026-10-19T07:00:00Z", // Mon -> Fri 0 + Sat 300 + Sun 0
    expected: 300,
  },
  {
    name: "returns 0 when now and dueAt are the same instant",
    timezone: "Europe/Madrid",
    minutesByWeekday: WEEKDAY_180_WEEKEND_120,
    now: "2026-10-12T07:00:00Z",
    dueAt: "2026-10-12T07:00:00Z",
    expected: 0,
  },
  {
    name: "crosses a month boundary",
    timezone: "Europe/Madrid",
    minutesByWeekday: WEEKDAY_180_WEEKEND_120,
    now: "2026-10-31T07:00:00Z", // Sat 09:00
    dueAt: "2026-11-02T08:00:00Z", // Mon -> Sat + Sun
    expected: 240,
  },
  {
    name: "crosses a year boundary",
    timezone: "Europe/Madrid",
    minutesByWeekday: WEEKDAY_180_WEEKEND_120,
    now: "2026-12-31T08:00:00Z", // Thu 09:00
    dueAt: "2027-01-02T08:00:00Z", // Sat -> Thu + Fri
    expected: 360,
  },
  {
    name: "crosses 29 February in a leap year",
    timezone: "Europe/Madrid",
    minutesByWeekday: WEEKDAY_180_WEEKEND_120,
    now: "2028-02-28T08:00:00Z", // Mon 09:00
    dueAt: "2028-03-01T08:00:00Z", // Wed -> Mon 28 + Tue 29
    expected: 360,
  },
  {
    name: "treats a deadline exactly at local midnight as the new day (exclusive)",
    timezone: "Europe/Madrid",
    minutesByWeekday: WEEKDAY_180_WEEKEND_120,
    now: "2026-10-14T10:00:00Z", // Wed 12:00
    dueAt: "2026-10-15T22:00:00Z", // Fri 16 Oct 00:00 local -> Wed + Thu
    expected: 360,
  },
  {
    name: "works in a western timezone with DST (America/Los_Angeles)",
    timezone: "America/Los_Angeles",
    minutesByWeekday: WEEKDAY_180_WEEKEND_120,
    now: "2026-10-12T20:00:00Z", // Mon 13:00 PDT
    dueAt: "2026-10-15T19:00:00Z", // Thu 12:00 PDT -> Mon + Tue + Wed
    expected: 540,
  },
  {
    name: "works in a half-hour-offset timezone without DST (Asia/Kolkata)",
    timezone: "Asia/Kolkata",
    minutesByWeekday: WEEKDAY_180_WEEKEND_120,
    now: "2026-10-12T20:00:00Z", // Tue 13 Oct 01:30 IST
    dueAt: "2026-10-15T10:00:00Z", // Thu 15:30 IST -> Tue + Wed
    expected: 360,
  },
  {
    name: "works in a southern-hemisphere timezone with DST (Pacific/Auckland)",
    timezone: "Pacific/Auckland",
    minutesByWeekday: WEEKDAY_180_WEEKEND_120,
    now: "2026-10-11T20:00:00Z", // Mon 12 Oct 09:00 NZDT
    dueAt: "2026-10-14T20:00:00Z", // Thu 15 Oct 09:00 NZDT -> Mon + Tue + Wed
    expected: 540,
  },
];

const VALID_NOW = "2026-10-12T07:00:00Z";
const VALID_DUE_AT = "2026-10-15T07:00:00Z";

function availability(
  timezone: string,
  minutesByWeekday: Readonly<Record<Weekday, number>> = WEEKDAY_180_WEEKEND_120,
): WeeklyAvailability {
  return { timezone, minutesByWeekday };
}

/** Runs `run` and returns the error it throws, failing the test if it does not. */
function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the call to throw");
}

describe("availableMinutes", () => {
  it.each(CASES)("$name", ({ timezone, minutesByWeekday, now, dueAt, expected }) => {
    expect(
      availableMinutes(availability(timezone, minutesByWeekday), new Date(now), new Date(dueAt)),
    ).toBe(expected);
  });

  it("is deterministic for identical inputs", () => {
    const first = availableMinutes(
      availability("Europe/Madrid"),
      new Date(VALID_NOW),
      new Date(VALID_DUE_AT),
    );
    const second = availableMinutes(
      availability("Europe/Madrid"),
      new Date(VALID_NOW),
      new Date(VALID_DUE_AT),
    );

    expect(first).toBe(second);
  });
});

describe("availableMinutes validation", () => {
  it("throws a RangeError naming an invalid timezone", () => {
    const error = captureError(() =>
      availableMinutes(availability("Not/AZone"), new Date(VALID_NOW), new Date(VALID_DUE_AT)),
    );

    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toContain("Not/AZone");
  });

  it("throws again on later calls with the same invalid timezone (failed lookups are not cached)", () => {
    const invalid = availability("Not/AZone");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const error = captureError(() =>
        availableMinutes(invalid, new Date(VALID_NOW), new Date(VALID_DUE_AT)),
      );

      expect(error).toBeInstanceOf(RangeError);
      expect(error.message).toContain("Not/AZone");
    }
  });

  it.each([
    { argument: "now", now: "not a date", dueAt: VALID_DUE_AT },
    { argument: "dueAt", now: VALID_NOW, dueAt: "not a date" },
  ])("throws a RangeError naming an invalid $argument date", ({ argument, now, dueAt }) => {
    const error = captureError(() =>
      availableMinutes(availability("Europe/Madrid"), new Date(now), new Date(dueAt)),
    );

    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toContain(argument);
  });
});

describe("availableMinutes week folding", () => {
  const timezone = "Europe/Madrid";
  const weekly = availability(timezone, DISTINCT_WEEKDAY_CAPACITY);

  // 2026-01-12 is a Monday, so these seven consecutive starts cover every
  // ISO weekday as the first counted day.
  it.each([0, 1, 2, 3, 4, 5, 6])(
    "matches a day-by-day reference across 800 days (start offset %i)",
    (startOffset) => {
      const base = new Date(Date.UTC(2026, 0, 12 + startOffset, 12, 0, 0));

      for (let offset = 0; offset <= 800; offset += 1) {
        const dueAt = new Date(base.getTime() + offset * 86_400_000);

        expect(availableMinutes(weekly, base, dueAt)).toBe(
          referenceAvailableMinutes(weekly, base, dueAt),
        );
      }
    },
  );
});

/**
 * Deliberately naive day-by-day implementation: it walks every civil date
 * instead of folding whole weeks, so it validates the arithmetic in
 * `availableMinutes` without sharing its optimisation.
 */
function referenceAvailableMinutes(
  availability: WeeklyAvailability,
  now: Date,
  dueAt: Date,
): number {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: availability.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const startDay = civilDayNumber(formatter, now);
  const endDay = civilDayNumber(formatter, dueAt);

  let total = 0;
  for (let civilDay = startDay; civilDay < endDay; civilDay += 86_400_000) {
    const utcWeekday = new Date(civilDay).getUTCDay();
    const weekday = (utcWeekday === 0 ? 7 : utcWeekday) as Weekday;
    total += availability.minutesByWeekday[weekday];
  }

  return total;
}

function civilDayNumber(formatter: Intl.DateTimeFormat, date: Date): number {
  let year = 0;
  let month = 0;
  let day = 0;

  for (const part of formatter.formatToParts(date)) {
    if (part.type === "year") {
      year = Number(part.value);
    } else if (part.type === "month") {
      month = Number(part.value);
    } else if (part.type === "day") {
      day = Number(part.value);
    }
  }

  return Date.UTC(year, month - 1, day);
}
