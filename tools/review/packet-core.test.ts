import { describe, expect, it } from "vitest";
import {
  buildCompareUrl,
  buildPacket,
  capPacket,
  inferTaskId,
  lastLines,
  parseGitHubRemote,
  truncateLines,
  type PacketInput,
} from "./packet-core";

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

describe("buildCompareUrl", () => {
  it("builds a compare diff URL", () => {
    expect(
      buildCompareUrl("https://github.com/Meteoro3223/Project_C.git", "chore/review-tooling"),
    ).toBe("https://github.com/Meteoro3223/Project_C/compare/main...chore/review-tooling.diff");
  });

  it("encodes unusual branch characters per path segment", () => {
    expect(buildCompareUrl("git@github.com:owner/repo.git", "feat/foo#1")).toBe(
      "https://github.com/owner/repo/compare/main...feat/foo%231.diff",
    );
  });

  it("returns null when the remote is not GitHub", () => {
    expect(buildCompareUrl("https://example.com/owner/repo.git", "main")).toBeNull();
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
  checkStatus: "pass",
  checkOutput: "",
  diffLabel: "main...HEAD, 1 commit(s) ahead",
  diffStat: " apps/api/src/foo.ts | 2 +-",
  uncommittedStat: " tools/review/packet.ts | 10 +++++-----",
  untracked: [".review/mutations.json"],
  mutations: null,
  report: null,
  compareUrl: "https://github.com/Meteoro3223/Project_C/compare/main...feat/p2-t3.diff",
  urlUnavailableReason: null,
  pushCommands: [],
};

const finalLine = "Paste this whole text, including the URL on its own line, in the chat.";

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
      finalLine,
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
    expect(packet).toContain(baseInput.compareUrl ?? "");
    expect(packet.trimEnd().endsWith(finalLine)).toBe(true);
  });

  it("says in the header when it had to fall back to local main", () => {
    const packet = buildPacket({
      ...baseInput,
      diffBase: { ref: "main", fallback: true },
    });

    expect(packet).toContain("- Diff base: main (origin/main not found; falling back to main)");
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

  it("falls back to push instructions when no compare URL is available", () => {
    const packet = buildPacket({
      ...baseInput,
      compareUrl: null,
      urlUnavailableReason: "the branch has no upstream",
      pushCommands: ["git push -u origin feat/p2-t3-courses-api"],
    });

    expect(packet).toContain("The compare URL will not work yet: the branch has no upstream.");
    expect(packet).toContain("git push -u origin feat/p2-t3-courses-api");
  });

  it("keeps a huge packet under 200 lines and preserves the URL and final line", () => {
    const huge = Array.from({ length: 300 }, (_, index) => `row ${index + 1}`).join("\n");
    const packet = buildPacket({
      ...baseInput,
      diffStat: huge,
      uncommittedStat: huge,
      mutations: huge,
      report: huge,
      untracked: Array.from({ length: 100 }, (_, index) => `untracked-${index + 1}.ts`),
    });

    expect(packet.trimEnd().split("\n").length).toBeLessThanOrEqual(200);
    expect(packet).toContain(baseInput.compareUrl ?? "");
    expect(packet.trimEnd().endsWith(finalLine)).toBe(true);
    expect(packet).toContain("truncated");
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

  it("returns a short packet unchanged", () => {
    expect(capPacket("one\ntwo", 20)).toBe("one\ntwo");
  });
});
