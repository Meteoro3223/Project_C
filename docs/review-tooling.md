# Review tooling

Operating manual for `pnpm mutate` and `pnpm review:packet`. The scripts live in
`tools/review/` and are intentionally dependency-light: Node, `tsx`, `vitest`
and `zod` (already used by the repo).

## Running mutations

```sh
pnpm mutate .review/mutations.json
pnpm mutate .review/mutations.json --timeout 300
```

- `--timeout <seconds>` is the limit for the whole test run (pnpm → vitest →
  workers). It defaults to **180 seconds**. On Windows the entire process tree
  is killed with `taskkill /pid <pid> /T /F`.
- Before any mutation, the script runs the spec's `tests` **unmutated**. A red
  baseline aborts the run with exit code 1, prints the failing test names and
  the sentence `baseline is red, no mutation was run`. This keeps a mutation
  result from looking "killed" when the suite was already broken.
- If any test path is under `apps/api/`, the API test database is prepared once
  before the baseline. Nothing re-migrates it during the run.

### Exit codes

| Code | Meaning                                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Every mutation was detected (KILLED or TIMEOUT).                                                                                              |
| 1    | At least one SURVIVED, KILLED_BY_OTHER, INVALID or ERROR; or a bad spec, red baseline, restore-verification failure, or changed working tree. |

## Spec shape

```json
{
  "task": "P1-T3",
  "tests": ["packages/core/src/priority.test.ts"],
  "mutations": [
    {
      "id": "M1",
      "file": "packages/core/src/priority.ts",
      "find": "return pressure * weight;",
      "replace": "return pressure + weight;",
      "expectKilledBy": "pressure increases monotonically"
    }
  ]
}
```

| Field                        | Rules                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `task`                       | Non-empty label written to `.review/mutations.md`.                                        |
| `tests`                      | One or more repo-relative test paths. Passed to `vitest run`; no spaces or shell metas.   |
| `mutations[].id`             | Unique, non-empty.                                                                        |
| `mutations[].file`           | Repo-relative file. Must exist, must be a regular file, cannot escape the repo or `.git`. |
| `mutations[].find`           | Exact text that must occur **exactly once**. A missing/ambiguous match is INVALID.        |
| `mutations[].replace`        | Replacement text; may be empty.                                                           |
| `mutations[].expectKilledBy` | Optional substring of the full test name. Omit to accept any failing test.                |

Only TypeScript/JavaScript source covered by the listed tests is meaningful.
The runner uses the Vitest JSON reporter
(`--reporter=json --outputFile=.review/vitest-result.json`, deleted and
rewritten on every run) and reads failed full names from that report. There is
no console-text parsing.

## Result meanings

| Result            | Meaning                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KILLED`          | The run failed and at least one failed test parsed from the JSON matches `expectKilledBy` (or no expectation was given).                                                |
| `KILLED_BY_OTHER` | The run failed but the failed tests do not match `expectKilledBy`. Review whether the mutation was caught for the right reason.                                         |
| `SURVIVED`        | The tests passed with the mutation applied. Strengthen the tests; do not weaken the mutation.                                                                           |
| `INVALID`         | The mutation could not be applied (find text missing/ambiguous, path rejected), or the target is unsupported.                                                           |
| `ERROR`           | The run failed without a single failed test in the JSON report: transform/compile error, crash, database down, Vitest did not start. Shows the first 3 lines of output. |
| `TIMEOUT`         | The process tree exceeded `--timeout`. It counts as detected and is displayed as `(timeout)`.                                                                           |

A non-zero exit with zero parsed failed tests is never reported as KILLED.

## Unsupported targets and limitations

- **TypeScript source only.** Markdown, JSON, CSS, `.d.ts`, generated files and
  files not imported by the chosen tests are not reliable mutation targets.
- **No Prisma schema or migration mutations.** Files under `apps/api/prisma/`
  (including `schema.prisma` and `migrations/`) and any `.prisma` file are
  refused as INVALID. The test database is prepared once, so the change would
  not take effect. Verify those by hand.
- **No generated Prisma client mutations.** Files under `generated/prisma/` or
  `.prisma/` are refused as INVALID because they need `prisma generate` to take
  effect. Verify those by hand.
- **One database state per run.** A mutation that changes migration state or
  seed data is out of scope for the same reason.
- **Exact replacement only.** Whitespace and line endings must match `find`.
- **Timeout budget.** Pick a limit above the cold-start time of the suite; an
  ERROR from a slow start is still safer than a false KILLED.

## Backups and crash recovery

Before writing a mutation the runner stores:

- `.review/backup/<relative-path>` — the original file contents.
- `.review/backup/<relative-path>.mutated.sha256` — the sha256 of the **mutated**
  contents that were written.

After a test run the original is written back, re-read, and its sha256 compared
with the original's. A mismatch prints a loud `RESTORE VERIFICATION FAILED`
error and exits 1.

At startup the runner also inspects `.review/backup/`. A backup is restored
only when the current file's sha256 equals the mutated hash in the sidecar —
that is, the previous process crashed while the mutation was still in place.
Otherwise the file is left untouched, the backup is kept, and a warning tells
you to inspect the file with `git diff -- <path>` and remove the backup
manually. A backup without a sidecar is treated the same way.

`.review/` is git-ignored; backups never appear in a commit.

## Review packet and clipboard

`pnpm review:packet` (`--skip-check` to skip `pnpm check`) builds the packet.

- "Commits ahead" and the diff stat are computed against **`origin/main`**.
  If `origin/main` does not exist, it falls back to local `main` and the packet
  header says so: `- Diff base: main (origin/main not found; falling back to main)`.
- On Windows the packet is copied with PowerShell `Set-Clipboard`, reading a
  temporary UTF-8 file with an explicit `[Text.Encoding]::UTF8`. Going through
  PowerShell stdin or `clip.exe` UTF-8 stdin was not reliable for non-ASCII text
  (`áéíóúñ ×`) on this repository's Windows setup; the temp file is deleted
  afterwards.
- If the clipboard is unavailable the packet is still printed; the print-only
  fallback is always kept.

## Fixed template for `.review/report.md`

Use these section names verbatim:

```md
# Review report: <task id or chore name>

## Summary

<2-4 sentences: what changed and why.>

## Files changed

- `path/to/file`: <what changed>

## Isolation audit

<State "Not applicable: this change does not touch data access." when true,
but keep the table visible so the reviewer sees it was considered.>

| Prisma call            | file:line                              | where includes workspaceId?    |
| ---------------------- | -------------------------------------- | ------------------------------ |
| `prisma.task.findMany` | `apps/api/src/repositories/task.ts:42` | yes (`where: { workspaceId }`) |

## Assumptions

- <decision, default or limitation the reviewer should know.>

## Proposed mutations

- `M1`: `<file>`, <change>, expected KILLED by tests containing `<name>`.
- `M2`: `<file>`, <change>, expected INVALID, reason: <reason>.
```

The proposed mutations must also be written to `.review/mutations.json` in the
spec shape above and run with `pnpm mutate`.
