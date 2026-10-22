# ADR-0006: Calendar-day counting rule

## Status

Accepted.

## Context

`availableMinutes` turns a deadline into a capacity in integer minutes. The
inputs are an instant (`now`), an instant (`dueAt`) and a weekly capacity per ISO
weekday. The result must be deterministic, easy to explain and aligned with the
weekly availability model. The choice of mechanism (civil dates via
`Intl.DateTimeFormat`, no date library) is recorded in ADR-0004; this record
documents the counting rule itself.

Options considered:

1. **Count elapsed hours between the two instants.** It looks precise, but it
   breaks the weekly pattern down to an hourly resolution the app does not have,
   and DST transitions make some days 23 or 25 hours long. Summing hours would
   produce "magic" days and is harder to explain than counting dates.
2. **Count today partially.** Multiply today's capacity by the fraction of the
   day still available. It would be more accurate late in the day, but it
   assumes capacity is spread evenly across the day, invents a within-day model
   the user never configured and makes the result depend on the current time of
   day.
3. **Include the deadline's civil date.** It is generous, but it counts capacity
   that is only available after the deadline has passed. A task due at 09:00
   would get the whole day.
4. **Count full civil dates from today (inclusive) to the deadline's civil date
   (exclusive).** It matches the weekly availability granularity, never counts
   time after the deadline and is simple to state. It overestimates what is left
   today because today is counted in full.

## Decision

Use option 4 for v1 (PLAN section 6, step 2):

- Convert `now` and `dueAt` to civil dates in the workspace timezone.
- Sum the workspace's capacity for every civil date `d` with
  `date(now) <= d < date(dueAt)`.
- Count today in full, regardless of the time of day.
- Exclude the deadline's civil date.
- If `date(dueAt) <= date(now)`, return `0`. This covers a deadline later today
  and every overdue task.
- Count civil dates, not 24-hour periods, so a DST transition still contributes
  one day of capacity (ADR-0004).
- Fold complete weeks plus a remainder of fewer than seven days, so the cost is
  independent of the horizon length.

For example, with `180` minutes every day and `now` on Monday 09:00, a deadline
on Wednesday counts Monday and Tuesday (`360` minutes), and a deadline on
Thursday counts Monday, Tuesday and Wednesday (`540` minutes).

## Consequences

- The rule is simple to explain: "the days between today and the day before the
  deadline". It maps directly onto the weekly availability the user configures.
- Counting today in full can overestimate the remaining capacity today. At
  23:00, the engine still counts the whole day's capacity. This is accepted for
  v1 because there is no within-day schedule to subtract from.
- Excluding the deadline's civil date is conservative for deadlines late in the
  day. A task whose deadline is later today has `0` available minutes, so if
  minutes remain it is `CRITICAL` and `infeasible`, even when there are still
  usable hours before 18:00. If the deadline has already passed today, the task
  is `OVERDUE` instead, and still `infeasible` when minutes remain. The
  `NO_TIME_LEFT` reason explains the feasibility side to the user.
- A task due tomorrow counts only today; a task due in two days counts today and
  tomorrow. This matches the example in PLAN section 6.
- DST transitions do not create 23- or 25-hour "days"; each civil date counts
  once, so `Europe/Madrid` scenarios S8 and the DST tests remain stable.
- Availability is a weekly pattern only. Holidays, exam weeks and one-off changes
  are not modelled; per-date exceptions remain optional work for phase 5.
- If a future version introduces intra-day scheduling or a partial-day model,
  this rule must be revisited together with `availableMinutes`, its tests and
  this ADR. Changing it now would change every pressure, tier and ranking.
- Overdue tasks get `0` available minutes by construction. With minutes still
  remaining, pressure becomes `maxPressure` and `infeasible` becomes `true`; with
  nothing remaining, pressure is `0` and the task is still `OVERDUE` because the
  instant comparison in the tier rule is independent of `availableMinutes`.
- `daysUntilDue` uses the same civil-date difference. It can be `0` for a
  deadline earlier the same local day while the task is already `OVERDUE`,
  because overdue is decided by comparing instants, not by `daysUntilDue`.
