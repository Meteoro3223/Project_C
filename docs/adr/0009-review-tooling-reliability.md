# ADR-0009: Trustworthy mutation results and safe review-tool recovery

## Status

Accepted.

## Context

The mutation runner merged in PR #22 decided KILLED vs SURVIVED by parsing
console text with regular expressions. A compile error, a crashed worker or a
database that was down could produce a non-zero exit with no test name and be
reported as "killed" for the wrong reason. A red baseline had the same effect:
the run looked meaningful even though the suite was already failing.

The runner also prepared the API test database once. Mutating
`apps/api/prisma/` or a generated Prisma client could never take effect, so
those targets are misleading.

Backups were restored unconditionally at startup. If a developer edited a file
after a crash, the startup restore could silently overwrite that edit. The
packet compared against local `main`, which drifts from `origin/main`, and
`clip.exe` with UTF-8 stdin mangled non-ASCII text on Windows.

## Decision

- **Structured test results.** Vitest writes
  `.review/vitest-result.json` with `--reporter=json` on every run (deleted
  first). KILLED requires at least one failed full name in that report. A
  non-zero exit without one is ERROR, with the first three output lines.
- **Baseline gate.** The same tests run unmutated before any mutation. A red
  baseline aborts with exit code 1 and the exact message
  `baseline is red, no mutation was run`.
- **Timeouts.** Each run has a per-mutation budget (`--timeout`, default 180 s).
  The whole process tree is killed (`taskkill /pid <pid> /T /F` on Windows) and
  the result is TIMEOUT, which counts as detected and is displayed as
  `(timeout)`.
- **Unsupported targets.** Prisma schema/migrations and generated Prisma client
  paths are INVALID with a reason that says to verify them manually.
- **Hash-guarded recovery.** Each backup has a `.mutated.sha256` sidecar. A
  backup is restored only when the current file still has the mutated hash;
  otherwise it is kept with a warning to inspect it with `git diff`. Every
  restore is re-read and hash-verified, and a mismatch exits 1.
- **Diff base.** The packet uses `origin/main` for "commits ahead" and the diff
  stat, falling back to local `main` with a header note when `origin/main` is
  missing.
- **Clipboard.** On Windows the packet is written to a temporary UTF-8 file and
  copied with PowerShell `Set-Clipboard` using an explicit UTF-8 encoding.
  PowerShell stdin encoding and `clip.exe` UTF-8 stdin were verified to mangle
  `áéíóúñ ×`; the file-based path round-trips. The print-only fallback remains.

## Consequences

- A mutation result can now be ERROR instead of a false KILLED; this is
  intentional and exits 1. Fix the harness or the environment, then rerun.
- Mutation runs take one extra baseline execution. That cost buys a meaningful
  result and is small compared with the mutation runs themselves.
- The runner only supports TypeScript source observed by the chosen tests.
  Prisma schema, migrations and generated artifacts must be reviewed by hand.
- Leftover `.review/backup/` entries are deliberately not auto-deleted when the
  file no longer matches the mutated hash. The developer must inspect and
  remove them.
- `docs/review-tooling.md` is the operating manual; `AGENTS.md` points to it.
  The fixed report template lives there.
