import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyExactlyOnce,
  baselineVerdict,
  classifyRun,
  countOccurrences,
  firstLines,
  formatZodError,
  mutationSpecSchema,
  mutationTargetRejection,
  parseVitestResult,
  renderMutationReport,
  renderMutationTable,
  shouldRestoreBackup,
  zeroTests,
  ZERO_TESTS_MESSAGE,
} from "./mutate-core";

const firstMutation = {
  id: "M1",
  file: "apps/api/src/x.ts",
  find: "return true;",
  replace: "return false;",
};

const validSpec = {
  task: "P2-T3",
  tests: ["apps/api/src/foo.test.ts"],
  mutations: [firstMutation],
};

describe("mutationSpecSchema", () => {
  it("accepts a valid spec", () => {
    const result = mutationSpecSchema.safeParse(validSpec);
    expect(result.success).toBe(true);
  });

  it("rejects unknown keys", () => {
    const result = mutationSpecSchema.safeParse({ ...validSpec, extra: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatZodError(result.error)).toContain("Unrecognized key");
      expect(formatZodError(result.error)).toContain("extra");
    }
  });

  it("rejects duplicate mutation ids", () => {
    const result = mutationSpecSchema.safeParse({
      ...validSpec,
      mutations: [firstMutation, { ...firstMutation, id: "M1", file: "apps/api/src/y.ts" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatZodError(result.error)).toContain("mutation ids must be unique");
    }
  });

  it("rejects an empty find string with a clear path", () => {
    const result = mutationSpecSchema.safeParse({
      ...validSpec,
      mutations: [{ ...firstMutation, find: "" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatZodError(result.error)).toContain("mutations.0.find");
      expect(formatZodError(result.error)).toContain("find must be a non-empty string");
    }
  });
});

describe("applyExactlyOnce", () => {
  it("replaces the single occurrence and reports its line", () => {
    const result = applyExactlyOnce("one\ntwo\nthree\n", "two", "TWO");
    expect(result).toEqual({ ok: true, content: "one\nTWO\nthree\n", line: 2 });
  });

  it("rejects text that is absent", () => {
    const result = applyExactlyOnce("one\ntwo\n", "missing", "x");
    expect(result).toEqual({ ok: false, reason: "find text not found" });
  });

  it("rejects text that occurs more than once", () => {
    const result = applyExactlyOnce("same\nsame\n", "same", "other");
    expect(result).toEqual({
      ok: false,
      reason: "find text occurs 2 times (expected exactly 1)",
    });
  });
});

describe("countOccurrences", () => {
  it("counts non-overlapping occurrences", () => {
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("aaaa", "a")).toBe(4);
    expect(countOccurrences("abc", "z")).toBe(0);
  });

  it("treats an empty needle as zero occurrences", () => {
    expect(countOccurrences("abc", "")).toBe(0);
  });
});

describe("renderMutationTable", () => {
  it("renders the required columns and escapes cell content", () => {
    const table = renderMutationTable([
      {
        id: "M|1",
        location: "apps/api/src/x.ts:4",
        result: "KILLED",
        failingTest: "suite | test\nsecond line",
      },
      {
        id: "M2",
        location: "apps/api/src/y.ts:?",
        result: "INVALID",
        failingTest: "find text not found",
      },
    ]);

    expect(table.split("\n")[0]).toBe("| ID | file:line | result | failing test |");
    expect(table).toContain(
      "| M\\|1 | apps/api/src/x.ts:4 | KILLED | suite \\| test<br>second line |",
    );
    expect(table).toContain("| M2 | apps/api/src/y.ts:? | INVALID | find text not found |");
  });

  it("renders ERROR and TIMEOUT rows", () => {
    const table = renderMutationTable([
      {
        id: "M3",
        location: "tools/review/x.ts:1",
        result: "ERROR",
        failingTest: "Transform failed\nsecond line",
      },
      {
        id: "M4",
        location: "tools/review/y.ts:2",
        result: "TIMEOUT",
        failingTest: "(timeout)",
      },
    ]);

    expect(table).toContain(
      "| M3 | tools/review/x.ts:1 | ERROR | Transform failed<br>second line |",
    );
    expect(table).toContain("| M4 | tools/review/y.ts:2 | TIMEOUT | (timeout) |");
  });
});

describe("renderMutationReport", () => {
  it("writes the task heading and the mutation table", () => {
    const report = renderMutationReport("CHORE", [
      {
        id: "M1",
        location: "tools/review/x.ts:1",
        result: "SURVIVED",
        failingTest: "(none)",
      },
    ]);

    expect(report.startsWith("# Mutation results: CHORE\n\n")).toBe(true);
    expect(report).toContain("| ID | file:line | result | failing test |");
    expect(report).toContain("| M1 | tools/review/x.ts:1 | SURVIVED | (none) |");
  });
});

describe("parseVitestResult", () => {
  it("reads failed full names from the sample JSON fixture", () => {
    const raw = readFileSync(
      new URL("./fixtures/vitest-result.sample.json", import.meta.url),
      "utf8",
    );
    const parsed = parseVitestResult(raw);

    expect(parsed).toEqual({
      ok: true,
      report: {
        failedTests: ["tempo rejects bad input", "tempo still fails"],
        messages: ["Transform failed with 1 error"],
        totalTests: 3,
        succeeded: false,
      },
    });
  });

  it("accepts a successful report with no failures", () => {
    const parsed = parseVitestResult(
      JSON.stringify({
        success: true,
        numFailedTests: 0,
        testResults: [
          {
            assertionResults: [{ fullName: "works", status: "passed", title: "works" }],
          },
        ],
      }),
    );

    expect(parsed).toEqual({
      ok: true,
      report: { failedTests: [], messages: [], totalTests: 1, succeeded: true },
    });
  });

  it("rejects an empty report", () => {
    const parsed = parseVitestResult("  ");
    expect(parsed).toEqual({ ok: false, reason: "vitest did not write a JSON report" });
  });

  it("rejects invalid JSON", () => {
    const parsed = parseVitestResult("{not json");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain("invalid vitest JSON report");
    }
  });

  it("rejects a report without testResults", () => {
    const parsed = parseVitestResult(JSON.stringify({ success: false }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain("missing testResults");
    }
  });
});

describe("firstLines", () => {
  it("keeps only the first lines and normalises CRLF", () => {
    expect(firstLines("one\r\ntwo\r\nthree\r\nfour", 3)).toBe("one\ntwo\nthree");
  });

  it("returns a placeholder for empty output", () => {
    expect(firstLines("\n\n", 3)).toBe("(no output)");
  });

  it("rejects an invalid count", () => {
    expect(() => firstLines("one", 0)).toThrow("count must be a positive integer");
  });
});

describe("classifyRun", () => {
  const passing = {
    exitCode: 0,
    output: "Test Files  1 passed (1)",
    failedTests: [],
    totalTests: 1,
    timedOut: false,
  };

  it("marks a timeout as detected and shows (timeout)", () => {
    expect(classifyRun({ ...passing, exitCode: 1, timedOut: true })).toEqual({
      result: "TIMEOUT",
      failingTest: "(timeout)",
    });
  });

  it("marks an unstarted command as ERROR", () => {
    expect(classifyRun({ ...passing, exitCode: null, output: "spawn pnpm ENOENT" })).toEqual({
      result: "ERROR",
      failingTest: "spawn pnpm ENOENT",
    });
  });

  it("marks a green run as SURVIVED", () => {
    expect(classifyRun(passing)).toEqual({ result: "SURVIVED", failingTest: "(none)" });
  });

  it("marks a failed run with no parsed failure as ERROR with the first 3 lines", () => {
    const output = [
      "Transform failed with 1 error",
      "tools/review/x.ts:1:44: ERROR: Unexpected end of file",
      "",
      "fourth line is hidden",
    ].join("\n");

    expect(classifyRun({ ...passing, exitCode: 1, output, failedTests: [] })).toEqual({
      result: "ERROR",
      failingTest:
        "Transform failed with 1 error\ntools/review/x.ts:1:44: ERROR: Unexpected end of file",
    });
  });

  it("marks a failed run with a matching failed test as KILLED", () => {
    expect(
      classifyRun({
        ...passing,
        exitCode: 1,
        failedTests: ["suite rejects bad input"],
        expectedKilledBy: "rejects",
      }),
    ).toEqual({ result: "KILLED", failingTest: "suite rejects bad input" });
  });

  it("marks a failed run with an unrelated failing test as KILLED_BY_OTHER", () => {
    expect(
      classifyRun({
        ...passing,
        exitCode: 1,
        failedTests: ["suite rejects bad input"],
        expectedKilledBy: "accepts",
      }),
    ).toEqual({ result: "KILLED_BY_OTHER", failingTest: "suite rejects bad input" });
  });

  it("marks a failed run without an expectation as KILLED", () => {
    expect(
      classifyRun({ ...passing, exitCode: 1, failedTests: ["suite rejects bad input"] }),
    ).toEqual({ result: "KILLED", failingTest: "suite rejects bad input" });
  });
});

describe("zero-test guard", () => {
  const greenWithoutTests = {
    exitCode: 0,
    output: "No test files found",
    failedTests: [],
    totalTests: 0,
    timedOut: false,
  };

  it("marks a green run with zero executed tests as ERROR, never SURVIVED", () => {
    expect(classifyRun(greenWithoutTests)).toEqual({
      result: "ERROR",
      failingTest: ZERO_TESTS_MESSAGE,
    });
  });

  it("rejects a baseline that executed zero tests", () => {
    expect(baselineVerdict(greenWithoutTests)).toEqual({ green: false, zeroTests: true });
  });

  it("accepts a baseline that executed at least one test", () => {
    expect(baselineVerdict({ ...greenWithoutTests, totalTests: 1 })).toEqual({
      green: true,
      zeroTests: false,
    });
  });

  it("does not treat timeouts or failing runs as the zero-test case", () => {
    expect(zeroTests({ ...greenWithoutTests, timedOut: true })).toBe(false);
    expect(zeroTests({ ...greenWithoutTests, exitCode: 1 })).toBe(false);
  });
});

describe("shouldRestoreBackup", () => {
  const hash = "a".repeat(64);

  it("restores when the current file still has the mutated hash", () => {
    expect(shouldRestoreBackup(hash, hash)).toBe(true);
    expect(shouldRestoreBackup(hash.toUpperCase(), `${hash}\n`)).toBe(true);
  });

  it("keeps the backup when the file changed or disappeared", () => {
    expect(shouldRestoreBackup("b".repeat(64), hash)).toBe(false);
    expect(shouldRestoreBackup(null, hash)).toBe(false);
  });
});

describe("mutationTargetRejection", () => {
  const manual = /verify this mutation manually/iu;

  it.each([
    "apps/api/prisma/schema.prisma",
    "apps/api/prisma/migrations/001_init/migration.sql",
    "apps\\api\\prisma\\migrations\\001_init\\migration.sql",
    "apps/api/prisma",
    "apps/api/prisma/",
    "packages/shared/schema.prisma",
  ])("rejects the Prisma path %s", (file) => {
    const reason = mutationTargetRejection(file);
    expect(reason).not.toBeNull();
    expect(reason).toContain("Prisma");
    expect(reason).toMatch(manual);
  });

  it.each([
    "apps/api/generated/prisma/client.ts",
    "packages/db/generated/prisma/index.ts",
    "node_modules/.prisma/client/index.d.ts",
  ])("rejects the generated Prisma client path %s", (file) => {
    const reason = mutationTargetRejection(file);
    expect(reason).not.toBeNull();
    expect(reason).toContain("regenerated Prisma client");
    expect(reason).toMatch(manual);
  });

  it.each([
    "tools/review/mutate-core.ts",
    "apps/api/src/routes/tasks.ts",
    "packages/core/priority.ts",
    "apps/web/src/features/today.tsx",
  ])("allows the ordinary source path %s", (file) => {
    expect(mutationTargetRejection(file)).toBeNull();
  });
});
