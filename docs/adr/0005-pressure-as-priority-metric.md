# ADR-0005: Pressure as the priority metric

## Status

Accepted.

## Context

The Today view must order pending tasks and explain the result. The inputs are a
deadline, an importance level, the minutes still needed and a weekly
availability pattern. The ordering has to be reproducible and testable, because
the golden scenarios (S1–S8) and the property tests added in P1-T6 depend on
it.

The project needs a metric that answers "can this task still be finished before
its deadline?" rather than "which task was entered first?" or "which task has the
highest manual priority?".

Options considered:

1. **An opaque or manually assigned score.** It can encode any preference, but it
   cannot explain itself, is hard to test and makes the ranking depend on a value
   the user cannot derive. It also conflicts with the project goal of an
   explainable engine rather than an opaque one.
2. **Deadline-only ordering (earliest due first).** It is simple, but it ignores
   how much work remains and how much capacity exists. A large task due in ten
   days can be more urgent than a small task due tomorrow, and earliest-due
   ordering cannot express that.
3. **Effort-only ordering (shortest remaining first).** It favours quick wins,
   but it can postpone large tasks until they become infeasible and says nothing
   about the time available before each deadline.
4. **Pressure: remaining minutes divided by available minutes.** It uses the
   deadline, the remaining effort and the weekly capacity together, has a
   physical meaning and can be shown to the user as a ratio. Importance can
   amplify pressure without replacing it.

Constraints: `core` is pure and deterministic (ADR-0002), durations are integer
minutes, timestamps are UTC and calendar logic uses the workspace timezone (PLAN
D6). The result must stay serializable, so pressure cannot grow without bound.

## Decision

Use **pressure** as the primary priority metric (PLAN D7):

```text
pressure = remainingMinutes / availableMinutes
```

with three explicit rules:

- no minutes remaining -> pressure `0` and `infeasible = false`;
- minutes remaining and no available capacity -> pressure `maxPressure`
  (default `10`) and `infeasible = true`;
- otherwise the ratio, capped at `maxPressure`.

The tier comes from overdue status and pressure thresholds, and the score is
`pressure * importanceWeight`:

- `OVERDUE` if `dueAt < now`;
- `CRITICAL` if pressure is at least `criticalThreshold` (default `1`);
- `AT_RISK` if pressure is at least `atRiskThreshold` (default `0.5`);
- `ON_TRACK` otherwise.

Tasks are ordered by tier, then score descending, then `dueAt` ascending, then
`id` ascending. The thresholds, weights and `maxPressure` live in
`EngineConfig`; the defaults are `1`, `0.5`, `{ LOW: 1, MEDIUM: 1.5, HIGH: 2 }`
and `10`.

The full formula, the explanation codes and worked examples are in
`docs/priority-engine.md`.

## Consequences

- The ranking is explainable: the API can return pressure, available and
  remaining minutes, the importance weight, the score and reason codes without
  recomputing anything in the web app.
- The metric is testable with table-driven scenarios and property tests:
  determinism, input-order independence, monotonicity in remaining minutes and
  the effect of a later deadline are all direct consequences of the formula.
- Importance cannot lift a task into a better tier; it only affects the order
  within a tier and the score. This keeps urgency (time) ahead of preference
  (importance).
- Pressure is a ratio, not a duration. Two tasks can share a pressure while
  needing very different amounts of work; the breakdown exposes both numbers so
  the UI can explain the difference.
- Capping at `maxPressure` saturates very overloaded tasks. Tasks with the same
  importance beyond the cap tie on score and fall through to `dueAt` and `id`.
  The `infeasible` flag and `NO_TIME_LEFT` reason distinguish zero capacity from
  a merely capped ratio.
- The metric assumes remaining work can be split and done on any available day.
  It does not model dependencies, minimum blocks or a day-by-day schedule; the
  planner in phase 5 covers that.
- The ranking is a per-task view. A set of tasks can each have pressure at most
  `1` and still overload the week together; the cumulative feasibility check
  belongs to the planner, not to this metric (scenario S9).
- Changing the formula, thresholds, weights or `maxPressure` changes behaviour
  and requires updating this ADR, `docs/priority-engine.md` and the scenario
  tests in the same change (AGENTS).
- Pressure inherits the calendar-day counting rule from ADR-0006: today counts in
  full and the deadline's civil date is excluded. Both choices affect the
  available-minutes denominator.
- The metric trusts user-provided `remainingMinutes` and availability. The engine
  cannot detect stale or overly optimistic inputs.
