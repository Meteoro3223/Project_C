# ADR-0004: Calendar-day arithmetic with `Intl.DateTimeFormat`, no date library

## Status

Accepted.

## Context

`availableMinutes` (PLAN section 6, step 2, implemented in P1-T2) must sum the
workspace's capacity for every calendar day from `now` (inclusive, counted in
full) up to the civil date of the deadline (exclusive). PLAN section 13 left the
date-library choice open for phase 1, so this record closes it.

The difficulty is that "a day" is a calendar concept, not a fixed number of
hours. In `Europe/Madrid` the DST transitions on 2026-03-29 and 2026-10-25 make
those days 23 and 25 hours long, so summing hours — or adding `86_400_000 ms` to
a local timestamp — would count the wrong number of days.

`core` stays pure (ADR-0002): no clock, no I/O, all functions receive `now`.

This record covers the _mechanism_ only. The counting rule itself (today counts
in full, the deadline's civil date is excluded) is specified in PLAN section 6
and gets its own ADR in P1-T7, together with the engine formula.

## Decision

Use the platform, not a library:

- Map an instant to a **civil date** (year, month, day) in the workspace timezone
  with `Intl.DateTimeFormat` and `formatToParts`, so no formatted string is
  parsed.
- Turn that civil date into a **civil day index** with
  `Date.UTC(year, month - 1, day)`. UTC has no DST, so the difference between two
  indexes is an exact whole number of calendar days, and iterating day indexes
  never produces 23- or 25-hour days.
- Derive each day's ISO weekday from the same index with `getUTCDay()`.

Options considered and rejected:

- **`date-fns` + `date-fns-tz`, or Luxon:** additional dependencies (AGENTS,
  Dependencies) for functionality the runtime already provides. We need
  instant → civil-date conversion and integer day arithmetic, nothing else.
- **Temporal (or a polyfill):** the right long-term primitive, but its
  availability and TypeScript types are not settled across the Node and browser
  versions we target. Revisit once it is stable in Node LTS; the two helpers
  above are the only call sites and would be a contained swap.

## Consequences

- No new dependency; `core` keeps using only the standard library.
- **Results depend on the runtime's timezone database** (full ICU in Node 24).
  Two runtimes with different tzdata versions could disagree for a zone whose
  rules changed, so CI and production must use a maintained Node image.
- An invalid timezone throws a `RangeError` naming the value instead of silently
  falling back to UTC.
- `Intl.DateTimeFormat` instances are memoised per timezone, because construction
  is comparatively expensive and deterministic.
- The day-by-day sum is folded into whole weeks plus a remainder of fewer than
  seven days, so cost is independent of the horizon length.
- If Temporal replaces these helpers later, `docs/priority-engine.md` (P1-T7)
  and the DST tests must be revisited in the same change.
