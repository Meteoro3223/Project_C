import { describe, expect, it } from "vitest";
import { rankTasks } from "./rank.js";
import type { Importance, RankableTask, TaskStatus, WeeklyAvailability } from "./types.js";

/** PLAN section 6 fixture: 180 available minutes every day, Madrid timezone. */
const AVAILABILITY_180: WeeklyAvailability = {
  timezone: "Europe/Madrid",
  minutesByWeekday: { 1: 180, 2: 180, 3: 180, 4: 180, 5: 180, 6: 180, 7: 180 },
};

/** No capacity on any day. */
const NO_CAPACITY: WeeklyAvailability = {
  timezone: "Europe/Madrid",
  minutesByWeekday: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 },
};

/** Monday 12 October 2026, 09:00 in Madrid (CEST, +2). */
const NOW = new Date("2026-10-12T07:00:00Z");

interface TaskInput {
  readonly id: string;
  /** ISO instant. Local due times in this file are 18:00 Europe/Madrid. */
  readonly dueAt: string;
  readonly importance: Importance;
  readonly remainingMinutes: number;
  readonly status?: TaskStatus;
}

function makeTask({
  id,
  dueAt,
  importance,
  remainingMinutes,
  status = "TODO",
}: TaskInput): RankableTask {
  return { id, dueAt: new Date(dueAt), importance, remainingMinutes, status };
}

describe("S1: base example", () => {
  // 180 min/day, now Mon 09:00 local.
  // A: due Wed 18:00 local -> Mon + Tue = 360 available.
  // B: due Sat 18:00 local -> Mon..Fri = 900 available.
  // C: due Thu 22 Oct 18:00 local -> 10 days = 1800 available.
  const ranking = rankTasks(
    [
      makeTask({
        id: "A",
        dueAt: "2026-10-14T16:00:00Z",
        importance: "HIGH",
        remainingMinutes: 240,
      }),
      makeTask({
        id: "B",
        dueAt: "2026-10-17T16:00:00Z",
        importance: "MEDIUM",
        remainingMinutes: 180,
      }),
      makeTask({
        id: "C",
        dueAt: "2026-10-22T16:00:00Z",
        importance: "HIGH",
        remainingMinutes: 360,
      }),
    ],
    AVAILABILITY_180,
    NOW,
  );

  it("orders A, C, B with ranks 1, 2, 3", () => {
    expect(ranking.map(({ taskId, rank }) => ({ taskId, rank }))).toEqual([
      { taskId: "A", rank: 1 },
      { taskId: "C", rank: 2 },
      { taskId: "B", rank: 3 },
    ]);
  });

  it("reports A as AT_RISK with pressure 2/3 and score 4/3", () => {
    expect(ranking[0]).toMatchObject({
      taskId: "A",
      tier: "AT_RISK",
      noCapacity: false,
      importanceWeight: 2,
      remainingMinutes: 240,
      availableMinutes: 360,
      daysUntilDue: 2,
      reasons: ["TIGHT_SCHEDULE", "HIGH_IMPORTANCE"],
    });
    expect(ranking[0]?.pressure).toBeCloseTo(2 / 3, 10);
    expect(ranking[0]?.score).toBeCloseTo(4 / 3, 10);
  });

  it("reports B as ON_TRACK with pressure 0.2 and score 0.3", () => {
    expect(ranking[2]).toMatchObject({
      taskId: "B",
      tier: "ON_TRACK",
      noCapacity: false,
      importanceWeight: 1.5,
      remainingMinutes: 180,
      availableMinutes: 900,
      daysUntilDue: 5,
      reasons: ["COMFORTABLE"],
    });
    expect(ranking[2]?.pressure).toBeCloseTo(0.2, 10);
    expect(ranking[2]?.score).toBeCloseTo(0.3, 10);
  });

  it("reports C as ON_TRACK with pressure 0.2 and score 0.4", () => {
    expect(ranking[1]).toMatchObject({
      taskId: "C",
      tier: "ON_TRACK",
      noCapacity: false,
      importanceWeight: 2,
      remainingMinutes: 360,
      availableMinutes: 1800,
      daysUntilDue: 10,
      reasons: ["HIGH_IMPORTANCE", "COMFORTABLE"],
    });
    expect(ranking[1]?.pressure).toBeCloseTo(0.2, 10);
    expect(ranking[1]?.score).toBeCloseTo(0.4, 10);
  });
});

describe("S2: long task with a distant deadline", () => {
  // L: 1200 min, due Thu 22 Oct 18:00 local -> 10 days = 1800 available.
  // Q: 60 min, due Tue 13 Oct 18:00 local -> 1 day = 180 available.
  const ranking = rankTasks(
    [
      makeTask({
        id: "L",
        dueAt: "2026-10-22T16:00:00Z",
        importance: "MEDIUM",
        remainingMinutes: 1200,
      }),
      makeTask({
        id: "Q",
        dueAt: "2026-10-13T16:00:00Z",
        importance: "HIGH",
        remainingMinutes: 60,
      }),
    ],
    AVAILABILITY_180,
    NOW,
  );

  it("orders L before Q because pressure dominates the distant deadline", () => {
    expect(ranking.map(({ taskId }) => taskId)).toEqual(["L", "Q"]);
  });

  it("reports L as AT_RISK with pressure 2/3 and score 1.0", () => {
    expect(ranking[0]).toMatchObject({
      taskId: "L",
      tier: "AT_RISK",
      availableMinutes: 1800,
    });
    expect(ranking[0]?.pressure).toBeCloseTo(2 / 3, 10);
    expect(ranking[0]?.score).toBeCloseTo(1.0, 10);
  });

  it("reports Q as ON_TRACK with pressure 1/3 and score 2/3", () => {
    expect(ranking[1]).toMatchObject({
      taskId: "Q",
      tier: "ON_TRACK",
      availableMinutes: 180,
    });
    expect(ranking[1]?.pressure).toBeCloseTo(1 / 3, 10);
    expect(ranking[1]?.score).toBeCloseTo(2 / 3, 10);
  });
});

describe("S3: overdue tasks", () => {
  // O1, O2 and O3 were due Fri 9 Oct 18:00 local. X is due Wed 14 Oct.
  const ranking = rankTasks(
    [
      makeTask({
        id: "O1",
        dueAt: "2026-10-09T16:00:00Z",
        importance: "LOW",
        remainingMinutes: 60,
      }),
      makeTask({
        id: "O2",
        dueAt: "2026-10-09T16:00:00Z",
        importance: "HIGH",
        remainingMinutes: 300,
      }),
      makeTask({
        id: "O3",
        dueAt: "2026-10-09T16:00:00Z",
        importance: "LOW",
        remainingMinutes: 0,
      }),
      makeTask({
        id: "X",
        dueAt: "2026-10-14T16:00:00Z",
        importance: "MEDIUM",
        remainingMinutes: 240,
      }),
    ],
    AVAILABILITY_180,
    NOW,
  );

  it("orders O2, O1, O3, then X", () => {
    expect(ranking.map(({ taskId }) => taskId)).toEqual(["O2", "O1", "O3", "X"]);
  });

  it("reports O1 as OVERDUE with no capacity, pressure 10 and score 10", () => {
    expect(ranking[1]).toMatchObject({
      taskId: "O1",
      tier: "OVERDUE",
      noCapacity: true,
      reasons: ["OVERDUE", "NO_TIME_LEFT"],
    });
    expect(ranking[1]?.pressure).toBe(10);
    expect(ranking[1]?.score).toBe(10);
  });

  it("reports O2 as OVERDUE with no capacity, pressure 10 and score 20", () => {
    expect(ranking[0]).toMatchObject({
      taskId: "O2",
      tier: "OVERDUE",
      noCapacity: true,
      reasons: ["OVERDUE", "NO_TIME_LEFT", "HIGH_IMPORTANCE"],
    });
    expect(ranking[0]?.pressure).toBe(10);
    expect(ranking[0]?.score).toBe(20);
  });

  it("reports O3 as OVERDUE yet feasible with pressure 0 and score 0", () => {
    expect(ranking[2]).toMatchObject({
      taskId: "O3",
      tier: "OVERDUE",
      noCapacity: false,
      reasons: ["OVERDUE"],
    });
    expect(ranking[2]?.pressure).toBe(0);
    expect(ranking[2]?.score).toBe(0);
  });

  it("reports X as AT_RISK with pressure 2/3 and score 1.0", () => {
    expect(ranking[3]).toMatchObject({
      taskId: "X",
      tier: "AT_RISK",
    });
    expect(ranking[3]?.pressure).toBeCloseTo(2 / 3, 10);
    expect(ranking[3]?.score).toBeCloseTo(1.0, 10);
  });
});

describe("S4: deadline today", () => {
  it("makes a same-day deadline CRITICAL with no capacity and ahead of AT_RISK", () => {
    // T: due today at 18:00 local -> available 0.
    // A: due Wed 14 Oct -> AT_RISK, pressure 2/3.
    const ranking = rankTasks(
      [
        makeTask({
          id: "A",
          dueAt: "2026-10-14T16:00:00Z",
          importance: "MEDIUM",
          remainingMinutes: 240,
        }),
        makeTask({
          id: "T",
          dueAt: "2026-10-12T16:00:00Z",
          importance: "MEDIUM",
          remainingMinutes: 30,
        }),
      ],
      AVAILABILITY_180,
      NOW,
    );

    expect(ranking.map(({ taskId }) => taskId)).toEqual(["T", "A"]);
    expect(ranking[0]).toMatchObject({
      taskId: "T",
      tier: "CRITICAL",
      noCapacity: true,
      availableMinutes: 0,
      daysUntilDue: 0,
    });
    expect(ranking[0]?.pressure).toBe(10);
    expect(ranking[0]?.score).toBe(15);
    expect(ranking[1]?.tier).toBe("AT_RISK");
  });

  it("uses an instant comparison at the overdue boundary", () => {
    const atNow = rankTasks(
      [
        makeTask({
          id: "at-now",
          dueAt: "2026-10-12T07:00:00Z",
          importance: "MEDIUM",
          remainingMinutes: 30,
        }),
      ],
      AVAILABILITY_180,
      NOW,
    );

    expect(atNow[0]?.tier).toBe("CRITICAL");
    expect(atNow[0]?.noCapacity).toBe(true);

    const oneMillisecondBefore = new Date(NOW.getTime() - 1);
    const overdue = rankTasks(
      [
        {
          id: "past",
          dueAt: oneMillisecondBefore,
          importance: "MEDIUM",
          remainingMinutes: 30,
          status: "TODO",
        },
      ],
      AVAILABILITY_180,
      NOW,
    );

    expect(overdue[0]?.tier).toBe("OVERDUE");
  });
});

describe("S5: completed tasks", () => {
  it("never ranks DONE tasks and keeps the remaining ranks gap-free", () => {
    const ranking = rankTasks(
      [
        makeTask({
          id: "done-first",
          dueAt: "2026-10-09T16:00:00Z",
          importance: "HIGH",
          remainingMinutes: 60,
          status: "DONE",
        }),
        makeTask({
          id: "b",
          dueAt: "2026-10-14T16:00:00Z",
          importance: "MEDIUM",
          remainingMinutes: 240,
        }),
        makeTask({
          id: "done-middle",
          dueAt: "2026-10-13T16:00:00Z",
          importance: "HIGH",
          remainingMinutes: 180,
          status: "DONE",
        }),
        makeTask({
          id: "a",
          dueAt: "2026-10-14T16:00:00Z",
          importance: "MEDIUM",
          remainingMinutes: 240,
        }),
        makeTask({
          id: "c",
          dueAt: "2026-10-14T16:00:00Z",
          importance: "MEDIUM",
          remainingMinutes: 240,
        }),
      ],
      AVAILABILITY_180,
      NOW,
    );

    expect(ranking.map(({ taskId }) => taskId)).toEqual(["a", "b", "c"]);
    expect(ranking.map(({ rank }) => rank)).toEqual([1, 2, 3]);
  });
});

describe("S6: ties", () => {
  it("orders identical tasks by ordinal id for every input permutation", () => {
    const shared = {
      dueAt: "2026-10-14T16:00:00Z",
      importance: "MEDIUM",
      remainingMinutes: 240,
    } as const;
    const upperB = makeTask({ id: "B", ...shared });
    const lowerA = makeTask({ id: "a", ...shared });
    const upperC = makeTask({ id: "C", ...shared });

    const baseline = rankTasks([upperB, lowerA, upperC], AVAILABILITY_180, NOW);

    // Ordinal UTF-16 order: "B" (66), "C" (67), "a" (97). Locale-aware
    // comparison would put "a" first instead.
    expect(baseline.map(({ taskId }) => taskId)).toEqual(["B", "C", "a"]);
    expect(baseline.map(({ rank }) => rank)).toEqual([1, 2, 3]);

    const permutations: readonly (readonly RankableTask[])[] = [
      [upperB, lowerA, upperC],
      [upperB, upperC, lowerA],
      [lowerA, upperB, upperC],
      [lowerA, upperC, upperB],
      [upperC, upperB, lowerA],
      [upperC, lowerA, upperB],
    ];

    for (const permutation of permutations) {
      expect(rankTasks(permutation, AVAILABILITY_180, NOW)).toEqual(baseline);
    }
  });
});

describe("S7: no availability", () => {
  it("marks a pending task CRITICAL with no capacity when every day has zero capacity", () => {
    const ranking = rankTasks(
      [
        makeTask({
          id: "pending",
          dueAt: "2026-10-17T16:00:00Z",
          importance: "LOW",
          remainingMinutes: 120,
        }),
      ],
      NO_CAPACITY,
      NOW,
    );

    expect(ranking[0]).toMatchObject({
      taskId: "pending",
      tier: "CRITICAL",
      noCapacity: true,
      availableMinutes: 0,
      reasons: ["NO_TIME_LEFT"],
    });
    expect(ranking[0]?.pressure).toBe(10);
  });

  it("keeps a task with nothing left ON_TRACK when every day has zero capacity", () => {
    const ranking = rankTasks(
      [
        makeTask({
          id: "empty",
          dueAt: "2026-10-17T16:00:00Z",
          importance: "LOW",
          remainingMinutes: 0,
        }),
      ],
      NO_CAPACITY,
      NOW,
    );

    expect(ranking[0]).toMatchObject({
      taskId: "empty",
      tier: "ON_TRACK",
      noCapacity: false,
      availableMinutes: 0,
    });
    expect(ranking[0]?.pressure).toBe(0);
  });
});

describe("S8: DST transitions", () => {
  const cases = [
    {
      name: "autumn change",
      now: "2026-10-23T07:00:00Z",
      dueAt: "2026-10-27T17:00:00Z",
    },
    {
      name: "spring change",
      now: "2026-03-27T08:00:00Z",
      dueAt: "2026-03-31T16:00:00Z",
    },
  ] as const;

  it.each(cases)("counts four civil days across the $name", ({ now, dueAt }) => {
    const ranking = rankTasks(
      [
        makeTask({
          id: "task",
          dueAt,
          importance: "MEDIUM",
          remainingMinutes: 360,
        }),
      ],
      AVAILABILITY_180,
      new Date(now),
    );

    expect(ranking[0]).toMatchObject({
      taskId: "task",
      tier: "AT_RISK",
      availableMinutes: 720,
      daysUntilDue: 4,
    });
    expect(ranking[0]?.pressure).toBeCloseTo(0.5, 10);
    expect(ranking[0]?.score).toBeCloseTo(0.75, 10);
  });
});
