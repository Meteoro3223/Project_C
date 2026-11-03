import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
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
  classifyRun,
  firstLines,
  formatZodError,
  mutationSpecSchema,
  mutationTargetRejection,
  parseVitestResult,
  renderMutationReport,
  shouldRestoreBackup,
  type MutationSpec,
  type MutationTableRow,
} from "./mutate-core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reviewDir = path.join(repoRoot, ".review");
const backupDir = path.join(reviewDir, "backup");
const vitestResultFile = path.join(reviewDir, "vitest-result.json");
const vitestResultRelative = ".review/vitest-result.json";
const mutatedHashSuffix = ".mutated.sha256";
const defaultTimeoutSeconds = 180;

interface RepoPath {
  absolute: string;
  relative: string;
}

interface CommandResult {
  exitCode: number | null;
  output: string;
  error?: string;
  timedOut: boolean;
}

interface TestRunResult extends CommandResult {
  failedTests: string[];
}

interface ActiveMutation {
  absolute: string;
  relative: string;
  original: Buffer;
}

interface CliArgs {
  specArg: string;
  timeoutMs: number;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
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

function backupPathFor(relative: string): string {
  return path.join(backupDir, relative);
}

function hashSidecarPathFor(backupPath: string): string {
  return `${backupPath}${mutatedHashSuffix}`;
}

function removeBackup(relative: string): void {
  const backupPath = backupPathFor(relative);
  rmSync(backupPath, { force: true });
  rmSync(hashSidecarPathFor(backupPath), { force: true });
}

function backupFile(absolute: string, relative: string, mutatedContent: string): void {
  const backupPath = backupPathFor(relative);
  mkdirSync(path.dirname(backupPath), { recursive: true });
  writeFileSync(backupPath, readFileSync(absolute));
  writeFileSync(hashSidecarPathFor(backupPath), `${sha256(mutatedContent)}\n`, "utf8");
}

function restoreActiveMutation(reason: string): void {
  if (activeMutation === null) {
    return;
  }

  const current = activeMutation;
  activeMutation = null;
  const expectedHash = sha256(current.original);

  writeFileSync(current.absolute, current.original);
  const restoredHash = sha256(readFileSync(current.absolute));
  if (restoredHash !== expectedHash) {
    throw new Error(
      `RESTORE VERIFICATION FAILED for ${toDisplayPath(current.relative)}: ` +
        `expected sha256 ${expectedHash}, got ${restoredHash}. ` +
        `Inspect the file with "git diff" and recover it from .review/backup/.`,
    );
  }

  removeBackup(current.relative);
  pruneEmptyDirectories(backupDir);
  print(`Restored ${toDisplayPath(current.relative)} (${reason}).`);
}

function recoverBackups(): boolean {
  const backups = walkFiles(backupDir).filter((file) => !file.endsWith(mutatedHashSuffix));
  if (backups.length === 0) {
    pruneEmptyDirectories(backupDir);
    return true;
  }

  const restored: string[] = [];
  let ok = true;

  for (const backup of backups) {
    const relative = path.relative(backupDir, backup);
    const display = toDisplayPath(relative);
    const sidecar = hashSidecarPathFor(backup);

    if (!existsSync(sidecar)) {
      console.warn(
        `Kept .review/backup/${display}: its mutated sha256 sidecar is missing, so it cannot be checked safely. ` +
          `Inspect it with "git diff -- ${display}" and remove the backup manually once resolved.`,
      );
      continue;
    }

    const { absolute } = resolveRepoPath(relative);
    const mutatedHash = readFileSync(sidecar, "utf8");
    const currentHash = existsSync(absolute) ? sha256(readFileSync(absolute)) : null;

    if (!shouldRestoreBackup(currentHash, mutatedHash)) {
      console.warn(
        `Left .review/backup/${display} untouched: ${display} no longer contains the mutated content (or is missing). ` +
          `Inspect it with "git diff -- ${display}" and remove the backup manually once resolved.`,
      );
      continue;
    }

    try {
      const original = readFileSync(backup);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, original);
      const restoredHash = sha256(readFileSync(absolute));
      if (restoredHash !== sha256(original)) {
        throw new Error(`expected sha256 ${sha256(original)}, got ${restoredHash}`);
      }
      removeBackup(relative);
      restored.push(display);
    } catch (error) {
      ok = false;
      console.error(`RESTORE VERIFICATION FAILED for ${display}: ${errorMessage(error)}`);
      console.error("The backup was kept in .review/backup/. Inspect the file with git diff.");
    }
  }

  pruneEmptyDirectories(backupDir);
  if (restored.length > 0) {
    print(`Recovered ${restored.length} file(s) from .review/backup/: ${restored.join(", ")}`);
  }
  return ok;
}

function installCleanupHandlers(): void {
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (handlingSignal) {
      return;
    }
    handlingSignal = true;
    killProcessTree(activeChild);
    try {
      restoreActiveMutation(signal);
    } catch (error) {
      console.error(errorMessage(error));
      process.exitCode = 1;
    }
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
    try {
      restoreActiveMutation("process exit");
    } catch (error) {
      console.error(errorMessage(error));
      process.exitCode = 1;
    }
  });
}

function killProcessTree(child: ChildProcess | null): void {
  if (child === null || child.pid === undefined) {
    return;
  }

  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5_000,
      });
      return;
    } catch {
      // Fall through to the direct kill below.
    }
  }

  child.kill("SIGKILL");
}

function runPnpm(args: readonly string[], timeoutMs: number): Promise<CommandResult> {
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
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      finish({ exitCode: null, output, timedOut: true });
    }, timeoutMs);

    const finish = (result: CommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
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
      finish({ exitCode: null, output, error: error.message, timedOut });
    });
    child.on("close", (exitCode) => {
      finish({ exitCode, output, timedOut });
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
    console.error(`Cannot read mutation spec "${specArg}": ${errorMessage(error)}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`Invalid JSON in "${specArg}": ${errorMessage(error)}`);
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
    console.error(errorMessage(error));
    return null;
  }

  return result.data;
}

function parseCliArgs(argv: readonly string[]): CliArgs | string {
  let specArg: string | null = null;
  let timeoutSeconds = defaultTimeoutSeconds;

  const parseTimeout = (value: string | undefined): string | null => {
    if (value === undefined || !/^\d+$/u.test(value)) {
      return "--timeout expects a positive integer number of seconds";
    }
    const seconds = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(seconds) || seconds < 1) {
      return "--timeout expects a positive integer number of seconds";
    }
    timeoutSeconds = seconds;
    return null;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--timeout") {
      index += 1;
      const error = parseTimeout(argv[index]);
      if (error !== null) {
        return error;
      }
      continue;
    }
    if (arg.startsWith("--timeout=")) {
      const error = parseTimeout(arg.slice("--timeout=".length));
      if (error !== null) {
        return error;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      return `Unknown option: ${arg}`;
    }
    if (specArg !== null) {
      return `Unexpected argument: ${arg}`;
    }
    specArg = arg;
  }

  if (specArg === null) {
    return "Usage: pnpm mutate <spec.json> [--timeout <seconds>]";
  }
  return { specArg, timeoutMs: timeoutSeconds * 1_000 };
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
  const result = await runPnpm(["db:test:prepare"], defaultTimeoutSeconds * 1_000);
  if (result.exitCode !== 0) {
    console.error("Failed to prepare the API test database; no mutations were run.");
    if (result.error !== undefined) {
      console.error(result.error);
    }
    console.error(firstLines(result.output, 3));
    process.exitCode = 1;
    return false;
  }
  return true;
}

async function runTests(spec: MutationSpec, timeoutMs: number): Promise<TestRunResult> {
  rmSync(vitestResultFile, { force: true });
  const result = await runPnpm(
    [
      "exec",
      "vitest",
      "run",
      ...spec.tests,
      "--reporter=json",
      `--outputFile=${vitestResultRelative}`,
    ],
    timeoutMs,
  );

  let output = result.output;
  if (result.error !== undefined) {
    output = `${result.error}\n${output}`;
  }

  if (result.timedOut) {
    return { ...result, output, failedTests: [] };
  }

  if (!existsSync(vitestResultFile)) {
    return {
      ...result,
      output: `vitest did not write ${vitestResultRelative}\n${output}`,
      failedTests: [],
    };
  }

  const parsed = parseVitestResult(readFileSync(vitestResultFile, "utf8"));
  if (!parsed.ok) {
    return { ...result, output: `${parsed.reason}\n${output}`, failedTests: [] };
  }

  const { failedTests, messages } = parsed.report;
  if (failedTests.length === 0 && messages.length > 0) {
    output = `${messages.join("\n")}\n${output}`;
  }
  return { ...result, output, failedTests };
}

async function runBaseline(spec: MutationSpec, timeoutMs: number): Promise<boolean> {
  print(`Running the unmutated baseline (${spec.tests.join(", ")})...`);
  const result = await runTests(spec, timeoutMs);

  if (result.exitCode === 0 && !result.timedOut) {
    print("Baseline is green.");
    return true;
  }

  console.error("Baseline failed:");
  if (result.timedOut) {
    console.error(`- (timeout after ${Math.round(timeoutMs / 1_000)}s)`);
  }
  if (result.failedTests.length > 0) {
    for (const name of result.failedTests) {
      console.error(`- ${name}`);
    }
  } else {
    console.error(firstLines(result.output, 3));
  }
  console.error("baseline is red, no mutation was run");
  process.exitCode = 1;
  return false;
}

async function runMutation(
  spec: MutationSpec,
  mutation: MutationSpec["mutations"][number],
  timeoutMs: number,
): Promise<MutationTableRow> {
  let location = `${mutation.file}:?`;
  const expected = mutation.expectKilledBy;

  try {
    const rejection = mutationTargetRejection(mutation.file);
    if (rejection !== null) {
      return { id: mutation.id, location, result: "INVALID", failingTest: rejection };
    }

    const target = assertExistingRepoFile(mutation.file);
    const original = readFileSync(target.absolute);
    const applied = applyExactlyOnce(original.toString("utf8"), mutation.find, mutation.replace);
    if (!applied.ok) {
      return { id: mutation.id, location, result: "INVALID", failingTest: applied.reason };
    }

    location = `${toDisplayPath(target.relative)}:${applied.line}`;
    backupFile(target.absolute, target.relative, applied.content);
    activeMutation = { absolute: target.absolute, relative: target.relative, original };
    writeFileSync(target.absolute, applied.content, "utf8");

    print(`[${mutation.id}] running tests against ${location}...`);
    const result = await runTests(spec, timeoutMs);
    const classified = classifyRun({
      exitCode: result.exitCode,
      output: result.output,
      failedTests: result.failedTests,
      expectedKilledBy: expected,
      timedOut: result.timedOut,
    });

    return { id: mutation.id, location, ...classified };
  } catch (error) {
    return {
      id: mutation.id,
      location,
      result: "INVALID",
      failingTest: errorMessage(error),
    };
  } finally {
    restoreActiveMutation("finally");
  }
}

function reportRow(row: MutationTableRow): void {
  if (row.result === "KILLED" || row.result === "KILLED_BY_OTHER") {
    print(`[${row.id}] ${row.result} (${row.failingTest})`);
    return;
  }
  if (row.result === "TIMEOUT") {
    print(`[${row.id}] TIMEOUT (timeout)`);
    return;
  }
  if (row.result === "ERROR") {
    print(`[${row.id}] ERROR\n${row.failingTest}`);
    return;
  }
  print(`[${row.id}] ${row.result}`);
}

function writeMutationReport(spec: MutationSpec, rows: readonly MutationTableRow[]): void {
  const markdown = renderMutationReport(spec.task, rows);
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
  if (!recoverBackups()) {
    process.exitCode = 1;
    return;
  }

  const args = parseCliArgs(process.argv.slice(2));
  if (typeof args === "string") {
    console.error(args);
    process.exitCode = 1;
    return;
  }

  const spec = parseSpec(args.specArg);
  if (spec === null) {
    process.exitCode = 1;
    return;
  }

  const before = workingTreeSnapshot();

  if (!(await prepareTestDatabase(spec))) {
    return;
  }

  if (!(await runBaseline(spec, args.timeoutMs))) {
    return;
  }

  const rows: MutationTableRow[] = [];
  for (const mutation of spec.mutations) {
    const row = await runMutation(spec, mutation, args.timeoutMs);
    rows.push(row);
    reportRow(row);
  }

  writeMutationReport(spec, rows);

  const failed = rows.some(
    (row) =>
      row.result === "SURVIVED" ||
      row.result === "INVALID" ||
      row.result === "ERROR" ||
      row.result === "KILLED_BY_OTHER",
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
