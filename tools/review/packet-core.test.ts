import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_REPORT_MAX_LINES,
  buildCompareCreateUrl,
  buildDiffBaseLine,
  buildPacket,
  buildPullDiffUrl,
  buildPullRequestApiUrl,
  capPacket,
  encodeBranch,
  inferTaskId,
  lastLines,
  PACKET_FINAL_LINE,
  parseGitHubRemote,
  parsePullRequests,
  renderReviewUrl,
  resolveReviewOutcome,
  truncateLines,
  type PacketInput,
  type PullLookupResult,
  type PushState,
} from "./packet-core";

function readFixture(name: string): unknown {
  const raw = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return JSON.parse(raw);
}

const repo = { owner: "Meteoro3223", repo: "Project_C" };
const pushed: PushState = { pushed: true, commands: [], reason: null };
const notPushed: PushState = {
  pushed: false,
  commands: ["git push -u origin feat/p2-t3"],
  reason: "the branch has no upstream",
};

describe("inferTaskId", () => {
  it.each([
    ["feat/p2-t3-courses-api", "P2-T3"],
    ["fix/P12-T34-thing", "P12-T34"],
    ["chore/p1-t1", "P1-T1"],
    ["main", null],
    ["chore/review-tooling", null],
  ])("maps %s to %s", (branch, expected) => {
    expect(inferTaskId(branch)).toBe(expected);
  });
});

describe("GitHub remote parsing", () => {
  it.each([
    "https://github.com/Meteoro3223/Project_C.git",
    "https://github.com/Meteoro3223/Project_C",
    "git@github.com:Meteoro3223/Project_C.git",
    "ssh://git@github.com/Meteoro3223/Project_C.git",
    "https://github.com/Meteoro3223/Project_C/",
  ])("parses %s", (remote) => {
    expect(parseGitHubRemote(remote)).toEqual({
      owner: "Meteoro3223",
      repo: "Project_C",
    });
  });

  it("returns null for non-GitHub remotes", () => {
    expect(parseGitHubRemote("https://gitlab.com/owner/repo.git")).toBeNull();
  });
});

describe("URL building", () => {
  it("encodes branch names per path segment", () => {
    expect(encodeBranch("chore/review-tooling")).toBe("chore/review-tooling");
    expect(encodeBranch("feat/foo#1")).toBe("feat/foo%231");
    expect(encodeBranch("feat/a b/c")).toBe("feat/a%20b/c");
  });

  it("builds the compare URL used to create a pull request", () => {
    expect(buildCompareCreateUrl("https://github.com/Meteoro3223/Project_C.git", "chore/x")).toBe(
      "https://github.com/Meteoro3223/Project_C/compare/main...chore/x?expand=1",
    );
  });

  it("encodes the branch in the compare create URL", () => {
    expect(buildCompareCreateUrl("git@github.com:owner/repo.git", "feat/foo#1")).toBe(
      "https://github.com/owner/repo/compare/main...feat/foo%231?expand=1",
    );
  });

  it("returns null for a non-GitHub compare remote", () => {
    expect(buildCompareCreateUrl("https://example.com/owner/repo.git", "main")).toBeNull();
  });

  it("builds the pull request diff URL", () => {
    expect(buildPullDiffUrl(repo, 42)).toBe(
      "https://github.com/Meteoro3223/Project_C/pull/42.diff",
    );
  });

  it("builds the API URL with the owner prefix and the encoded branch", () => {
    expect(buildPullRequestApiUrl(repo, "feat/foo#1")).toBe(
      "https://api.github.com/repos/Meteoro3223/Project_C/pulls?head=Meteoro3223:feat/foo%231&state=all&per_page=1",
    );
  });
});

describe("parsePullRequests", () => {
  it("reads an open pull request from the fixture", () => {
    expect(parsePullRequests(readFixture("github-pulls.open.json"))).toEqual({
      kind: "found",
      pull: { number: 42, state: "open" },
    });
  });

  it("reports a merged pull request as merged even though GitHub says closed", () => {
    expect(parsePullRequests(readFixture("github-pulls.merged.json"))).toEqual({
      kind: "found",
      pull: { number: 7, state: "merged" },
    });
  });

  it("reports a closed unmerged pull request as closed", () => {
    expect(parsePullRequests(readFixture("github-pulls.closed.json"))).toEqual({
      kind: "found",
      pull: { number: 8, state: "closed" },
    });
  });

  it("returns none for an empty fixture", () => {
    expect(parsePullRequests(readFixture("github-pulls.empty.json"))).toEqual({ kind: "none" });
  });

  it.each([[null], [{ message: "API rate limit exceeded" }], [[{ number: "42" }]]])(
    "rejects an unexpected payload %j",
    (payload) => {
      expect(parsePullRequests(payload)).toEqual({
        kind: "error",
        reason: "unexpected GitHub API response",
      });
    },
  );
});

describe("resolveReviewOutcome", () => {
  const found: PullLookupResult = {
    kind: "found",
    pull: { number: 42, state: "open" },
  };

  it("returns the pull diff URL when the PR exists", () => {
    expect(resolveReviewOutcome(repo, "chore/x", pushed, found)).toEqual({
      kind: "pull",
      diffUrl: "https://github.com/Meteoro3223/Project_C/pull/42.diff",
      pull: { number: 42, state: "open" },
    });
  });

  it("returns the create link when there is no PR yet", () => {
    expect(resolveReviewOutcome(repo, "chore/x", pushed, { kind: "none" })).toEqual({
      kind: "create",
      createUrl: "https://github.com/Meteoro3223/Project_C/compare/main...chore/x?expand=1",
    });
  });

  it("returns an unavailable outcome with a manual URL when the API lookup fails", () => {
    expect(
      resolveReviewOutcome(repo, "chore/x", pushed, { kind: "error", reason: "offline" }),
    ).toEqual({
      kind: "unavailable",
      reason: "offline",
      pushCommands: [],
      manualDiffUrl: "https://github.com/Meteoro3223/Project_C/pull/<N>.diff",
    });
  });

  it("keeps the push instructions when the branch is not pushed", () => {
    expect(resolveReviewOutcome(repo, "chore/x", notPushed, null)).toEqual({
      kind: "unavailable",
      reason: "the branch has no upstream",
      pushCommands: ["git push -u origin feat/p2-t3"],
      manualDiffUrl: null,
    });
  });
});

describe("renderReviewUrl", () => {
  it("prints the PR diff URL on its own line with the state", () => {
    const body = renderReviewUrl({
      kind: "pull",
      diffUrl: "https://github.com/owner/repo/pull/42.diff",
      pull: { number: 42, state: "merged" },
    });
    const lines = body.split("\n");

    expect(lines[0]).toBe("https://github.com/owner/repo/pull/42.diff");
    expect(lines).toContain("PR state: merged");
  });

  it("explains how to create the PR when none exists", () => {
    const body = renderReviewUrl({
      kind: "create",
      createUrl: "https://github.com/owner/repo/compare/main...chore/x?expand=1",
    });

    expect(body).toContain("https://github.com/owner/repo/compare/main...chore/x?expand=1");
    expect(body).toContain("The .diff URL will exist once the PR is created");
    expect(body).toContain("pnpm review:packet --skip-check");
  });

  it("tells the user to build the URL by hand after an API failure", () => {
    const body = renderReviewUrl({
      kind: "unavailable",
      reason: "GitHub API returned HTTP 403 (rate limit?)",
      pushCommands: [],
      manualDiffUrl: "https://github.com/owner/repo/pull/<N>.diff",
    });

    expect(body).toContain("GitHub API returned HTTP 403");
    expect(body).toContain("Build the URL by hand as https://github.com/owner/repo/pull/<N>.diff");
  });
});

describe("buildDiffBaseLine", () => {
  it("names origin/main when it exists", () => {
    expect(buildDiffBaseLine({ ref: "origin/main", fallback: false }, false)).toBe(
      "- Diff base: origin/main",
    );
  });

  it("mentions the fallback to local main", () => {
    expect(buildDiffBaseLine({ ref: "main", fallback: true }, false)).toBe(
      "- Diff base: main (origin/main not found; falling back to main)",
    );
  });

  it("adds the stale-base warning only when the origin fetch failed", () => {
    const failed = buildDiffBaseLine({ ref: "origin/main", fallback: false }, true);
    expect(failed).toContain("could not fetch origin; diff base may be stale");
    expect(buildDiffBaseLine({ ref: "origin/main", fallback: false }, false)).not.toContain(
      "could not fetch origin",
    );
  });
});

describe("truncateLines", () => {
  it("keeps the requested number of lines and adds a visible note", () => {
    const text = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    const result = truncateLines(text, 3, "test section");

    expect(result.split("\n")).toEqual([
      "line 1",
      "line 2",
      "line 3",
      "[... test section truncated: 7 more line(s) ...]",
    ]);
  });

  it("returns short text unchanged", () => {
    expect(truncateLines("one\ntwo", 5)).toBe("one\ntwo");
  });
});

describe("lastLines", () => {
  it("keeps only the tail and states how many lines were omitted", () => {
    const text = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
    const result = lastLines(text, 25, "check output");
    const lines = result.split("\n");

    expect(lines[0]).toBe("[... check output: showing last 25 of 100 lines, 75 omitted ...]");
    expect(lines).not.toContain("line 1");
    expect(lines).toContain("line 76");
    expect(lines).toContain("line 100");
    expect(lines).toHaveLength(26);
  });
});

const baseInput: PacketInput = {
  taskId: "P2-T3",
  branch: "feat/p2-t3-courses-api",
  head: "26229f0",
  date: "2026-11-02T10:00:00.000Z",
  diffBase: { ref: "origin/main", fallback: false },
  originFetchFailed: false,
  checkStatus: "pass",
  checkOutput: "",
  diffLabel: "main...HEAD, 1 commit(s) ahead",
  diffStat: " apps/api/src/foo.ts | 2 +-",
  uncommittedStat: " tools/review/packet.ts | 10 +++++-----",
  untracked: [".review/mutations.json"],
  mutations: null,
  report: null,
  review: {
    kind: "pull",
    diffUrl: "https://github.com/Meteoro3223/Project_C/pull/42.diff",
    pull: { number: 42, state: "open" },
  },
};

describe("buildPacket", () => {
  it("emits the sections in the required order", () => {
    const packet = buildPacket(baseInput);
    const headings = [
      "# Review packet",
      "## pnpm check",
      "## Diff (main...HEAD, 1 commit(s) ahead)",
      "## Uncommitted changes (vs HEAD)",
      "## Untracked files",
      "## Mutation results",
      "## Agent report",
      "## Review URL",
      PACKET_FINAL_LINE,
    ];

    let previous = -1;
    for (const heading of headings) {
      const index = packet.indexOf(heading);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
  });

  it("names the task and says when the mutation report or agent report is missing", () => {
    const packet = buildPacket(baseInput);

    expect(packet).toContain("- Task: P2-T3");
    expect(packet).toContain("- Diff base: origin/main");
    expect(packet).not.toContain("origin/main not found");
    expect(packet).toContain("mutations: not run");
    expect(packet).toContain("agent report: missing");
    expect(packet).toContain(baseInput.uncommittedStat);
    expect(packet).toContain("https://github.com/Meteoro3223/Project_C/pull/42.diff");
    expect(packet).toContain("PR state: open");
    expect(packet).not.toContain("/compare/main...");
    expect(packet.trimEnd().endsWith(PACKET_FINAL_LINE)).toBe(true);
  });

  it("says in the header when it had to fall back to local main", () => {
    const packet = buildPacket({
      ...baseInput,
      diffBase: { ref: "main", fallback: true },
    });

    expect(packet).toContain("- Diff base: main (origin/main not found; falling back to main)");
  });

  it("warns in the header when origin could not be fetched", () => {
    const packet = buildPacket({ ...baseInput, originFetchFailed: true });

    expect(packet).toContain("could not fetch origin; diff base may be stale");
  });

  it("shows only the last 25 lines of a failing check", () => {
    const output = Array.from({ length: 100 }, (_, index) => `check line ${index + 1}`).join("\n");
    const packet = buildPacket({ ...baseInput, checkStatus: "fail", checkOutput: output });

    expect(packet).toContain("## pnpm check\n\nFAIL");
    expect(packet).toContain("check line 100");
    expect(packet).not.toContain("check line 1\n");
    expect(packet).toContain("showing last 25 of 100 lines");
  });

  it("marks a skipped check as not run", () => {
    const packet = buildPacket({ ...baseInput, checkStatus: "skipped" });
    expect(packet).toContain("## pnpm check\n\nnot run (--skip-check)");
  });

  it("falls back to push instructions when the branch is not pushed", () => {
    const packet = buildPacket({
      ...baseInput,
      review: {
        kind: "unavailable",
        reason: "the branch has no upstream",
        pushCommands: ["git push -u origin feat/p2-t3-courses-api"],
        manualDiffUrl: null,
      },
    });

    expect(packet).toContain("The review URL is not available yet: the branch has no upstream.");
    expect(packet).toContain("git push -u origin feat/p2-t3-courses-api");
  });

  it("prints the create link when there is no PR yet", () => {
    const packet = buildPacket({
      ...baseInput,
      review: {
        kind: "create",
        createUrl: "https://github.com/Meteoro3223/Project_C/compare/main...chore/x?expand=1",
      },
    });

    expect(packet).toContain(
      "https://github.com/Meteoro3223/Project_C/compare/main...chore/x?expand=1",
    );
    expect(packet).toContain("The .diff URL will exist once the PR is created");
  });

  it("tells the user to build the URL by hand when the API lookup fails", () => {
    const packet = buildPacket({
      ...baseInput,
      review: {
        kind: "unavailable",
        reason: "the GitHub API request timed out after 5 s",
        pushCommands: [],
        manualDiffUrl: "https://github.com/Meteoro3223/Project_C/pull/<N>.diff",
      },
    });

    expect(packet).toContain("the GitHub API request timed out after 5 s");
    expect(packet).toContain(
      "Build the URL by hand as https://github.com/Meteoro3223/Project_C/pull/<N>.diff",
    );
  });

  it("keeps the whole agent report up to the 60-line cap", () => {
    const report = Array.from(
      { length: AGENT_REPORT_MAX_LINES },
      (_, index) => `report row ${index + 1}`,
    ).join("\n");
    const packet = buildPacket({ ...baseInput, report });

    expect(packet).toContain(`report row ${AGENT_REPORT_MAX_LINES}`);
    expect(packet).not.toContain("agent report truncated");
  });

  it("truncates an agent report longer than 60 lines with a visible note", () => {
    const report = Array.from(
      { length: AGENT_REPORT_MAX_LINES + 1 },
      (_, index) => `report row ${index + 1}`,
    ).join("\n");
    const packet = buildPacket({ ...baseInput, report });

    expect(packet).toContain("agent report truncated: 1 more line(s)");
  });

  it("keeps a huge packet under 200 lines and preserves the URL and final line", () => {
    const huge = Array.from({ length: 300 }, (_, index) => `row ${index + 1}`).join("\n");
    const packet = buildPacket({
      ...baseInput,
      checkStatus: "fail",
      checkOutput: huge,
      diffStat: huge,
      uncommittedStat: huge,
      mutations: huge,
      report: huge,
      untracked: Array.from({ length: 100 }, (_, index) => `untracked-${index + 1}.ts`),
    });
    const lines = packet.trimEnd().split("\n");

    expect(lines.length).toBeLessThanOrEqual(200);
    expect(lines).toContain("https://github.com/Meteoro3223/Project_C/pull/42.diff");
    expect(packet.trimEnd().endsWith(PACKET_FINAL_LINE)).toBe(true);
    expect(packet).toContain("[... packet truncated:");
  });
});

describe("capPacket", () => {
  it("truncates the middle and preserves the tail", () => {
    const text = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");
    const result = capPacket(text, 20);

    expect(result.split("\n").length).toBeLessThanOrEqual(20);
    expect(result).toContain("[... packet truncated:");
    expect(result.split("\n").at(-1)).toBe("line 50");
  });

  it("preserves an explicitly requested line that would otherwise be omitted", () => {
    const text = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
    const result = capPacket(text, 20, ["line 50"]);
    const lines = result.split("\n");

    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines).toContain("line 50");
    expect(result).toContain("[... packet truncated:");
    expect(lines.at(-1)).toBe("line 100");
  });

  it("keeps the final line even when it is also listed as preserved", () => {
    const text = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
    const result = capPacket(text, 20, ["line 100"]);

    expect(result.split("\n").at(-1)).toBe("line 100");
    expect(result).toContain("[... packet truncated:");
  });

  it("returns a short packet unchanged", () => {
    expect(capPacket("one\ntwo", 20)).toBe("one\ntwo");
  });
});
