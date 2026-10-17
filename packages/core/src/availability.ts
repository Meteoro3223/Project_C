import type { Weekday, WeeklyAvailability } from "./types.js";

/** Milliseconds in a civil (calendar) day. Civil days never have 23 or 25 hours. */
const MS_PER_CIVIL_DAY = 86_400_000;

/** Locale used only to obtain numeric date parts; no formatted string is parsed. */
const CIVIL_DATE_LOCALE = "en-GB";

const WEEKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7];

/**
 * Civil-date formatters per IANA timezone. Constructing an `Intl.DateTimeFormat`
 * is deterministic but comparatively expensive, so instances are memoised. The
 * cache is bounded by the timezones the process sees (workspace configurations),
 * not by call count.
 */
const civilDateFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Available minutes until a deadline (PLAN section 6, step 2).
 *
 * Sums the workspace's weekly capacity over every calendar day from the civil
 * date of `now` (inclusive, counted in full) up to the civil date of `dueAt`
 * (exclusive), in the workspace timezone. Because only calendar days are
 * counted, the 23- and 25-hour days around a DST transition count as one day
 * each; see `docs/adr/0004-calendar-day-arithmetic.md`.
 *
 * Pure and deterministic: `now` is a parameter. Throws a `RangeError` naming the
 * value for an invalid timezone, and one naming the argument for an invalid
 * `now` or `dueAt`.
 */
export function availableMinutes(availability: WeeklyAvailability, now: Date, dueAt: Date): number {
  assertValidDate("now", now);
  assertValidDate("dueAt", dueAt);

  const formatter = getCivilDateFormatter(availability.timezone);
  const startDay = civilDayNumber(formatter, now);
  const endDay = civilDayNumber(formatter, dueAt);

  const days = (endDay - startDay) / MS_PER_CIVIL_DAY;
  // Due today, overdue, or a deadline earlier today: nothing left to plan.
  if (days <= 0) {
    return 0;
  }

  const weekTotal = WEEKDAYS.reduce(
    (total, weekday) => total + availability.minutesByWeekday[weekday],
    0,
  );
  const fullWeeks = Math.floor(days / 7);
  const remainingDays = days % 7;

  let total = fullWeeks * weekTotal;
  let weekday = isoWeekdayOfCivilDay(startDay);

  for (let index = 0; index < remainingDays; index += 1) {
    total += availability.minutesByWeekday[weekday];
    weekday = nextWeekday(weekday);
  }

  return total;
}

/** Throws a `RangeError` naming the argument when `date` is an invalid `Date`. */
function assertValidDate(argument: "now" | "dueAt", date: Date): void {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid ${argument} date: ${String(date)}`);
  }
}

/** Returns the formatter for `timezone`, or throws a `RangeError` naming it. */
function getCivilDateFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = civilDateFormatters.get(timezone);
  if (cached !== undefined) {
    return cached;
  }

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat(CIVIL_DATE_LOCALE, {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch (error) {
    throw new RangeError(`Invalid timezone: ${timezone}`, { cause: error });
  }

  civilDateFormatters.set(timezone, formatter);
  return formatter;
}

/**
 * Civil day index of `date` in the formatter's timezone: the UTC-midnight
 * timestamp of that calendar date. UTC has no DST, so the difference between two
 * indexes is an exact whole number of calendar days.
 */
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

/** ISO weekday (1 = Monday ... 7 = Sunday) of a {@link civilDayNumber}. */
function isoWeekdayOfCivilDay(civilDay: number): Weekday {
  // `getUTCDay()` returns 0 = Sunday ... 6 = Saturday for a valid civil day.
  const utcWeekday = new Date(civilDay).getUTCDay();
  return (utcWeekday === 0 ? 7 : utcWeekday) as Weekday;
}

/** Next ISO weekday, wrapping Sunday (7) back to Monday (1). */
function nextWeekday(weekday: Weekday): Weekday {
  return (weekday === 7 ? 1 : weekday + 1) as Weekday;
}
