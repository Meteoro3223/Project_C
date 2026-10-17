# Proyecto_C (provisional name)

Workload planner: enter tasks with deadlines, importance and estimated effort,
and get an answer to "what should I do today to hit my deadlines without
overloading myself?" using an explainable priority engine.

> The name is provisional. Code uses the slug `proyecto-c` for package scopes
> (`@proyecto-c/*`) and a single `APP_NAME` constant for display.

## Repository layout

```text
apps/web        React + TypeScript + Vite + Tailwind
apps/api        Express + TypeScript + Prisma
packages/core   pure domain logic: types, priority engine, planner
packages/shared Zod schemas and DTO types shared by api and web
docs/           data model, engine spec, ADRs
```

See `PLAN.md` (source of truth) and `AGENTS.md` (working conventions).

## Prerequisites

- Node `24` (see `.nvmrc` and `engines`)
- pnpm `11.9.0` (see `packageManager`)
- Docker Desktop running (Postgres runs in a container)

## Quick start

```sh
copy .env.example .env
pnpm install
pnpm db:up
pnpm dev
```

The API serves `GET /api/v1/health` (reports `db: up` when Postgres is
reachable) and the web app proxies to it during development.

## Install

```sh
pnpm install
```

Tooling scripts (`dev`, `build`, `lint`, `typecheck`, `test`, `check`) are
defined in P0-T2.
