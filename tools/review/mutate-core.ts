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

export type MutationResult = "KILLED" | "KILLED_BY_OTHER" | "SURVIVED" | "INVALID";

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

const ESCAPE = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function extractFailingTests(output: string): string[] {
  const names = new Set<string>();

  for (const line of stripAnsi(output).split(/\r?\n/)) {
    const failMatch = /^\s*FAIL\s+(.+)$/u.exec(line);
    if (failMatch !== null) {
      const [, rest] = failMatch;
      if (rest !== undefined) {
        const parts = rest.split(" > ");
        const name = parts.length > 1 ? parts.slice(1).join(" > ").trim() : rest.trim();
        if (name.length > 0) {
          names.add(name);
        }
      }
    }

    const crossMatch = /^\s*[×✗✕]\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*(?:ms|s))?\s*$/u.exec(line);
    if (crossMatch !== null) {
      const [, name] = crossMatch;
      if (name !== undefined && name.trim().length > 0) {
        names.add(name.trim());
      }
    }
  }

  return [...names];
}
