import { z } from "zod";

export type CheckStatus = "pass" | "fail" | "skipped";

export interface DiffBase {
  ref: string;
  fallback: boolean;
}

export interface PushState {
  pushed: boolean;
  commands: string[];
  reason: string | null;
}

export type PullRequestState = "open" | "merged" | "closed";

export interface PullRequestInfo {
  number: number;
  state: PullRequestState;
}

export type PullLookupResult =
  { kind: "found"; pull: PullRequestInfo } | { kind: "none" } | { kind: "error"; reason: string };

export type ReviewOutcome =
  | { kind: "pull"; diffUrl: string; pull: PullRequestInfo }
  | { kind: "create"; createUrl: string }
  | {
      kind: "unavailable";
      reason: string;
      pushCommands: string[];
      manualDiffUrl: string | null;
    };

export interface PacketInput {
  taskId: string | null;
  branch: string;
  head: string;
  date: string;
  diffBase: DiffBase;
  originFetchFailed: boolean;
  checkStatus: CheckStatus;
  checkOutput: string;
  diffLabel: string;
  diffStat: string;
  uncommittedStat: string;
  untracked: string[];
  mutations: string | null;
  report: string | null;
  review: ReviewOutcome;
}

export const MAX_PACKET_LINES = 200;
export const AGENT_REPORT_MAX_LINES = 60;
export const PACKET_FINAL_LINE =
  "Paste this whole text, including the review URL on its own line, in the chat.";

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

export function encodeBranch(branch: string): string {
  return branch
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function compareCreateUrl(repo: GitHubRepo, branch: string): string {
  return `https://github.com/${repo.owner}/${repo.repo}/compare/main...${encodeBranch(branch)}?expand=1`;
}

export function buildCompareCreateUrl(remoteUrl: string, branch: string): string | null {
  const repository = parseGitHubRemote(remoteUrl);
  if (repository === null) {
    return null;
  }
  return compareCreateUrl(repository, branch);
}

export function buildPullDiffUrl(repo: GitHubRepo, pullNumber: number): string {
  return `https://github.com/${repo.owner}/${repo.repo}/pull/${pullNumber}.diff`;
}

export function buildPullRequestApiUrl(repo: GitHubRepo, branch: string): string {
  const head = `${repo.owner}:${encodeBranch(branch)}`;
  return `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls?head=${head}&state=all&per_page=1`;
}

function manualPullDiffUrl(repo: GitHubRepo): string {
  return `https://github.com/${repo.owner}/${repo.repo}/pull/<N>.diff`;
}

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  state: z.string().min(1),
  merged_at: z.string().nullable().optional(),
});

const pullRequestListSchema = z.array(pullRequestSchema);

/**
 * Validates the GitHub "list pull requests" payload. A merged PR is reported as
 * "merged" even though GitHub keeps `state: "closed"` for it.
 */
export function parsePullRequests(payload: unknown): PullLookupResult {
  const parsed = pullRequestListSchema.safeParse(payload);
  if (!parsed.success) {
    return { kind: "error", reason: "unexpected GitHub API response" };
  }

  const first = parsed.data[0];
  if (first === undefined) {
    return { kind: "none" };
  }

  const merged = typeof first.merged_at === "string" && first.merged_at.length > 0;
  const state: PullRequestState = merged ? "merged" : first.state === "open" ? "open" : "closed";
  return { kind: "found", pull: { number: first.number, state } };
}

export function resolveReviewOutcome(
  repo: GitHubRepo,
  branch: string,
  push: PushState,
  lookup: PullLookupResult | null,
): ReviewOutcome {
  if (!push.pushed) {
    return {
      kind: "unavailable",
      reason: push.reason ?? "the branch is not pushed to origin",
      pushCommands: push.commands,
      manualDiffUrl: null,
    };
  }

  if (lookup === null) {
    return {
      kind: "unavailable",
      reason: "the pull request lookup did not run",
      pushCommands: [],
      manualDiffUrl: manualPullDiffUrl(repo),
    };
  }

  if (lookup.kind === "found") {
    return {
      kind: "pull",
      diffUrl: buildPullDiffUrl(repo, lookup.pull.number),
      pull: lookup.pull,
    };
  }
  if (lookup.kind === "none") {
    return { kind: "create", createUrl: compareCreateUrl(repo, branch) };
  }
  return {
    kind: "unavailable",
    reason: lookup.reason,
    pushCommands: [],
    manualDiffUrl: manualPullDiffUrl(repo),
  };
}

export function renderReviewUrl(outcome: ReviewOutcome): string {
  if (outcome.kind === "pull") {
    return `${outcome.diffUrl}\n\nPR state: ${outcome.pull.state}`;
  }

  if (outcome.kind === "create") {
    return [
      "No pull request yet. Create it at:",
      outcome.createUrl,
      "",
      "The .diff URL will exist once the PR is created; re-run `pnpm review:packet --skip-check`.",
    ].join("\n");
  }

  const manual =
    outcome.manualDiffUrl === null
      ? ""
      : `\n\nBuild the URL by hand as ${outcome.manualDiffUrl} once the PR exists.`;
  const commands =
    outcome.pushCommands.length > 0
      ? `\n\n\`\`\`sh\n${outcome.pushCommands.join("\n")}\n\`\`\``
      : "";
  return `The review URL is not available yet: ${outcome.reason}.${manual}${commands}`;
}

export function buildDiffBaseLine(diffBase: DiffBase, originFetchFailed: boolean): string {
  const base = diffBase.fallback
    ? `- Diff base: ${diffBase.ref} (origin/main not found; falling back to ${diffBase.ref})`
    : `- Diff base: ${diffBase.ref}`;
  return originFetchFailed
    ? `${base}\n- Origin fetch: could not fetch origin; diff base may be stale`
    : base;
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

/**
 * Caps the packet while always keeping the truncation note, the final line and
 * any explicitly preserved line (the PR .diff URL).
 */
export function capPacket(
  packet: string,
  maxLines = MAX_PACKET_LINES,
  preserve: readonly string[] = [],
): string {
  if (!Number.isInteger(maxLines) || maxLines < 1) {
    throw new Error("maxLines must be a positive integer");
  }

  const lines = packet.replace(/\r\n/g, "\n").split("\n");
  if (lines.length <= maxLines) {
    return lines.join("\n");
  }

  const tailCount = Math.max(1, Math.min(10, maxLines - 1));
  const tail = lines.slice(-tailCount);
  const tailSet = new Set(tail);
  const wanted = [...new Set(preserve.filter((line) => line.length > 0 && !tailSet.has(line)))];

  const budget = maxLines - tail.length - 1;
  const preservedToShow = wanted.slice(0, Math.max(0, budget - (budget > 1 ? 1 : 0)));
  const headCount = Math.max(0, Math.min(12, budget - preservedToShow.length));
  const head = lines.slice(0, headCount);
  const headSet = new Set(head);
  const keptPreserved = preservedToShow.filter((line) => !headSet.has(line));
  const omitted = Math.max(0, lines.length - head.length - tail.length - keptPreserved.length);

  return [
    ...head,
    `[... packet truncated: ${omitted} line(s) omitted ...]`,
    ...keptPreserved,
    ...tail,
  ].join("\n");
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

export function buildPacket(input: PacketInput): string {
  const task = input.taskId ?? "unknown (branch name has no task id)";
  const header = [
    "# Review packet",
    "",
    `- Task: ${task}`,
    `- Branch: ${input.branch}`,
    `- HEAD: ${input.head}`,
    `- Date: ${input.date}`,
    buildDiffBaseLine(input.diffBase, input.originFetchFailed),
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
        : truncateLines(input.report, AGENT_REPORT_MAX_LINES, "agent report");
  const reviewBody = renderReviewUrl(input.review);

  const packet = [
    header,
    section("pnpm check", checkBody),
    section(`Diff (${input.diffLabel})`, `\`\`\`text\n${diffBody}\n\`\`\``),
    section("Uncommitted changes (vs HEAD)", `\`\`\`text\n${uncommittedBody}\n\`\`\``),
    section("Untracked files", untrackedBody),
    section("Mutation results", mutationsBody),
    section("Agent report", reportBody),
    section("Review URL", reviewBody),
    PACKET_FINAL_LINE,
  ].join("\n\n");

  const preserve =
    input.review.kind === "pull" ? [input.review.diffUrl, PACKET_FINAL_LINE] : [PACKET_FINAL_LINE];
  return `${capPacket(packet, MAX_PACKET_LINES, preserve)}\n`;
}
