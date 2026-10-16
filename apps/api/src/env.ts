import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PORT = 4010;

// Load the repo-root `.env` (two levels above `src/` and `dist/` alike) using
// Node's built-in env-file support. Best effort: a missing file is fine
// because CI and production provide real environment variables instead.
// Existing variables always win, so this never overrides them.
function loadEnvFile(): void {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    process.loadEnvFile(path.resolve(here, "../../.env"));
  } catch {
    // No `.env` file next to the checkout; `loadEnv()` below fails fast
    // with a clear message when a required variable is missing.
  }
}

loadEnvFile();

export interface ApiEnv {
  port: number;
  databaseUrl: string;
}

export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PORT;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_PORT;
  }
  return parsed;
}

// Fail fast at startup when a required variable is missing. Takes an explicit
// record (defaulting to `process.env`) so tests can inject values without
// mutating the global environment. No zod yet (arrives with P2 validation).
export function loadEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  const databaseUrl = env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    throw new Error(
      "DATABASE_URL is missing. Copy `.env.example` to `.env` at the repo root (or export DATABASE_URL) and retry.",
    );
  }
  return { port: parsePort(env["PORT"]), databaseUrl };
}
