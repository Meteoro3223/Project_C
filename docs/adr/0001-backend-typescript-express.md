# ADR-0001: Backend in TypeScript with Express

## Status

Accepted.

## Context

The stack needs one backend serving a JSON API under `/api/v1` and, in production,
the `web` build from the same origin (PLAN D9). The priority engine and planner live
in `packages/core` and must be reused by the API without duplication (PLAN D4, D5).

Two options were considered:

1. **Node.js + Express + TypeScript**: one language across `web`, `api`, `core`,
   and `shared`.
2. **ASP.NET Core (C#)**: would showcase C#, but the engine would have to be
   duplicated in C# or isolated behind a second service, with no product benefit
   here. C# is covered by other portfolio projects.

## Decision

Use Node.js with Express and TypeScript for `apps/api` (PLAN D2). Express is
minimal and unopinionated, which fits the layered structure (`routes` →
`controllers` → `services` → `repositories`) and the `createApp()` / `listen()`
split used for Supertest. Prisma provides typed Postgres access and migrations
(PLAN D3).

## Consequences

- `core` and `shared` are imported directly by the API with no port or translation
  layer; `web` never recomputes rankings or plans.
- One toolchain (pnpm workspaces, Vitest, typescript-eslint) covers the whole repo.
- No C# backend in this project, by design; see Context for the reason.
- Production packaging (Docker image, migrations on deploy) is deferred to P3-T4.
