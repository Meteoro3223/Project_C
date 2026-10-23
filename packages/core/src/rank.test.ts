import { describe, expect, it } from "vitest";
import { createEngineConfig } from "./config.js";
import { rankTasks } from "./rank.js";
import type {
  Importance,
  RankableTask,
  ReasonCode,
  TaskStatus,
  Tier,
  WeeklyAvailability,
} from "./types.js";

/** 180 available minutes every day, Madrid timezone. */
const AVAILABILITY_180: WeeklyAvailability = {
  timezone: "Europe/Madrid",
  minutesByWeekday: { 1: 180, 2: 180, 3: 180, 4: 180, 5: 180, 6: 180, 7: 180 },
};

/** Monday 12 October 2026, 09:00 in Madrid (CEST, +2). */
const NOW = new Date("2026-10-12T07:00:00Z");

/**
 * Weights that make a MEDIUM task score ~1e-6 above an otherwise identical LOW
 * task (`0.3 * 1.0000033 = 0.30000099`). That is far above the 1e-9 sort
 * precision, so it must not be rounded away.
 */
const NEARLY_EQUAL_WEIGHTS = createEngineConfig({
  importanceWeights: { LOW: 1, MEDIUM: 1.0000033, HIGH: 1.0000033 },
});

interface TaskInput {
  readonly id: string;
  /** Defaults to Tuesday 13 October 2026, 09:00 Madrid. */
  readonly dueAt?: Date;
  readonly importance?: Importance;
  readonly remainingMinutes?: number;
  readonly status?: TaskStatus;
}

function makeTask({
  id,
  dueAt = new Date("2026-10-13T07:00:00Z"),
  importance = "MEDIUM",
  remainingMinutes = 60,
  status = "TODO",
}: TaskInput): RankableTask {
  return { id, dueAt, importance, remainingMinutes, status };
}

/** Runs `run` and returns the error it throws, failing the test if it does not. */
function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the call to throw");
}

describe("rankTasks filtering", () => {
  it("returns an empty ranking for no tasks", () => {
    expect(rankTasks([], AVAILABILITY_180, NOW)).toEqual([]);
  });

  it("excludes DONE tasks while keeping TODO and IN_PROGRESS", () => {
    const result = rankTasks(
      [
        makeTask({
          id: "todo",
          dueAt: new Date("2026-10-14T07:00:00Z"),
          remainingMinutes: 240,
        }),
        makeTask({
          id: "done",
          dueAt: new Date("2026-10-13T07:00:00Z"),
          remainingMinutes: 180,
          status: "DONE",
        }),
        makeTask({
          id: "in-progress",
          dueAt: new Date("2026-10-15T07:00:00Z"),
          remainingMinutes: 90,
          status: "IN_PROGRESS",
        }),
      ],
      AVAILABILITY_180,
      NOW,
    );

    expect(result.map((entry) => entry.taskId)).toEqual(["todo", "in-progress"]);
    expect(result.map((entry) => entry.rank)).toEqual([1, 2]);
  });
});

describe("rankTasks input handling", () => {
  it("throws a RangeError naming a duplicated task id", () => {
    const error = captureError(() =>
      rankTasks(
        [makeTask({ id: "repeated" }), makeTask({ id: "repeated", remainingMinutes: 120 })],
        AVAILABILITY_180,
        NOW,
      ),
    );

    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toBe("Duplicate task id: repeated");
  });

  it("rejects a duplicated id even when one of the tasks is DONE", () => {
    const error = captureError(() =>
      rankTasks(
        [
          makeTask({ id: "repeated" }),
          makeTask({ id: "repeated", status: "DONE", remainingMinutes: 0 }),
        ],
        AVAILABILITY_180,
        NOW,
      ),
    );

    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toContain("repeated");
  });

  it("validates the timezone even when there are no tasks", () => {
    const error = captureError(() =>
      rankTasks([], { ...AVAILABILITY_180, timezone: "Not/AZone" }, NOW),
    );

    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toContain("Not/AZone");
  });

  it("validates now even when every task is DONE", () => {
    const error = captureError(() =>
      rankTasks(
        [makeTask({ id: "done", remainingMinutes: 0, status: "DONE" })],
        AVAILABILITY_180,
        new Date("not a date"),
      ),
    );

    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toContain("now");
  });

  it("does not mutate the input array or its tasks", () => {
    const tasks = Object.freeze([
      Object.freeze(
        makeTask({
          id: "later",
          dueAt: new Date("2026-10-20T07:00:00Z"),
          remainingMinutes: 60,
        }),
      ),
      Object.freeze(
        makeTask({
          id: "sooner",
          dueAt: new Date("2026-10-13T07:00:00Z"),
          remainingMinutes: 180,
          importance: "HIGH",
        }),
      ),
    ]);
    const snapshot = tasks.map((task) => ({ ...task }));

    const result = rankTasks(tasks, AVAILABILITY_180, NOW);

    expect(tasks).toEqual(snapshot);
    expect(tasks.map((task) => task.id)).toEqual(["later", "sooner"]);
    expect(result.map((entry) => entry.taskId)).toEqual(["sooner", "later"]);
  });
});

interface DaysCase {
  readonly name: string;
  readonly now: string;
  readonly dueAt: string;
  readonly expected: number;
}

const DAYS_UNTIL_DUE_CASES: readonly DaysCase[] = [
  {
    name: "counts whole civil days into the future",
    now: "2026-10-12T07:00:00Z",
    dueAt: "2026-10-22T07:00:00Z",
    expected: 10,
  },
  {
    name: "returns 0 for a deadline earlier the same civil day",
    now: "2026-10-12T07:00:00Z",
    dueAt: "2026-10-12T06:00:00Z",
    expected: 0,
  },
  {
    name: "returns 0 for a deadline later the same civil day",
    now: "2026-10-12T07:00:00Z",
    dueAt: "2026-10-12T16:00:00Z",
    expected: 0,
  },
  {
    name: "returns a negative count for an overdue deadline",
    now: "2026-10-12T07:00:00Z",
    dueAt: "2026-10-09T16:00:00Z",
    expected: -3,
  },
  {
    name: "uses the civil date, not the UTC date, of a late-evening deadline",
    now: "2026-10-14T07:00:00Z", // Wed 09:00 local
    dueAt: "2026-10-15T22:30:00Z", // Fri 16 Oct 00:30 local
    expected: 2,
  },
  {
    name: "counts civil days across the spring DST change",
    now: "2026-03-27T11:00:00Z", // Fri 12:00 CET (+1)
    dueAt: "2026-03-31T10:00:00Z", // Tue 12:00 CEST (+2)
    expected: 4,
  },
  {
    name: "counts civil days across the autumn DST change",
    now: "2026-10-24T10:00:00Z", // Sat 12:00 CEST (+2)
    dueAt: "2026-10-27T11:00:00Z", // Tue 12:00 CET (+1)
    expected: 3,
  },
];

describe("rankTasks daysUntilDue", () => {
  it.each(DAYS_UNTIL_DUE_CASES)("$name", ({ now, dueAt, expected }) => {
    const result = rankTasks(
      [makeTask({ id: "task", dueAt: new Date(dueAt) })],
      AVAILABILITY_180,
      new Date(now),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.daysUntilDue).toBe(expected);
  });
});

describe("rankTasks breakdown", () => {
  it("exposes pressure, weight, score and reasons for a task", () => {
    const result = rankTasks(
      [
        makeTask({
          id: "task",
          dueAt: new Date("2026-10-15T07:00:00Z"),
          importance: "HIGH",
          remainingMinutes: 270,
        }),
      ],
      AVAILABILITY_180,
      NOW,
    );

    expect(result).toEqual([
      {
        taskId: "task",
        rank: 1,
        tier: "AT_RISK",
        pressure: 0.5,
        noCapacity: false,
        importanceWeight: 2,
        score: 1,
        remainingMinutes: 270,
        availableMinutes: 540,
        daysUntilDue: 3,
        reasons: ["TIGHT_SCHEDULE", "HIGH_IMPORTANCE"],
      },
    ]);
  });
});

interface ReasonCase {
  readonly name: string;
  readonly dueAt: string;
  readonly importance: Importance;
  readonly remainingMinutes: number;
  readonly expectedTier: Tier;
  readonly expectedReasons: readonly ReasonCode[];
}

const REASON_CASES: readonly ReasonCase[] = [
  {
    name: "overdue with minutes left: OVERDUE then NO_TIME_LEFT",
    dueAt: "2026-10-09T16:00:00Z",
    importance: "LOW",
    remainingMinutes: 60,
    expectedTier: "OVERDUE",
    expectedReasons: ["OVERDUE", "NO_TIME_LEFT"],
  },
  {
    name: "overdue with nothing left: OVERDUE only",
    dueAt: "2026-10-09T16:00:00Z",
    importance: "LOW",
    remainingMinutes: 0,
    expectedTier: "OVERDUE",
    expectedReasons: ["OVERDUE"],
  },
  {
    name: "critical but feasible: TIGHT_SCHEDULE",
    dueAt: "2026-10-13T07:00:00Z",
    importance: "LOW",
    remainingMinutes: 180,
    expectedTier: "CRITICAL",
    expectedReasons: ["TIGHT_SCHEDULE"],
  },
  {
    name: "critical with no capacity: NO_TIME_LEFT instead of TIGHT_SCHEDULE",
    dueAt: "2026-10-12T16:00:00Z",
    importance: "LOW",
    remainingMinutes: 30,
    expectedTier: "CRITICAL",
    expectedReasons: ["NO_TIME_LEFT"],
  },
  {
    name: "at risk: TIGHT_SCHEDULE",
    dueAt: "2026-10-14T07:00:00Z",
    importance: "MEDIUM",
    remainingMinutes: 240,
    expectedTier: "AT_RISK",
    expectedReasons: ["TIGHT_SCHEDULE"],
  },
  {
    name: "on track: COMFORTABLE",
    dueAt: "2026-10-15T07:00:00Z",
    importance: "MEDIUM",
    remainingMinutes: 90,
    expectedTier: "ON_TRACK",
    expectedReasons: ["COMFORTABLE"],
  },
  {
    name: "overdue and important: importance comes after the schedule reasons",
    dueAt: "2026-10-09T16:00:00Z",
    importance: "HIGH",
    remainingMinutes: 60,
    expectedTier: "OVERDUE",
    expectedReasons: ["OVERDUE", "NO_TIME_LEFT", "HIGH_IMPORTANCE"],
  },
  {
    name: "critical and important: TIGHT_SCHEDULE then HIGH_IMPORTANCE",
    dueAt: "2026-10-13T07:00:00Z",
    importance: "HIGH",
    remainingMinutes: 180,
    expectedTier: "CRITICAL",
    expectedReasons: ["TIGHT_SCHEDULE", "HIGH_IMPORTANCE"],
  },
  {
    name: "on track and important: HIGH_IMPORTANCE before COMFORTABLE",
    dueAt: "2026-10-15T07:00:00Z",
    importance: "HIGH",
    remainingMinutes: 90,
    expectedTier: "ON_TRACK",
    expectedReasons: ["HIGH_IMPORTANCE", "COMFORTABLE"],
  },
];

describe("rankTasks reasons", () => {
  it.each(REASON_CASES)(
    "$name",
    ({ dueAt, importance, remainingMinutes, expectedTier, expectedReasons }) => {
      const result = rankTasks(
        [
          makeTask({
            id: "task",
            dueAt: new Date(dueAt),
            importance,
            remainingMinutes,
          }),
        ],
        AVAILABILITY_180,
        NOW,
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.tier).toBe(expectedTier);
      expect(result[0]?.reasons).toEqual(expectedReasons);
    },
  );
});

describe("rankTasks ordering", () => {
  it("orders by tier before score, with 1-based ranks", () => {
    const result = rankTasks(
      [
        makeTask({
          id: "on-track",
          dueAt: new Date("2026-10-22T07:00:00Z"),
          remainingMinutes: 90,
        }),
        makeTask({
          id: "critical",
          dueAt: new Date("2026-10-13T07:00:00Z"),
          remainingMinutes: 180,
        }),
        // Scores 0, yet still ranks first because tier dominates.
        makeTask({
          id: "overdue",
          dueAt: new Date("2026-10-09T16:00:00Z"),
          remainingMinutes: 0,
        }),
        makeTask({
          id: "at-risk",
          dueAt: new Date("2026-10-14T07:00:00Z"),
          remainingMinutes: 180,
        }),
      ],
      AVAILABILITY_180,
      NOW,
    );

    expect(result.map((entry) => entry.taskId)).toEqual([
      "overdue",
      "critical",
      "at-risk",
      "on-track",
    ]);
    expect(result.map((entry) => entry.rank)).toEqual([1, 2, 3, 4]);
  });

  it("orders by score descending within a tier", () => {
    const result = rankTasks(
      [
        makeTask({
          id: "low",
          dueAt: new Date("2026-10-15T07:00:00Z"),
          remainingMinutes: 54,
        }),
        makeTask({
          id: "high",
          dueAt: new Date("2026-10-15T07:00:00Z"),
          remainingMinutes: 108,
        }),
      ],
      AVAILABILITY_180,
      NOW,
    );

    expect(result.map((entry) => entry.taskId)).toEqual(["high", "low"]);
  });

  it("breaks a score tie by dueAt ascending", () => {
    const result = rankTasks(
      [
        // Ordinal id order would put "a-later" first; dueAt must win.
        makeTask({
          id: "a-later",
          dueAt: new Date("2026-10-10T15:00:00Z"),
          importance: "LOW",
        }),
        makeTask({
          id: "b-earlier",
          dueAt: new Date("2026-10-09T15:00:00Z"),
          importance: "LOW",
        }),
      ],
      AVAILABILITY_180,
      NOW,
    );

    expect(result.map((entry) => entry.taskId)).toEqual(["b-earlier", "a-later"]);
  });

  it("treats floating-point score noise as a tie and breaks it by dueAt", () => {
    const result = rankTasks(
      [
        // 72/360 * 1.5 = 0.30000000000000004, while 108/360 * 1 = 0.3.
        makeTask({
          id: "a-later",
          dueAt: new Date("2026-10-14T12:00:00Z"),
          importance: "MEDIUM",
          remainingMinutes: 72,
        }),
        makeTask({
          id: "b-earlier",
          dueAt: new Date("2026-10-14T07:00:00Z"),
          importance: "LOW",
          remainingMinutes: 108,
        }),
      ],
      AVAILABILITY_180,
      NOW,
    );

    expect(result.map((entry) => entry.taskId)).toEqual(["b-earlier", "a-later"]);
    // The reported score stays unrounded, so the noise is still visible there.
    expect(result[0]?.score).toBe(0.3);
    expect(result[1]?.score).toBe(0.2 * 1.5);
    expect(result[0]?.score).not.toBe(result[1]?.score);
  });

  it("treats floating-point score noise as a tie and breaks it by ordinal id", () => {
    const dueAt = new Date("2026-10-14T07:00:00Z");
    const noisyHigh = makeTask({
      id: "a",
      dueAt,
      importance: "MEDIUM",
      remainingMinutes: 72,
    });
    const exact = makeTask({
      id: "B",
      dueAt,
      importance: "LOW",
      remainingMinutes: 108,
    });

    const first = rankTasks([noisyHigh, exact], AVAILABILITY_180, NOW);
    const second = rankTasks([exact, noisyHigh], AVAILABILITY_180, NOW);

    // The rounded scores tie, so ordinal id decides: "B" (66) before "a" (97).
    // Without rounding, "a" would win on its slightly larger exact score, so
    // this order discriminates the fix.
    expect(first.map((entry) => entry.taskId)).toEqual(["B", "a"]);
    expect(second.map((entry) => entry.taskId)).toEqual(["B", "a"]);
  });

  it("does not round away real score differences", () => {
    const result = rankTasks(
      [
        // Id and dueAt would both put "a" first; the ~1e-6 higher score must win.
        makeTask({
          id: "a",
          dueAt: new Date("2026-10-14T07:00:00Z"),
          importance: "LOW",
          remainingMinutes: 108,
        }),
        makeTask({
          id: "B",
          dueAt: new Date("2026-10-14T12:00:00Z"),
          importance: "MEDIUM",
          remainingMinutes: 108,
        }),
      ],
      AVAILABILITY_180,
      NOW,
      NEARLY_EQUAL_WEIGHTS,
    );

    expect(result.map((entry) => entry.taskId)).toEqual(["B", "a"]);
    expect(result[0]?.score).toBeGreaterThan(result[1]?.score ?? 0);
  });

  it("breaks a full tie by ordinal id, independent of input order", () => {
    const shared = {
      dueAt: new Date("2026-10-13T07:00:00Z"),
      remainingMinutes: 90,
    } as const;
    const upper = makeTask({ id: "B", ...shared });
    const lower = makeTask({ id: "a", ...shared });

    const first = rankTasks([lower, upper], AVAILABILITY_180, NOW);
    const second = rankTasks([upper, lower], AVAILABILITY_180, NOW);

    // Ordinal UTF-16 order: "B" (66) sorts before "a" (97); locale-aware
    // comparison would put "a" first.
    expect(first.map((entry) => entry.taskId)).toEqual(["B", "a"]);
    expect(second.map((entry) => entry.taskId)).toEqual(["B", "a"]);
  });
});
