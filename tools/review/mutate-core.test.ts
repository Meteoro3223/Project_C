import { describe, expect, it } from "vitest";
import {
  applyExactlyOnce,
  countOccurrences,
  extractFailingTests,
  formatZodError,
  mutationSpecSchema,
  renderMutationTable,
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
});

describe("extractFailingTests", () => {
  it("reads Vitest FAIL and cross-marked test lines after stripping ANSI", () => {
    const output = [
      "\u001b[31m FAIL \u001b[0m apps/api/src/foo.test.ts > suite > rejects bad input",
      "   × rejects bad input 5ms",
      " FAIL  apps/api/src/bar.test.ts > other > works",
    ].join("\n");

    const names = extractFailingTests(output);
    expect(names).toContain("suite > rejects bad input");
    expect(names).toContain("rejects bad input");
    expect(names).toContain("other > works");
  });

  it("returns an empty list when no test failure is present", () => {
    expect(extractFailingTests("Test Files  1 passed (1)")).toEqual([]);
  });
});
