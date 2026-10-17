import type { RankableTask } from "@proyecto-c/core";

// P0-T6 placeholder wiring check. It proves `shared` resolves
// `@proyecto-c/core` from source (see docs/adr/0003-workspace-package-resolution.md):
// the runtime value is exercised in index.test.ts, the type here.
// Replaced by the real Zod schemas and DTO types in P2.
export const SHARED_PLACEHOLDER = "shared" as const;

export type SharedPlaceholder = typeof SHARED_PLACEHOLDER;

/** Re-exported from `core` so workspace type resolution stays covered (ADR-0003). */
export type { RankableTask };
