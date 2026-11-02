import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyExactlyOnce,
  extractFailingTests,
  formatZodError,
  mutationSpecSchema,
  renderMutationTable,
  type MutationSpec,
  type MutationTableRow,
} from "./mutate-core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reviewDir = path.join(repoRoot, ".review");
const backupDir = path.join(reviewDir, "backup");

interface RepoPath {
  absolute: string;
  relative: string;
}

interface CommandResult {
  exitCode: number | null;
  output: string;
  error?: string;
}

interface ActiveMutation {
  absolute: string;
  relative: string;
  original: Buffer;
}

let activeMutation: ActiveMutation | null = null;
let activeChild: ChildProcess | null = null;
let handlingSignal = false;

function print(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function toDisplayPath(relative: string): string {
  return relative.replaceAll(path.sep, "/");
}

function resolveRepoPath(input: string): RepoPath {
  if (input.length === 0 || input.includes("\0")) {
    throw new Error(`Invalid repo-relative path: "${input}".`);
  }
  if (path.isAbsolute(input)) {
    throw new Error(`Path must be relative to the repository root: "${input}".`);
  }

  const absolute = path.resolve(repoRoot, input);
  const relative = path.relative(repoRoot, absolute);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path escapes the repository root: "${input}".`);
  }

  const components = relative.split(path.sep).map((component) => component.toLowerCase());
  if (components.includes(".git")) {
    throw new Error(`Refusing to touch .git: "${input}".`);
  }

  return { absolute, relative };
}

function assertExistingRepoFile(input: string): RepoPath {
  const resolved = resolveRepoPath(input);
  if (!existsSync(resolved.absolute)) {
    throw new Error(`File not found: "${input}".`);
  }

  const realRoot = realpathSync(repoRoot);
  const realFile = realpathSync(resolved.absolute);
  const realRelative = path.relative(realRoot, realFile);
  if (
    realRelative === "" ||
    realRelative === ".." ||
    realRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(realRelative)
  ) {
    throw new Error(`Refusing to mutate a path outside the repository: "${input}".`);
  }
  if (!statSync(realFile).isFile()) {
    throw new Error(`Not a regular file: "${input}".`);
  }

  return { absolute: realFile, relative: realRelative };
}

function assertRepoTestPath(input: string): void {
  const resolved = resolveRepoPath(input);
  if (!existsSync(resolved.absolute)) {
    throw new Error(`Test path not found: "${input}".`);
  }
  if (input.startsWith("-") || /[&|<>^"'`\s]/u.test(input)) {
    throw new Error(`Test path contains unsupported characters: "${input}".`);
  }
}

function walkFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function pruneEmptyDirectories(directory: string): void {
  if (!existsSync(directory)) {
    return;
  }

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      pruneEmptyDirectories(path.join(directory, entry.name));
    }
  }

  if (readdirSync(directory).length === 0) {
    rmSync(directory, { recursive: true, force: true });
  }
}

function restoreActiveMutation(reason: string): void {
  if (activeMutation === null) {
    return;
  }

  const current = activeMutation;
  activeMutation = null;
  try {
    writeFileSync(current.absolute, current.original);
    const backupPath = path.join(backupDir, current.relative);
    if (existsSync(backupPath)) {
      rmSync(backupPath, { force: true });
    }
    pruneEmptyDirectories(backupDir);
    print(`Restored ${toDisplayPath(current.relative)} (${reason}).`);
  } catch (error) {
    console.error(`FAILED to restore ${toDisplayPath(current.relative)}:`, error);
  }
}

function recoverBackups(): void {
  const backups = walkFiles(backupDir);
  if (backups.length === 0) {
    return;
  }

  const restored: string[] = [];
  for (const backup of backups) {
    const relative = path.relative(backupDir, backup);
    const { absolute } = resolveRepoPath(relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, readFileSync(backup));
    rmSync(backup, { force: true });
    restored.push(toDisplayPath(relative));
  }
  pruneEmptyDirectories(backupDir);

  print(`Recovered ${restored.length} file(s) from .review/backup/: ${restored.join(", ")}`);
}

function backupFile(absolute: string, relative: string): void {
  const backupPath = path.join(backupDir, relative);
  mkdirSync(path.dirname(backupPath), { recursive: true });
  writeFileSync(backupPath, readFileSync(absolute));
}

function installCleanupHandlers(): void {
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (handlingSignal) {
      return;
    }
    handlingSignal = true;
    activeChild?.kill("SIGTERM");
    restoreActiveMutation(signal);
    process.exit(130);
  };

  process.on("SIGINT", () => {
    handleSignal("SIGINT");
  });
  process.on("SIGTERM", () => {
    handleSignal("SIGTERM");
  });
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => {
      handleSignal("SIGBREAK");
    });
  }
  process.on("exit", () => {
    restoreActiveMutation("process exit");
  });
}

function runPnpm(args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const options = {
      cwd: repoRoot,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    };
    // Node deprecates shell:true with an args array. On Windows we pass one
    // pre-joined command string instead; test paths are validated to contain
    // no whitespace or shell metacharacters before they reach this function.
    const child =
      process.platform === "win32"
        ? spawn(["pnpm", ...args].join(" "), { ...options, shell: true })
        : spawn("pnpm", args, options);
    activeChild = child;

    let output = "";
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (activeChild === child) {
        activeChild = null;
      }
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish({ exitCode: null, output, error: error.message });
    });
    child.on("close", (exitCode) => {
      finish({ exitCode, output });
    });
  });
}

function git(args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function workingTreeSnapshot(): string {
  return git(["status", "--porcelain=v1", "--untracked-files=all"]);
}

function parseSpec(specArg: string): MutationSpec | null {
  let raw: string;
  try {
    raw = readFileSync(resolveRepoPath(specArg).absolute, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Cannot read mutation spec "${specArg}": ${message}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Invalid JSON in "${specArg}": ${message}`);
    return null;
  }

  const result = mutationSpecSchema.safeParse(parsed);
  if (!result.success) {
    console.error(`Invalid mutation spec "${specArg}":\n${formatZodError(result.error)}`);
    return null;
  }

  try {
    for (const testPath of result.data.tests) {
      assertRepoTestPath(testPath);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return null;
  }

  return result.data;
}

function needsTestDatabase(tests: readonly string[]): boolean {
  return tests.some((testPath) => {
    const normalized = testPath.replaceAll("\\", "/");
    return normalized.startsWith("apps/api/");
  });
}

async function prepareTestDatabase(spec: MutationSpec): Promise<boolean> {
  if (!needsTestDatabase(spec.tests)) {
    return true;
  }

  print("Preparing the API test database...");
  const result = await runPnpm(["db:test:prepare"]);
  if (result.exitCode !== 0) {
    console.error("Failed to prepare the API test database; no mutations were run.");
    if (result.error !== undefined) {
      console.error(result.error);
    }
    print(result.output.trimEnd());
    process.exitCode = 1;
    return false;
  }
  return true;
}

async function runMutation(
  spec: MutationSpec,
  mutation: MutationSpec["mutations"][number],
): Promise<MutationTableRow> {
  let location = `${mutation.file}:?`;
  const expected = mutation.expectKilledBy;

  try {
    const target = assertExistingRepoFile(mutation.file);
    const original = readFileSync(target.absolute);
    const applied = applyExactlyOnce(original.toString("utf8"), mutation.find, mutation.replace);
    if (!applied.ok) {
      return { id: mutation.id, location, result: "INVALID", failingTest: applied.reason };
    }

    location = `${toDisplayPath(target.relative)}:${applied.line}`;
    backupFile(target.absolute, target.relative);
    activeMutation = { absolute: target.absolute, relative: target.relative, original };
    writeFileSync(target.absolute, applied.content, "utf8");

    print(`[${mutation.id}] running tests against ${location}...`);
    const result = await runPnpm(["exec", "vitest", "run", ...spec.tests]);
    const failingTests = extractFailingTests(result.output);

    if (result.exitCode === null) {
      return {
        id: mutation.id,
        location,
        result: "INVALID",
        failingTest: `test command failed: ${result.error ?? "unknown error"}`,
      };
    }
    if (result.exitCode === 0) {
      return { id: mutation.id, location, result: "SURVIVED", failingTest: "(none)" };
    }

    const firstFailure = failingTests[0] ?? "tests failed (no test name parsed)";
    if (expected !== undefined && !failingTests.some((name) => name.includes(expected))) {
      return { id: mutation.id, location, result: "KILLED_BY_OTHER", failingTest: firstFailure };
    }
    return { id: mutation.id, location, result: "KILLED", failingTest: firstFailure };
  } catch (error) {
    return {
      id: mutation.id,
      location,
      result: "INVALID",
      failingTest: error instanceof Error ? error.message : String(error),
    };
  } finally {
    restoreActiveMutation("finally");
  }
}

function writeMutationReport(spec: MutationSpec, rows: readonly MutationTableRow[]): void {
  const markdown = `# Mutation results: ${spec.task}\n\n${renderMutationTable(rows)}\n`;
  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(path.join(reviewDir, "mutations.md"), markdown, "utf8");
  print(markdown.trimEnd());
}

function verifyWorkingTree(before: string): boolean {
  const after = workingTreeSnapshot();
  if (before === after) {
    print("Working tree unchanged after the mutation run.");
    return true;
  }

  console.error("WORKING TREE CHANGED DURING THE MUTATION RUN");
  console.error("Before:");
  console.error(before.length > 0 ? before : "(clean)");
  console.error("After:");
  console.error(after.length > 0 ? after : "(clean)");
  console.error("Inspect the tree with git status/diff and restore any unintended changes.");
  return false;
}

async function main(): Promise<void> {
  installCleanupHandlers();
  recoverBackups();

  const specArg = process.argv[2];
  if (specArg === undefined) {
    console.error("Usage: pnpm mutate <spec.json>");
    process.exitCode = 1;
    return;
  }

  const spec = parseSpec(specArg);
  if (spec === null) {
    process.exitCode = 1;
    return;
  }

  const before = workingTreeSnapshot();

  if (!(await prepareTestDatabase(spec))) {
    return;
  }

  const rows: MutationTableRow[] = [];
  for (const mutation of spec.mutations) {
    const row = await runMutation(spec, mutation);
    rows.push(row);
    print(
      `[${mutation.id}] ${row.result}${row.result === "KILLED" || row.result === "KILLED_BY_OTHER" ? ` (${row.failingTest})` : ""}`,
    );
  }

  writeMutationReport(spec, rows);

  const failed = rows.some(
    (row) =>
      row.result === "SURVIVED" || row.result === "INVALID" || row.result === "KILLED_BY_OTHER",
  );
  if (failed) {
    process.exitCode = 1;
  }

  if (!verifyWorkingTree(before)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
