# Priority engine

The priority engine answers one question for the Today view: **which pending task
should I work on first?** It turns deadlines, remaining effort, importance and
weekly availability into an explainable ranking. Every number behind the order is
exposed, so the UI can explain a result instead of presenting an opaque score.

The engine is implemented in `packages/core` and is pure and deterministic
(ADR-0002): it receives `now` as a parameter, performs no I/O and uses no
randomness. This document describes the formula and its consequences; the
architecture decisions behind it are recorded in ADR-0005 (pressure as the
priority metric) and ADR-0006 (calendar-day counting rule). The source of truth
for scope is `PLAN.md`, section 6.

## Purpose

The engine exists to make prioritisation **explicable**:

- It compares the work that remains with the time available before the deadline,
  instead of using arbitrary weights or an opaque model.
- It classifies each task into a small set of tiers and returns the breakdown
  (`pressure`, `availableMinutes`, `importanceWeight`, `score`, `reasons`) that
  produced that classification.
- It is deterministic: the same tasks, availability, `now` and configuration
  always produce the same ranking, independent of input order.

The engine ranks tasks. It does not schedule them; see [Limitations](#limitations)
and the weekly planner in `PLAN.md`, section 7.

## Inputs and outputs

`rankTasks(tasks, availability, now, config?)` is the public entry point. It
returns one entry per pending task, sorted and numbered from 1.

### Inputs

| Input          | Type                      | Meaning                                                                        |
| -------------- | ------------------------- | ------------------------------------------------------------------------------ |
| `tasks`        | `readonly RankableTask[]` | Tasks to rank. `DONE` tasks are ignored.                                       |
| `availability` | `WeeklyAvailability`      | Weekly capacity and the workspace timezone used for calendar arithmetic.       |
| `now`          | `Date`                    | The instant used as "today". It is always a parameter, never the clock.        |
| `config`       | `EngineConfig` (optional) | Thresholds, weights and `maxPressure`. See [defaults](#engineconfig-defaults). |

`RankableTask` (from `packages/core/src/types.ts`):

| Field              | Type                                | Notes                                                    |
| ------------------ | ----------------------------------- | -------------------------------------------------------- |
| `id`               | `string`                            | Unique within the call; duplicates throw a `RangeError`. |
| `dueAt`            | `Date`                              | Deadline as a UTC instant.                               |
| `importance`       | `"LOW" \| "MEDIUM" \| "HIGH"`       | Multiplies pressure in the score.                        |
| `remainingMinutes` | `number`                            | Integer minutes still needed. User-provided.             |
| `status`           | `"TODO" \| "IN_PROGRESS" \| "DONE"` | `DONE` tasks are excluded; the other two are ranked.     |

`WeeklyAvailability`:

| Field              | Type                                | Notes                                                             |
| ------------------ | ----------------------------------- | ----------------------------------------------------------------- |
| `minutesByWeekday` | `Readonly<Record<Weekday, number>>` | Integer minutes per ISO weekday (`1` = Monday … `7` = Sunday).    |
| `timezone`         | `string`                            | IANA timezone (for example `Europe/Madrid`) used for civil dates. |

Invalid dates, an invalid timezone and duplicate task ids throw a `RangeError`
with a message naming the offending value. `remainingMinutes` must be a
non-negative integer, and the computed `availableMinutes` total must also be a
non-negative integer; otherwise `calculatePressure` throws. `minutesByWeekday`
values are expected to be non-negative integers, as the domain type requires.

### Output

Each `RankedTask` contains:

| Field              | Type                                                 | Meaning                                                                                  |
| ------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `taskId`           | `string`                                             | The input task's `id`.                                                                   |
| `rank`             | `number`                                             | 1-based position after sorting.                                                          |
| `tier`             | `"OVERDUE" \| "CRITICAL" \| "AT_RISK" \| "ON_TRACK"` | Urgency class; tier dominates the score in the ordering.                                 |
| `pressure`         | `number`                                             | Remaining minutes divided by available minutes, capped at `maxPressure`.                 |
| `infeasible`       | `boolean`                                            | `true` only when minutes remain and there is no available capacity.                      |
| `importanceWeight` | `number`                                             | Weight applied to pressure for this task's importance.                                   |
| `score`            | `number`                                             | `pressure * importanceWeight`, reported unrounded.                                       |
| `remainingMinutes` | `number`                                             | Echo of the input.                                                                       |
| `availableMinutes` | `number`                                             | Capacity between today and the deadline, in integer minutes.                             |
| `daysUntilDue`     | `number`                                             | Civil-day difference from `now` to `dueAt`. It can be negative when overdue.             |
| `reasons`          | `ReasonCode[]`                                       | Machine-readable explanation codes, in display order; the UI translates them to Spanish. |

`daysUntilDue` counts civil dates, not elapsed 24-hour periods. It can be `0`
for a deadline earlier the same local day; whether a task is overdue is decided
by comparing the instants (`dueAt < now`), not by `daysUntilDue`.

## Algorithm

### 1. Validate the input and drop completed tasks

`rankTasks` validates the timezone and `now` up front, even when there is nothing
to rank, and rejects duplicate ids. It then excludes every task whose status is
`DONE`. `TODO` and `IN_PROGRESS` tasks are ranked.

### 2. Compute available minutes

For each task, `availableMinutes` sums the workspace's weekly capacity over the
**civil dates** from `now`'s local date (inclusive) up to `dueAt`'s local date
(exclusive), in the workspace timezone:

```text
availableMinutes = Σ capacity(weekday(d))
                   for every civil date d where date(now) <= d < date(dueAt)
```

Rules:

- **Today counts in full**, even when part of the day has already elapsed
  (ADR-0006).
- **The deadline's civil date is excluded.** A task due today therefore has zero
  available minutes, and a task due tomorrow counts only today.
- If the deadline's civil date is earlier than or equal to today's, the interval
  is empty and the result is `0`. This includes overdue tasks.
- Only civil dates are counted, not 24-hour periods: the 23- and 25-hour days
  around a DST transition each count as one day (ADR-0004).
- The implementation folds complete weeks for efficiency; the result is the same
  as summing day by day.

### 3. Compute pressure

Pressure compares the work left with the time available:

| Condition                                           | `pressure`                                | `infeasible` |
| --------------------------------------------------- | ----------------------------------------- | ------------ |
| `remainingMinutes === 0`                            | `0`                                       | `false`      |
| `remainingMinutes > 0` and `availableMinutes === 0` | `maxPressure` (default `10`)              | `true`       |
| otherwise                                           | `min(remaining / available, maxPressure)` | `false`      |

The cap keeps pressure finite and serializable. `infeasible` is **not** the same
as `pressure >= 1`: see [Limitations](#limitations).

### 4. Classify the tier

Tiers are evaluated top-down; the first match wins:

| Condition                                     | Tier       |
| --------------------------------------------- | ---------- |
| `dueAt < now` (instant comparison)            | `OVERDUE`  |
| `pressure >= criticalThreshold` (default `1`) | `CRITICAL` |
| `pressure >= atRiskThreshold` (default `0.5`) | `AT_RISK`  |
| anything else                                 | `ON_TRACK` |

Thresholds are inclusive: a pressure of exactly `0.5` is `AT_RISK`, and a
pressure of exactly `1` is `CRITICAL`. Overdue wins even when pressure is `0`
(there is nothing left to do, but the deadline has passed).

### 5. Apply the importance weight

| Importance | Weight |
| ---------- | ------ |
| `LOW`      | `1`    |
| `MEDIUM`   | `1.5`  |
| `HIGH`     | `2`    |

### 6. Compute the score

```text
score = pressure * importanceWeight
```

The score is reported exactly as computed (including floating-point noise).
Importance amplifies pressure, but it cannot move a task to a better tier.

### 7. Order the ranking

Tasks are sorted by:

1. **Tier**, most urgent first: `OVERDUE`, `CRITICAL`, `AT_RISK`, `ON_TRACK`.
2. **Score**, descending. For ordering only, scores are rounded to 9 decimal
   places so that mathematically equal scores do not split because of
   floating-point noise.
3. **`dueAt`**, ascending.
4. **`id`**, ascending using ordinal (UTF-16 code unit) comparison, not a
   locale-aware comparison. This makes the result independent of locale and of
   input order.

After sorting, `rank` is assigned from `1` to `n`. The result is deterministic
and independent of the order of the input array.

### 8. Attach explanation codes

`reasons` contains every code that applies, in this display order:

| Condition                                          | Code              |
| -------------------------------------------------- | ----------------- |
| Tier is `OVERDUE`                                  | `OVERDUE`         |
| `infeasible` is `true`                             | `NO_TIME_LEFT`    |
| Not infeasible and tier is `AT_RISK` or `CRITICAL` | `TIGHT_SCHEDULE`  |
| Importance is `HIGH`                               | `HIGH_IMPORTANCE` |
| Tier is `ON_TRACK`                                 | `COMFORTABLE`     |

A task can carry several codes. For example, an overdue high-importance task
with minutes left gets `OVERDUE`, `NO_TIME_LEFT` and `HIGH_IMPORTANCE`. A
critical task with zero capacity gets `NO_TIME_LEFT` instead of
`TIGHT_SCHEDULE`. The engine returns codes only; the Spanish UI copy lives in
the web app.

## EngineConfig defaults

`DEFAULT_ENGINE_CONFIG` in `packages/core/src/config.ts` holds:

| Field               | Default                            | Meaning                                                              |
| ------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `criticalThreshold` | `1`                                | Pressure at or above this value is `CRITICAL`.                       |
| `atRiskThreshold`   | `0.5`                              | Pressure at or above this value (and below critical) is `AT_RISK`.   |
| `importanceWeights` | `{ LOW: 1, MEDIUM: 1.5, HIGH: 2 }` | Multipliers used to compute the score.                               |
| `maxPressure`       | `10`                               | Upper bound for pressure; also the pressure used when capacity is 0. |

`createEngineConfig(overrides)` merges partial overrides over the defaults and
returns a deeply frozen config. It validates that:

- every threshold, `maxPressure` and importance weight is a finite number
  greater than zero;
- `atRiskThreshold < criticalThreshold`;
- `maxPressure >= criticalThreshold`;
- `LOW <= MEDIUM <= HIGH` for the importance weights.

Violations throw a `RangeError` naming the offending field. The scenario tests
below use the defaults.

## Worked examples (S1–S3)

All examples use the fixture from `packages/core/src/scenarios.test.ts`:

- **Availability:** `180` minutes every day, ISO weekdays `1` to `7`.
- **Timezone:** `Europe/Madrid`.
- **`now`:** Monday 12 October 2026, 09:00 local (`2026-10-12T07:00:00Z`).
- **Deadlines:** 18:00 local unless stated otherwise.
- **Config:** `DEFAULT_ENGINE_CONFIG`.

With this fixture, a deadline on a later civil date counts `180 * daysUntilDue`
available minutes.

### S1: base example — tier first, then score

| Task | Due (local)       | `daysUntilDue` | `availableMinutes` | `remainingMinutes` | Importance (weight) | Pressure      | Tier       | Score         | Reasons                             |
| ---- | ----------------- | -------------- | ------------------ | ------------------ | ------------------- | ------------- | ---------- | ------------- | ----------------------------------- |
| A    | Wed 14 Oct, 18:00 | 2              | 360                | 240                | `HIGH` (2)          | `2/3 ≈ 0.667` | `AT_RISK`  | `4/3 ≈ 1.333` | `TIGHT_SCHEDULE`, `HIGH_IMPORTANCE` |
| B    | Sat 17 Oct, 18:00 | 5              | 900                | 180                | `MEDIUM` (1.5)      | `1/5 = 0.2`   | `ON_TRACK` | `0.3`         | `COMFORTABLE`                       |
| C    | Thu 22 Oct, 18:00 | 10             | 1800               | 360                | `HIGH` (2)          | `1/5 = 0.2`   | `ON_TRACK` | `0.4`         | `HIGH_IMPORTANCE`, `COMFORTABLE`    |

- A is the only `AT_RISK` task, so tier alone puts it first; its score is only
  compared with other tasks in the same tier.
- B and C have the same pressure (`0.2`). C's `HIGH` weight (`2`) is higher than
  B's `MEDIUM` weight (`1.5`), so C's score is `0.4` against B's `0.3`.
- **Result: A, C, B.** A is due Wednesday, so it counts Monday and Tuesday:
  `360` minutes. B is due Saturday, so it counts Monday to Friday: `900`
  minutes. C is due in ten days: `1800` minutes.

### S2: a long task with a distant deadline

| Task | Due (local)       | `daysUntilDue` | `availableMinutes` | `remainingMinutes` | Importance (weight) | Pressure      | Tier       | Score         | Reasons                          |
| ---- | ----------------- | -------------- | ------------------ | ------------------ | ------------------- | ------------- | ---------- | ------------- | -------------------------------- |
| L    | Thu 22 Oct, 18:00 | 10             | 1800               | 1200               | `MEDIUM` (1.5)      | `2/3 ≈ 0.667` | `AT_RISK`  | `1.0`         | `TIGHT_SCHEDULE`                 |
| Q    | Tue 13 Oct, 18:00 | 1              | 180                | 60                 | `HIGH` (2)          | `1/3 ≈ 0.333` | `ON_TRACK` | `2/3 ≈ 0.667` | `HIGH_IMPORTANCE`, `COMFORTABLE` |

L has a later deadline than Q, but it needs `1200` of the `1800` minutes
available, so its pressure is `2/3`. Q needs only `60` of `180` minutes, so its
pressure is `1/3`. Tier dominates: L is `AT_RISK` and Q is `ON_TRACK`.
**Result: L, Q.** A distant deadline does not sink a task when the remaining
effort is large relative to the time available.

### S3: overdue tasks

| Task | Due (local)       | `daysUntilDue` | `availableMinutes` | `remainingMinutes` | Importance (weight) | Pressure      | Tier      | `infeasible` | Score | Reasons                                      |
| ---- | ----------------- | -------------- | ------------------ | ------------------ | ------------------- | ------------- | --------- | ------------ | ----- | -------------------------------------------- |
| O1   | Fri 9 Oct, 18:00  | -3             | 0                  | 60                 | `LOW` (1)           | `10` (max)    | `OVERDUE` | `true`       | `10`  | `OVERDUE`, `NO_TIME_LEFT`                    |
| O2   | Fri 9 Oct, 18:00  | -3             | 0                  | 300                | `HIGH` (2)          | `10` (max)    | `OVERDUE` | `true`       | `20`  | `OVERDUE`, `NO_TIME_LEFT`, `HIGH_IMPORTANCE` |
| O3   | Fri 9 Oct, 18:00  | -3             | 0                  | 0                  | `LOW` (1)           | `0`           | `OVERDUE` | `false`      | `0`   | `OVERDUE`                                    |
| X    | Wed 14 Oct, 18:00 | 2              | 360                | 240                | `MEDIUM` (1.5)      | `2/3 ≈ 0.667` | `AT_RISK` | `false`      | `1.0` | `TIGHT_SCHEDULE`                             |

- O1 and O2 are overdue and still need work, so they have zero available
  minutes, pressure `maxPressure` and `infeasible = true`.
- O3 is also overdue but has nothing left: pressure `0`, `infeasible = false`.
  It is still `OVERDUE` because the deadline has passed.
- All `OVERDUE` tasks come before X, even O3 with score `0` against X's score
  `1.0`. Within the overdue tier, score decides: O2 (`20`), O1 (`10`), O3 (`0`).
- **Result: O2, O1, O3, X.** O3 covers the zero-minutes-remaining edge case and
  shows that tier outranks score: a zero-score overdue task still comes before a
  higher-scoring task in a lower tier.

## Limitations

- **Today counts in full.** The capacity of `now`'s civil date is counted
  completely, even when most of that day has already elapsed. At Monday 09:00
  the engine still counts all `180` minutes configured for Monday. The rule is
  simple and stable, but it can overestimate the time actually left today. See
  ADR-0006.

- **The deadline's civil date is excluded.** Work is assumed to happen on the
  days before `dueAt`'s local date, not on the due date itself. A task due later
  today has zero available minutes, and a task due tomorrow counts only today.
  A task whose deadline is later today is therefore `CRITICAL` and `infeasible`
  whenever minutes remain, even if there are still usable hours before the
  deadline; if the deadline has already passed today, it is `OVERDUE` and
  `infeasible` instead. This is conservative for deadlines late in the day. See
  ADR-0006.

- **`infeasible` means zero capacity, not `pressure >= 1`.** `infeasible` is
  `true` only when `remainingMinutes > 0` and `availableMinutes === 0`. The flag
  is not a general feasibility verdict. With the default thresholds, a
  non-overdue task with pressure at or above `1` is `CRITICAL`, and pressure
  above `1` means the task cannot be
  finished with the configured availability even though `infeasible = false`:
  `240` remaining of `240` available gives pressure `1` and
  `infeasible = false`; `3000` remaining of `180` available is capped at
  `maxPressure` and also has `infeasible = false`. A pressure equal to
  `maxPressure` can therefore come either from the cap or from zero capacity;
  only the latter sets `infeasible` and adds `NO_TIME_LEFT`.

- **Scores that differ by less than `1e-9` count as tied for ordering.** The
  comparator rounds each score to 9 decimal places before comparing, so
  differences below that scale fall through to `dueAt` and then `id`. The
  reported `score` is not rounded. (Strictly, values less than `1e-9` apart can
  still land on different sides of a rounding boundary at that scale; this is an
  ordering detail, not a change to the formula.)

- **Results depend on the runtime's timezone database.** Civil dates come from
  `Intl.DateTimeFormat` and the IANA timezone data shipped with the runtime.
  Two runtimes with different tzdata versions can disagree for a zone whose
  rules changed, so CI and production must use a maintained Node image. See
  ADR-0004.

- **`remainingMinutes` is user-provided.** The engine does not infer it from
  study sessions or from `estimatedMinutes`; it trusts the stored value. A stale
  value produces stale pressure. Phase 4 updates it from recorded sessions with
  confirmation, but the engine still receives it as an input.

- **No planner yet.** This document describes ranking, not scheduling. The
  engine says which task is most urgent; it does not decide which day to work on
  it, reserve blocks, or detect that a week is collectively overloaded. The
  weekly planner (cumulative feasibility, deficits and EDF allocation) is phase 5
  and is specified in `PLAN.md`, section 7. A set of tasks can each have pressure
  at most `1` and still overload the week together (scenario S9).

- **Weekly capacity only.** Availability is a repeating weekly pattern. Holidays,
  exam weeks and one-off changes are not part of `availableMinutes`; per-date
  exceptions are optional in phase 5.

## Related documents

- [ADR-0002: Pure domain core with no I/O](adr/0002-pure-core.md)
- [ADR-0004: Calendar-day arithmetic with `Intl.DateTimeFormat`](adr/0004-calendar-day-arithmetic.md)
- [ADR-0005: Pressure as the priority metric](adr/0005-pressure-as-priority-metric.md)
- [ADR-0006: Calendar-day counting rule](adr/0006-calendar-day-counting-rule.md)
- `PLAN.md`, sections 6 (priority engine), 7 (weekly planner) and 13 (risks)
- `packages/core/src/scenarios.test.ts` — golden scenarios S1–S8
