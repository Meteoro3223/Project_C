# AGENTS.md

Instructions for AI coding agents (OpenCode) working in this repository.
Humans: the product/architecture plan lives in `PLAN.md` (Spanish). This file is the operating manual.

## Project in one paragraph

**Proyecto_C** (provisional name) is a workload planner: the user enters tasks with deadlines, importance and estimated effort, and the app answers "what should I do today to hit my deadlines without overloading myself?" using an **explainable priority engine** (not an opaque AI). The public demo uses **anonymous workspaces** (no accounts).

The name is provisional. Do not hardcode it: use the slug `proyecto-c` for package scopes (`@proyecto-c/*`) and a single `APP_NAME` constant for display.

## Source of truth

1. `PLAN.md` — scope, architecture, data model, engine spec, phases and tasks (`P0-T1`, `P1-T3`, ...).
2. `docs/adr/` — architecture decision records. Read the relevant ones before changing structure.
3. This file — conventions.

If these conflict with a request, stop and ask instead of guessing.

## Working agreement

- Work on **one task ID at a time**, exactly as written in `PLAN.md`. Never start the next phase on your own.
- Before writing code, state your approach in a few lines. If the task is ambiguous, ask one focused question.
- When a task is done: run `pnpm check`, tick its checkbox in `PLAN.md`, and propose a Conventional Commit message.
- Do not add features, dependencies or abstractions that the current task does not need.
- If you make a design decision that affects structure, libraries or behaviour, write a short ADR in `docs/adr/` (template in `docs/adr/0000-template.md`).
- Never change the priority formula, thresholds or the scenario tests in `packages/core` without updating `docs/priority-engine.md` and the tests in the same change, and flagging it explicitly.

## Commands

Defined in task `P0-T2`. If a script is missing, create it there rather than inventing an alternative.

| Command                                      | Purpose                                           |
| -------------------------------------------- | ------------------------------------------------- |
| `pnpm install`                               | install dependencies                              |
| `pnpm dev`                                   | run web and api in development                    |
| `pnpm check`                                 | lint + typecheck + test (run before every commit) |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | individual checks                                 |
| `pnpm build`                                 | production build of all packages                  |
| `pnpm db:up`                                 | start Postgres via Docker Compose                 |
| `pnpm db:migrate` / `pnpm db:seed`           | Prisma migrations / demo seed                     |

## Repository layout and dependency rules

```text
apps/web        React + TypeScript + Vite + Tailwind
apps/api        Express + TypeScript + Prisma
packages/core   pure domain logic: types, priority engine, planner
packages/shared Zod schemas and DTO types shared by api and web
docs/           data model, engine spec, ADRs
```

Allowed imports:

- `core` imports **nothing** from this repo and has **no I/O**.
- `shared` may import types from `core`.
- `api` may import `core` and `shared`.
- `web` may import `shared` and types from `core`. The web app never recomputes rankings or plans; the API is the source of truth.

## Code conventions

**General**

- Language: code, comments, commit messages, docs and README in **English**. UI copy in **Spanish (es-ES)**, centralised in one module (no i18n framework in v1).
- TypeScript `strict`, plus `noUncheckedIndexedAccess`. No `any`. No non-null assertions (`!`) without a comment explaining why.
- Prefer named exports. Prefer string-literal unions over TS `enum`. Map Prisma enums to unions at the repository boundary.
- Validate all external input with Zod at the edge (API routes). Never trust types alone for request data.

**Time and units**

- Durations are **integer minutes** everywhere. Never floats for time.
- Store timestamps in UTC. Calendar-day logic (e.g. availability per day) uses the workspace timezone (default `Europe/Madrid`).
- Inside `core`, never call `new Date()` or `Date.now()`. Receive `now: Date` as a parameter so everything is deterministic and testable.
- No randomness in `core`.

**API (`apps/api`)**

- Layers: `routes` (HTTP + validation) → `controllers` (request/response) → `services` (business rules) → `repositories` (Prisma access).
- Build the app through a `createApp()` factory, separate from `listen()`, so Supertest can use it.
- Error response shape: `{ "error": { "code": string, "message": string, "details"?: unknown } }`. Use typed error classes, one central error handler.
- All routes live under `/api/v1`.

**Web (`apps/web`)**

- Functional components and hooks. Server state with TanStack Query. No business logic in components.
- Typed API client built on the `shared` schemas.
- Accessible by default: semantic HTML, labelled inputs, keyboard-usable controls, visible focus. Provide empty and error states.

## Workspace isolation (critical)

Every row of user data belongs to a workspace. Isolation bugs are the worst bugs in this project.

- `workspaceId` comes **only** from the authenticated session cookie, never from the request body, query or URL.
- Repositories take `workspaceId` as a **mandatory first parameter** and include it in every query (including updates and deletes).
- Every new resource needs a test proving workspace A cannot read, update or delete workspace B's data.
- The cookie holds a random secret; only its hash is stored in the database. Flags: `HttpOnly`, `SameSite=Lax`, `Secure` in production.
- Keep limits in place: request body size cap, per-workspace quotas, rate limiting.

## Testing

- Vitest. Tests sit next to the source as `*.test.ts`.
- `core`: table-driven tests for the engine scenarios in `PLAN.md`, plus property-style tests (determinism, input-order independence, monotonicity). Include DST transition cases for `Europe/Madrid`.
- `api`: Supertest against a **real Postgres test database**. Do not mock the database. Reset data between tests.
- Every feature ships with tests. Every bug fix ships with a regression test.
- Do not weaken or delete a failing test to make the build pass; fix the cause or ask.

## Git

- One branch per task: `feat/p1-t3-pressure`, `fix/...`, `docs/...`, `chore/...`.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`). Small, focused commits.
- Never commit secrets. Keep `.env.example` current; real `.env` files stay untracked.
- No force-push to `main`.

## Dependencies

- Prefer the platform and the standard library. Every new dependency needs a one-line justification in the commit or ADR.
- Commit the lockfile. Do not upgrade major versions as a side effect of another task.

## Out of scope for v1 (do not build unless a task says so)

User accounts and authentication, native mobile app, real-time collaboration, notifications, generative AI, `.ics`/CSV import, subtasks, i18n framework, university-platform integrations.

## Definition of done

A task is done only when all of these hold:

1. Acceptance criteria in `PLAN.md` are met.
2. `pnpm check` passes.
3. New behaviour has tests, including edge cases.
4. Docs updated if behaviour, schema or structure changed (`docs/data-model.md`, `docs/priority-engine.md`, ADRs).
5. The task's checkbox in `PLAN.md` is ticked.
