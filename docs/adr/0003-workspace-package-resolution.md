# ADR-0003: Resolve workspace packages from source in development

> Note: numbers 0001 (backend TypeScript/Express) and 0002 (pure `core`) are
> reserved for P0-T8, which also introduces the ADR template. This record covers
> only the P0-T6 resolution choice.

## Status

Accepted.

## Context

`packages/core` and `packages/shared` must be importable from `api`, `web`, and
each other. Two options were considered:

1. `exports` pointing at TypeScript source (`./src/index.ts`).
2. `exports` pointing at a built `dist/` output, requiring a build before use.

## Decision

Option 1 for development: both packages expose `./src/index.ts` via the
`exports` field. Vite, Vitest, `tsx`, and `tsc` typechecking all resolve the
TypeScript source directly, so `pnpm check` works with no prior build step.

Production bundling of the workspace packages (how the `api` Docker image and
`tsc` emit handle the bare `@proyecto-c/*` specifiers at runtime) is deferred
to P3-T4, which owns the production build.

## Consequences

- `pnpm check` needs no build step; `shared` imports `core` via `workspace:*`.
- No `dist/` output is committed or required during development.
- P3-T4 must ensure the production `api` build resolves or bundles the
  workspace sources instead of shipping bare specifiers Node cannot run.
