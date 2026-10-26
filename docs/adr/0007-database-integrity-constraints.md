# ADR-0007: Database integrity: CHECK constraints and foreign-key actions

## Status

Accepted.

## Context

The first Prisma migration creates `Workspace`, `Course`, `Task` and
`Availability`. Prisma can model columns, enums, relations and indexes, but it
cannot express PostgreSQL `CHECK` constraints in `schema.prisma`. Some values
must still be rejected by the database even if an API validator is bypassed:

- `Task.estimatedMinutes` and `Task.remainingMinutes` cannot be negative.
- `Availability.weekday` must be an ISO weekday (1–7).
- `Availability.minutes` must fit in a day (0–1440).

Deletion behaviour also needs a decision. Deleting a workspace must remove all
of its user data. Deleting a course must not delete its tasks: the tasks stay and
become ungrouped. PostgreSQL therefore needs explicit `ON DELETE` actions on the
foreign keys.

A third question is cross-workspace integrity: `Task.courseId` references
`Course.id`, but a plain foreign key cannot guarantee that the course and the
task belong to the same workspace.

Options considered for the CHECKs:

1. **Validate only in the API.** Simple, but the database would accept invalid
   rows from seeds, manual fixes or future jobs, and the rule would live in one
   layer only.
2. **Hand-edit the generated migration and append named CHECKs.** Keeps the
   rules next to the schema, works with the existing Prisma workflow and lets
   tests assert the exact constraint names.
3. **Add database triggers.** More powerful, but harder to discover, harder to
   test and unnecessary for simple range checks.

Options considered for cross-workspace integrity:

1. **Composite foreign key** from `Task(courseId, workspaceId)` to
   `Course(id, workspaceId)`. Enforces the rule in the database, but requires an
   extra unique constraint, a more complex Prisma relation and revisiting
   `ON DELETE SET NULL` (the workspace column must remain).
2. **Service-layer enforcement.** The service loads the course with the
   authenticated `workspaceId` and rejects a mismatch. Keeps the model and
   relations simple, at the cost of one rule that the database alone cannot
   prove.

## Decision

- Keep Prisma as the schema tool and append the CHECK constraints to the initial
  migration by hand. The constraints are named:
  - `task_estimated_minutes_nonneg`
  - `task_remaining_minutes_nonneg`
  - `availability_weekday_range`
  - `availability_minutes_range`
- Do not enforce `remainingMinutes <= estimatedMinutes`: remaining effort is
  user-owned data and may legitimately differ from the original estimate.
- Foreign keys:
  - `Course.workspaceId`, `Task.workspaceId` and `Availability.workspaceId`
    reference `Workspace.id` with `ON DELETE CASCADE`.
  - `Task.courseId` references `Course.id` with `ON DELETE SET NULL`, so
    deleting a course keeps its tasks with `courseId = NULL`.
- All `DateTime` columns use `TIMESTAMPTZ(3)` so instants round-trip in UTC with
  millisecond precision.
- Cross-workspace course assignment is enforced in the service layer, not by a
  composite foreign key. P2-T4 must reject linking a task to a course from
  another workspace and cover it with an integration test.
- Never edit a migration after it has been applied or committed. If a constraint
  is wrong, reset the development database and regenerate the migration.

## Consequences

- Invalid numeric ranges fail at the database boundary, including writes that do
  not go through the API.
- Integration tests assert the constraint names, so a renamed or dropped
  constraint is visible immediately. The migration remains the source of truth;
  `schema.prisma` carries `///` comments pointing at the names.
- Workspace deletion is a single statement and cleans up all owned rows.
- Course deletion is non-destructive: tasks survive and can be reassigned.
- The service layer owns one integrity rule the database cannot express. Any
  future write path that links tasks to courses must use that service, and the
  limitation is documented in `docs/data-model.md`.
- If cross-workspace integrity must later be guaranteed at database level, it
  requires a new migration adding a composite unique key and foreign key, plus a
  review of the Prisma relation and the `SET NULL` action.
