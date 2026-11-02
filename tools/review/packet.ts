import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCompareUrl,
  buildPacket,
  inferTaskId,
  type CheckStatus,
  type PacketInput,
} from "./packet-core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function print(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function git(args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function tryGit(args: readonly string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function readOptional(relativePath: string): string | null {
  const absolute = path.join(repoRoot, relativePath);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

function runCheck(): Promise<{ status: "pass" | "fail"; output: string }> {
  return new Promise((resolve) => {
    const options = {
      cwd: repoRoot,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    };
    // Avoid Node's shell:true + args deprecation on Windows.
    const child =
      process.platform === "win32"
        ? spawn("pnpm check", { ...options, shell: true })
        : spawn("pnpm", ["check"], options);

    let output = "";
    let settled = false;
    const finish = (status: "pass" | "fail"): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ status, output });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      output += `\nFailed to run pnpm check: ${error.message}\n`;
      finish("fail");
    });
    child.on("close", (exitCode) => {
      finish(exitCode === 0 ? "pass" : "fail");
    });
  });
}

interface PushState {
  pushed: boolean;
  commands: string[];
  reason: string | null;
}

function getPushState(branch: string): PushState {
  if (branch === "HEAD") {
    return { pushed: false, commands: [], reason: "HEAD is detached" };
  }
  if (branch === "main") {
    return { pushed: false, commands: [], reason: "you are on main; create a task branch first" };
  }

  const upstream = tryGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream === null || upstream.trim().length === 0) {
    return {
      pushed: false,
      commands: [`git push -u origin ${branch}`],
      reason: "the branch has no upstream",
    };
  }

  if (!upstream.startsWith("origin/")) {
    return {
      pushed: false,
      commands: [`git push -u origin ${branch}`],
      reason: "the branch is not pushed to origin",
    };
  }

  const aheadRaw = tryGit(["rev-list", "--count", `${upstream}..HEAD`]);
  const ahead = aheadRaw === null ? Number.NaN : Number.parseInt(aheadRaw, 10);
  if (!Number.isFinite(ahead) || ahead > 0) {
    const detail = Number.isFinite(ahead) ? `${ahead} commit(s)` : "unpushed commits";
    return {
      pushed: false,
      commands: ["git push"],
      reason: `the local branch is ahead of ${upstream} by ${detail}`,
    };
  }

  return { pushed: true, commands: [], reason: null };
}

function copyToClipboard(text: string): Promise<boolean> {
  if (process.platform !== "win32") {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const child = spawn("clip", [], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });

    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    child.on("error", () => {
      finish(false);
    });
    child.on("close", (exitCode) => {
      finish(exitCode === 0);
    });

    if (child.stdin === null) {
      finish(false);
      return;
    }
    child.stdin.on("error", () => {
      finish(false);
    });
    // clip.exe accepts UTF-8 on this platform; UTF-16LE mangles non-ASCII text.
    child.stdin.end(Buffer.from(text, "utf8"));
  });
}

function collectDiff(): { label: string; stat: string; uncommittedStat: string } {
  const uncommitted = tryGit(["diff", "--stat", "HEAD"]) ?? "";
  const uncommittedStat = uncommitted.trim().length > 0 ? uncommitted : "(none)";

  const aheadRaw = tryGit(["rev-list", "--count", "main..HEAD"]);
  const ahead = aheadRaw === null ? 0 : Number.parseInt(aheadRaw, 10);
  if (Number.isFinite(ahead) && ahead > 0) {
    const stat = tryGit(["diff", "--stat", "main...HEAD"]) ?? "";
    return {
      label: `main...HEAD, ${ahead} commit(s) ahead`,
      stat: stat.trim().length > 0 ? stat : "(no changes)",
      uncommittedStat,
    };
  }

  const stat = tryGit(["diff", "--cached", "--stat"]) ?? "";
  return {
    label: "staged changes (no commits ahead of main)",
    stat: stat.trim().length > 0 ? stat : "(no staged changes)",
    uncommittedStat,
  };
}

function collectReviewUrl(branch: string): {
  compareUrl: string | null;
  urlUnavailableReason: string | null;
  pushCommands: string[];
} {
  const push = getPushState(branch);
  const remoteUrl = tryGit(["remote", "get-url", "origin"]);
  if (remoteUrl === null) {
    return {
      compareUrl: null,
      urlUnavailableReason: "origin is not configured",
      pushCommands: [],
    };
  }

  const candidate = buildCompareUrl(remoteUrl, branch);
  if (candidate === null) {
    return {
      compareUrl: null,
      urlUnavailableReason: "origin is not a GitHub remote",
      pushCommands: [],
    };
  }

  if (!push.pushed) {
    return {
      compareUrl: null,
      urlUnavailableReason: push.reason ?? "the branch is not pushed to origin",
      pushCommands: push.commands,
    };
  }

  return { compareUrl: candidate, urlUnavailableReason: null, pushCommands: [] };
}

async function main(): Promise<void> {
  const skipCheck = process.argv.includes("--skip-check");
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(["rev-parse", "--short", "HEAD"]);
  const date = new Date().toISOString();
  const taskId = inferTaskId(branch);
  const { label: diffLabel, stat: diffStat, uncommittedStat } = collectDiff();
  const untracked = (tryGit(["ls-files", "--others", "--exclude-standard"]) ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const { compareUrl, urlUnavailableReason, pushCommands } = collectReviewUrl(branch);

  let checkStatus: CheckStatus = "skipped";
  let checkOutput = "";
  if (!skipCheck) {
    process.stderr.write("Running pnpm check...\n");
    const result = await runCheck();
    checkStatus = result.status;
    checkOutput = result.output;
    process.stderr.write(`pnpm check: ${result.status.toUpperCase()}\n`);
  }

  const input: PacketInput = {
    taskId,
    branch,
    head,
    date,
    checkStatus,
    checkOutput,
    diffLabel,
    diffStat,
    uncommittedStat,
    untracked,
    mutations: readOptional(".review/mutations.md"),
    report: readOptional(".review/report.md"),
    compareUrl,
    urlUnavailableReason,
    pushCommands,
  };

  const packet = buildPacket(input);
  print(packet);

  const copied = await copyToClipboard(packet);
  if (copied) {
    process.stderr.write("Copied the review packet to the clipboard.\n");
  } else {
    process.stderr.write("Clipboard unavailable; the packet was printed above.\n");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
