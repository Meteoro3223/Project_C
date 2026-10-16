# ADR-0002: Pure domain core with no I/O

## Status

Accepted.

## Context

The priority engine must be explainable and easy to test: pressure, tiers, ranking,
and later the weekly planner (PLAN sections 6 and 7). Mixing it with HTTP, database
access, or system clocks would make the golden scenarios (S1–S10) and property tests
hard to write and flaky around timezones and DST.

## Decision

Keep `packages/core` pure with no I/O (PLAN D5):

- It imports nothing from this repo and performs no I/O.
- All functions are deterministic: the current time enters as an explicit `now: Date`
  parameter; `core` never calls `new Date()` or `Date.now()`.
- Durations are integer minutes everywhere; timestamps are stored in UTC and
  calendar-day logic uses the workspace timezone (default `Europe/Madrid`) (PLAN D6).
- No randomness in `core`.
- Dependency rules: `shared` may import types from `core`; `api` may import `core`
  and `shared`; `web` may import `shared` and types from `core` but never recomputes
  rankings or plans.

## Consequences

- The engine and planner are tested in memory with fixed fixtures, including DST
  transitions for `Europe/Madrid`; no mocks or database needed.
- The API remains the source of truth: services call `core`, repositories handle
  Prisma access, routes validate input with Zod.
- Date/time library choice for calendar-day arithmetic is deferred to P1-T2, which
  records it in its own ADR.
