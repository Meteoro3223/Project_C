export type CheckStatus = "pass" | "fail" | "skipped";

export interface DiffBase {
  ref: string;
  fallback: boolean;
}

export interface PacketInput {
  taskId: string | null;
  branch: string;
  head: string;
  date: string;
  diffBase: DiffBase;
  checkStatus: CheckStatus;
  checkOutput: string;
  diffLabel: string;
  diffStat: string;
  uncommittedStat: string;
  untracked: string[];
  mutations: string | null;
  report: string | null;
  compareUrl: string | null;
  urlUnavailableReason: string | null;
  pushCommands: string[];
}

const MAX_PACKET_LINES = 200;

export function inferTaskId(branch: string): string | null {
  const match = /(?:^|[^a-z0-9])(p\d+-t\d+)(?=$|[^a-z0-9])/i.exec(branch);
  return match?.[1]?.toUpperCase() ?? null;
}

export interface GitHubRepo {
  owner: string;
  repo: string;
}

export function parseGitHubRemote(remoteUrl: string): GitHubRepo | null {
  const cleaned = remoteUrl
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "");
  const match =
    /^(?:git@github\.com:|https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git:\/\/github\.com\/)([^/]+)\/([^/]+)$/iu.exec(
      cleaned,
    );
  if (match === null) {
    return null;
  }

  const [, owner, repo] = match;
  if (owner === undefined || repo === undefined || owner.length === 0 || repo.length === 0) {
    return null;
  }
  return { owner, repo };
}

function encodeBranch(branch: string): string {
  return branch
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function buildCompareUrl(remoteUrl: string, branch: string): string | null {
  const repository = parseGitHubRemote(remoteUrl);
  if (repository === null) {
    return null;
  }
  return `https://github.com/${repository.owner}/${repository.repo}/compare/main...${encodeBranch(branch)}.diff`;
}

function normalizeLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/u, "").split("\n");
}

export function truncateLines(text: string, maxLines: number, label = "section"): string {
  if (!Number.isInteger(maxLines) || maxLines < 1) {
    throw new Error("maxLines must be a positive integer");
  }

  const lines = normalizeLines(text);
  if (lines.length <= maxLines) {
    return lines.join("\n");
  }

  const omitted = lines.length - maxLines;
  return [
    ...lines.slice(0, maxLines),
    `[... ${label} truncated: ${omitted} more line(s) ...]`,
  ].join("\n");
}

export function lastLines(text: string, maxLines: number, label = "output"): string {
  if (!Number.isInteger(maxLines) || maxLines < 1) {
    throw new Error("maxLines must be a positive integer");
  }

  const lines = normalizeLines(text);
  if (lines.length <= maxLines) {
    return lines.join("\n");
  }

  const omitted = lines.length - maxLines;
  return [
    `[... ${label}: showing last ${maxLines} of ${lines.length} lines, ${omitted} omitted ...]`,
    ...lines.slice(-maxLines),
  ].join("\n");
}

export function capPacket(packet: string, maxLines = MAX_PACKET_LINES): string {
  if (!Number.isInteger(maxLines) || maxLines < 1) {
    throw new Error("maxLines must be a positive integer");
  }

  const lines = packet.replace(/\r\n/g, "\n").split("\n");
  if (lines.length <= maxLines) {
    return lines.join("\n");
  }

  const tailCount = Math.max(1, Math.min(10, maxLines - 1));
  const headCount = Math.max(0, Math.min(12, maxLines - tailCount - 1));
  const middleCount = maxLines - headCount - tailCount - 1;
  const head = lines.slice(0, headCount);
  const middle = lines.slice(headCount, headCount + middleCount);
  const tail = lines.slice(-tailCount);
  const omitted = lines.length - head.length - middle.length - tail.length;

  return [
    ...head,
    ...middle,
    `[... packet truncated: ${omitted} line(s) omitted ...]`,
    ...tail,
  ].join("\n");
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

export function buildPacket(input: PacketInput): string {
  const task = input.taskId ?? "unknown (branch name has no task id)";
  const diffBase = input.diffBase.fallback
    ? `- Diff base: ${input.diffBase.ref} (origin/main not found; falling back to ${input.diffBase.ref})`
    : `- Diff base: ${input.diffBase.ref}`;
  const header = [
    "# Review packet",
    "",
    `- Task: ${task}`,
    `- Branch: ${input.branch}`,
    `- HEAD: ${input.head}`,
    `- Date: ${input.date}`,
    diffBase,
  ].join("\n");

  let checkBody: string;
  if (input.checkStatus === "pass") {
    checkBody = "PASS";
  } else if (input.checkStatus === "skipped") {
    checkBody = "not run (--skip-check)";
  } else {
    const output =
      input.checkOutput.trim().length > 0
        ? lastLines(input.checkOutput, 25, "check output")
        : "(no output)";
    checkBody = `FAIL\n\n\`\`\`text\n${output}\n\`\`\``;
  }

  const diffBody =
    input.diffStat.trim().length > 0
      ? truncateLines(input.diffStat, 28, "diff stat")
      : "(no changes)";
  const uncommittedBody =
    input.uncommittedStat.trim().length > 0
      ? truncateLines(input.uncommittedStat, 18, "uncommitted changes")
      : "(none)";
  const untrackedBody =
    input.untracked.length > 0
      ? truncateLines(input.untracked.map((file) => `- ${file}`).join("\n"), 15, "untracked list")
      : "(none)";
  const mutationsBody =
    input.mutations === null
      ? "mutations: not run"
      : input.mutations.trim().length === 0
        ? "(empty)"
        : truncateLines(input.mutations, 35, "mutations");
  const reportBody =
    input.report === null
      ? "agent report: missing"
      : input.report.trim().length === 0
        ? "(empty)"
        : truncateLines(input.report, 35, "agent report");

  let urlBody: string;
  if (input.compareUrl !== null) {
    urlBody = input.compareUrl;
  } else {
    const reason = input.urlUnavailableReason ?? "the branch is not pushed to origin";
    const commands =
      input.pushCommands.length > 0 ? `\n\n\`\`\`sh\n${input.pushCommands.join("\n")}\n\`\`\`` : "";
    urlBody = `The compare URL will not work yet: ${reason}.${commands}`;
  }

  const packet = [
    header,
    section("pnpm check", checkBody),
    section(`Diff (${input.diffLabel})`, `\`\`\`text\n${diffBody}\n\`\`\``),
    section("Uncommitted changes (vs HEAD)", `\`\`\`text\n${uncommittedBody}\n\`\`\``),
    section("Untracked files", untrackedBody),
    section("Mutation results", mutationsBody),
    section("Agent report", reportBody),
    section("Review URL", urlBody),
    "Paste this whole text, including the URL on its own line, in the chat.",
  ].join("\n\n");

  return `${capPacket(packet, MAX_PACKET_LINES)}\n`;
}
