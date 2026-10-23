/**
 * Pure domain types for the priority engine (PLAN section 6).
 *
 * This module has no I/O, no dependencies and no side effects; see
 * `docs/adr/0002-pure-core.md`. All functions elsewhere in `core` receive
 * `now` as a parameter so nothing here relies on the system clock.
 */

export type Importance = "LOW" | "MEDIUM" | "HIGH";

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Task lifecycle status, mapped from the Prisma enum at the API boundary. */
export type TaskStatus = "TODO" | "IN_PROGRESS" | "DONE";

/** Priority tier, ordered from most to least urgent. */
export type Tier = "OVERDUE" | "CRITICAL" | "AT_RISK" | "ON_TRACK";

/** Machine-readable explanation codes; the UI translates them to Spanish. */
export type ReasonCode =
  "OVERDUE" | "NO_TIME_LEFT" | "TIGHT_SCHEDULE" | "HIGH_IMPORTANCE" | "COMFORTABLE";

/** The minimal task shape the priority engine needs (PLAN section 6, Input). */
export interface RankableTask {
  readonly id: string;
  readonly dueAt: Date;
  readonly importance: Importance;
  readonly remainingMinutes: number;
  readonly status: TaskStatus;
}

/**
 * Weekly capacity per ISO weekday, in integer minutes, plus the timezone used
 * for calendar-day arithmetic. Named `WeeklyAvailability` to avoid clashing
 * with the Prisma `Availability` model in `apps/api`.
 */
export interface WeeklyAvailability {
  readonly minutesByWeekday: Readonly<Record<Weekday, number>>;
  readonly timezone: string;
}

/** One entry of the ranking produced by the engine (PLAN section 6, Output). */
export interface RankedTask {
  readonly taskId: string;
  /** 1-based position in the ranking. */
  readonly rank: number;
  readonly tier: Tier;
  readonly pressure: number;
  readonly noCapacity: boolean;
  readonly importanceWeight: number;
  readonly score: number;
  readonly remainingMinutes: number;
  readonly availableMinutes: number;
  readonly daysUntilDue: number;
  readonly reasons: readonly ReasonCode[];
}
