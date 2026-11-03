import { z } from "zod";

export const mutationSchema = z
  .object({
    id: z.string().trim().min(1, "id must be a non-empty string"),
    file: z.string().trim().min(1, "file must be a non-empty string"),
    find: z.string().min(1, "find must be a non-empty string"),
    replace: z.string(),
    expectKilledBy: z.string().trim().min(1).optional(),
  })
  .strict();

export const mutationSpecSchema = z
  .object({
    task: z.string().trim().min(1, "task must be a non-empty string"),
    tests: z.array(z.string().trim().min(1)).min(1, "tests must contain at least one path"),
    mutations: z.array(mutationSchema).min(1, "mutations must contain at least one entry"),
  })
  .strict()
  .refine(
    (spec) => new Set(spec.mutations.map((mutation) => mutation.id)).size === spec.mutations.length,
    {
      message: "mutation ids must be unique",
      path: ["mutations"],
    },
  );

export type MutationSpec = z.infer<typeof mutationSpecSchema>;
export type Mutation = z.infer<typeof mutationSchema>;

export type MutationResult =
  "KILLED" | "KILLED_BY_OTHER" | "SURVIVED" | "INVALID" | "ERROR" | "TIMEOUT";

export interface MutationTableRow {
  id: string;
  location: string;
  result: MutationResult;
  failingTest: string;
}

export interface AppliedMutation {
  ok: true;
  content: string;
  line: number;
}

export interface RejectedMutation {
  ok: false;
  reason: string;
}

export type MutationApplication = AppliedMutation | RejectedMutation;

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
      return `- ${location}: ${issue.message}`;
    })
    .join("\n");
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }

  let count = 0;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) {
      return count;
    }
    count += 1;
    from = index + needle.length;
  }
}

export function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text[cursor] === "\n") {
      line += 1;
    }
  }
  return line;
}

export function applyExactlyOnce(
  source: string,
  find: string,
  replace: string,
): MutationApplication {
  if (find.length === 0) {
    return { ok: false, reason: "find text must not be empty" };
  }

  const count = countOccurrences(source, find);
  if (count === 0) {
    return { ok: false, reason: "find text not found" };
  }
  if (count > 1) {
    return { ok: false, reason: `find text occurs ${count} times (expected exactly 1)` };
  }

  const index = source.indexOf(find);
  const content = `${source.slice(0, index)}${replace}${source.slice(index + find.length)}`;
  return { ok: true, content, line: lineNumberAt(source, index) };
}

function markdownCell(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
}

export function renderMutationTable(rows: readonly MutationTableRow[]): string {
  const header = "| ID | file:line | result | failing test |";
  const separator = "| --- | --- | --- | --- |";
  const body = rows.map(
    (row) =>
      `| ${markdownCell(row.id)} | ${markdownCell(row.location)} | ${markdownCell(row.result)} | ${markdownCell(row.failingTest)} |`,
  );
  return [header, separator, ...body].join("\n");
}

export function renderMutationReport(task: string, rows: readonly MutationTableRow[]): string {
  return `# Mutation results: ${task}\n\n${renderMutationTable(rows)}\n`;
}

export interface VitestReport {
  failedTests: string[];
  messages: string[];
  totalTests: number;
  succeeded: boolean;
}

export type VitestParseResult = { ok: true; report: VitestReport } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Reads the JSON reporter output written by Vitest. Only assertions that the
 * reporter marks as failed are trusted; a run that failed without any failed
 * assertion (transform error, crash, missing database) is not a killed mutant.
 */
export function parseVitestResult(raw: string): VitestParseResult {
  if (raw.trim().length === 0) {
    return { ok: false, reason: "vitest did not write a JSON report" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `invalid vitest JSON report: ${message}` };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.testResults)) {
    return { ok: false, reason: "unexpected vitest JSON report shape: missing testResults" };
  }

  const failed = new Set<string>();
  const messages = new Set<string>();
  let totalTests = 0;

  for (const file of parsed.testResults) {
    if (!isRecord(file)) {
      continue;
    }
    const message = nonEmptyString(file.message);
    if (message !== null) {
      messages.add(message);
    }
    if (!Array.isArray(file.assertionResults)) {
      continue;
    }
    for (const assertion of file.assertionResults) {
      if (!isRecord(assertion)) {
        continue;
      }
      totalTests += 1;
      if (assertion.status !== "failed") {
        continue;
      }
      const name = nonEmptyString(assertion.fullName) ?? nonEmptyString(assertion.title);
      if (name !== null) {
        failed.add(name);
      }
    }
  }

  return {
    ok: true,
    report: {
      failedTests: [...failed],
      messages: [...messages],
      totalTests,
      succeeded: parsed.success === true,
    },
  };
}

export interface TestRunOutcome {
  exitCode: number | null;
  output: string;
  failedTests: readonly string[];
  totalTests: number;
  expectedKilledBy?: string | undefined;
  timedOut: boolean;
}

export interface ClassifiedRun {
  result: MutationResult;
  failingTest: string;
}

export interface BaselineVerdict {
  green: boolean;
  zeroTests: boolean;
}

export const ZERO_TESTS_MESSAGE =
  "the test run executed zero tests (the root vitest config sets passWithNoTests: true)";

/**
 * A green run proves nothing when Vitest executed no tests. The root config
 * sets `passWithNoTests: true`, so this must be checked explicitly.
 */
export function zeroTests(
  outcome: Pick<TestRunOutcome, "timedOut" | "exitCode" | "totalTests">,
): boolean {
  return !outcome.timedOut && outcome.exitCode === 0 && outcome.totalTests === 0;
}

export function baselineVerdict(outcome: TestRunOutcome): BaselineVerdict {
  return {
    green: !outcome.timedOut && outcome.exitCode === 0 && outcome.totalTests > 0,
    zeroTests: zeroTests(outcome),
  };
}

export function firstLines(text: string, count: number): string {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("count must be a positive integer");
  }

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const head = lines.slice(0, count).join("\n").trimEnd();
  return head.length > 0 ? head : "(no output)";
}

/**
 * Maps a test run to a mutation result. KILLED requires at least one failed
 * test parsed from the JSON report; a non-zero exit without one is ERROR.
 */
export function classifyRun(outcome: TestRunOutcome): ClassifiedRun {
  if (outcome.timedOut) {
    return { result: "TIMEOUT", failingTest: "(timeout)" };
  }
  if (outcome.exitCode === null) {
    return { result: "ERROR", failingTest: firstLines(outcome.output, 3) };
  }
  if (zeroTests(outcome)) {
    return { result: "ERROR", failingTest: ZERO_TESTS_MESSAGE };
  }
  if (outcome.exitCode === 0) {
    return { result: "SURVIVED", failingTest: "(none)" };
  }
  if (outcome.failedTests.length === 0) {
    return { result: "ERROR", failingTest: firstLines(outcome.output, 3) };
  }

  const firstFailure = outcome.failedTests[0] ?? "(unknown test)";
  const expected = outcome.expectedKilledBy;
  if (expected !== undefined && !outcome.failedTests.some((name) => name.includes(expected))) {
    return { result: "KILLED_BY_OTHER", failingTest: firstFailure };
  }
  return { result: "KILLED", failingTest: firstFailure };
}

export function shouldRestoreBackup(currentSha256: string | null, mutatedSha256: string): boolean {
  return (
    currentSha256 !== null &&
    currentSha256.trim().toLowerCase() === mutatedSha256.trim().toLowerCase()
  );
}

const PRISMA_REASON =
  "Prisma schema and migration files cannot be mutation-tested here: the API test database is prepared once, so the change would not take effect. Verify this mutation manually.";
const GENERATED_PRISMA_REASON =
  "This file needs a regenerated Prisma client to take effect, and the API test database is prepared once. Verify this mutation manually.";

/**
 * Returns a rejection reason when a mutation cannot be observed by the
 * prepared test database (Prisma schema, migrations or generated client).
 */
export function mutationTargetRejection(file: string): string | null {
  const normalized = file
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "")
    .toLowerCase();

  if (normalized === "apps/api/prisma" || normalized.startsWith("apps/api/prisma/")) {
    return PRISMA_REASON;
  }
  if (normalized.endsWith(".prisma")) {
    return PRISMA_REASON;
  }
  if (/(^|\/)prisma\/schema\.prisma$/u.test(normalized)) {
    return PRISMA_REASON;
  }
  if (/(^|\/)prisma\/migrations(\/|$)/u.test(normalized)) {
    return PRISMA_REASON;
  }
  if (/(^|\/)(?:generated\/prisma|\.prisma)\//u.test(normalized)) {
    return GENERATED_PRISMA_REASON;
  }

  return null;
}
