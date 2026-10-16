import { CORE_PLACEHOLDER } from "@proyecto-c/core";
import type { CorePlaceholder } from "@proyecto-c/core";

// P0-T6 placeholder wiring check. It proves `shared` resolves
// `@proyecto-c/core` from source (see docs/adr/0003-workspace-package-resolution.md).
// Replaced by the real Zod schemas and DTO types in P2.
export const SHARED_PLACEHOLDER: CorePlaceholder = CORE_PLACEHOLDER;

export type SharedPlaceholder = typeof SHARED_PLACEHOLDER;
