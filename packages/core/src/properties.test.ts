import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_CONFIG } from "./config.js";
import { rankTasks } from "./rank.js";
import type {
  Importance,
  RankableTask,
  RankedTask,
  TaskStatus,
  Tier,
  Weekday,
  WeeklyAvailability,
} from "./types.js";

/**
 * Property-based tests for the priority engine (P1-T6).
 *
 * Every property runs over generated cases drawn from a small seeded PRNG
 * (mulberry32) instead of a property-testing library: the suite stays
 * deterministic and reversible, and adding a dependency for this task alone is
 * not worth it. A failure message carries the seed, case index and the full
 * case (now, availability and tasks as JSON); re-running the suite from case 0
 * with that seed reproduces the failing input.
 */
const CASES_PER_PROPERTY = 200;

/** Every third case uses the tie-heavy generator (permutation and shape). */
const TIE_HEAVY_EVERY = 3;

/** Fixed deadline instants, as day offsets from `now`, for tie-heavy cases. */
const TIE_DUE_OFFSET_DAYS = [-2, 1, 3] as const;

/** Small remaining-minute pool for tie-heavy cases. */
const TIE_REMAINING_MINUTES = [0, 60, 120] as const;

/** Fixed seed per property, so every property explores its own case stream. */
const SEEDS = {
  permutation: 0x1a2b3c4d,
  idempotence: 0x2b3c4d5e,
  shape: 0x3c4d5e6f,
  invariants: 0x4d5e6f70,
  effort: 0x5e6f7081,
  time: 0x6f708192,
  importance: 0x708192a3,
  uniformCapacity: 0x81a2b3c4,
} as const;

const TIMEZONE = "Europe/Madrid";
const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 24 * 60;

/** Madrid anchors chosen to make deadlines cross both DST transitions. */
const NOW_ANCHORS: readonly number[] = [
  Date.parse("2026-01-15T09:00:00Z"),
  Date.parse("2026-03-20T08:00:00Z"), // crosses the spring change (29 March)
  Date.parse("2026-10-12T07:00:00Z"),
  Date.parse("2026-10-20T07:00:00Z"), // crosses the autumn change (25 October)
];

const IMPORTANCES: readonly Importance[] = ["LOW", "MEDIUM", "HIGH"];
const STATUSES: readonly TaskStatus[] = ["TODO", "IN_PROGRESS", "DONE"];
const NON_DONE_STATUSES: readonly TaskStatus[] = ["TODO", "IN_PROGRESS"];
const WEEKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7];

/** Tier positions used by the ordering assertions (PLAN section 6, step 7). */
const TIER_ORDER: Readonly<Record<Tier, number>> = {
  OVERDUE: 0,
  CRITICAL: 1,
  AT_RISK: 2,
  ON_TRACK: 3,
};

/** Tolerance for "score never increases within a tier". */
const SCORE_TOLERANCE = 1e-9;

/** Tolerance below which two scores count as a full tie for tie-order checks. */
const FULL_TIE_TOLERANCE = 1e-12;

interface Rng {
  next(): number;
  /** Inclusive integer in `[min, max]`. */
  int(min: number, max: number): number;
  pick<T>(values: readonly T[]): T;
}

/**
 * Mulberry32: a tiny deterministic PRNG. The same seed always yields the same
 * sequence, which is all these tests need; it is not used by production code.
 */
function createRng(seed: number): Rng {
  let state = seed >>> 0;

  function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  function int(min: number, max: number): number {
    return min + Math.floor(next() * (max - min + 1));
  }

  function pick<T>(values: readonly T[]): T {
    return at(values, int(0, values.length - 1));
  }

  return { next, int, pick };
}

/** Reads `values[index]`, narrowing for `noUncheckedIndexedAccess`. */
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`Index ${index} is out of bounds (length ${values.length})`);
  }
  return value;
}

/**
 * Failure message carrying the seed, the case index and the whole case as JSON,
 * so any failing assertion can be reproduced and inspected without rerunning.
 */
function caseMessage(
  seed: number,
  index: number,
  now: Date,
  availability: WeeklyAvailability,
  tasks: readonly RankableTask[],
  detail: string,
): string {
  return [
    `seed=${seed}, case=${index}: ${detail}`,
    `now=${JSON.stringify(now)}`,
    `availability=${JSON.stringify(availability)}`,
    `tasks=${JSON.stringify(tasks)}`,
  ].join("\n");
}

function randomNow(rng: Rng): Date {
  return new Date(rng.pick(NOW_ANCHORS));
}

/** Random offset in `[minDays, maxDays]` civil days, in milliseconds. */
function randomDueAt(rng: Rng, now: Date, minDays: number, maxDays: number): Date {
  const minutes = rng.int(minDays * MINUTES_PER_DAY, maxDays * MINUTES_PER_DAY);
  return new Date(now.getTime() + minutes * MINUTE_MS);
}

/** Availability with optional all-zero weeks (roughly 1 case in 10). */
function randomAvailability(rng: Rng): WeeklyAvailability {
  const allZero = rng.int(0, 9) === 0;
  const minutesByWeekday: Record<Weekday, number> = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
    6: 0,
    7: 0,
  };

  for (const weekday of WEEKDAYS) {
    minutesByWeekday[weekday] = allZero ? 0 : rng.int(0, 480);
  }

  return { timezone: TIMEZONE, minutesByWeekday };
}

/** The same capacity on every weekday. */
function uniformAvailability(minutes: number): WeeklyAvailability {
  return {
    timezone: TIMEZONE,
    minutesByWeekday: {
      1: minutes,
      2: minutes,
      3: minutes,
      4: minutes,
      5: minutes,
      6: minutes,
      7: minutes,
    },
  };
}

function freezeTask(task: RankableTask): RankableTask {
  return Object.freeze(task);
}

/**
 * Generates 1-12 tasks with unique ids, deep-frozen as `rankTasks` expects.
 *
 * In tie-heavy mode deadlines come from two or three fixed instants,
 * `remainingMinutes` from a three-value pool and importance from two values,
 * so full and near ties are common.
 */
function randomTasks(
  rng: Rng,
  now: Date,
  count: number,
  tieHeavy = false,
): readonly RankableTask[] {
  const dueInstants = tieHeavy
    ? shuffled(rng, TIE_DUE_OFFSET_DAYS)
        .slice(0, rng.int(2, 3))
        .map((days) => new Date(now.getTime() + days * MINUTES_PER_DAY * MINUTE_MS))
    : [];
  const tieImportances = tieHeavy ? shuffled(rng, IMPORTANCES).slice(0, 2) : [];

  const tasks: RankableTask[] = [];

  for (let index = 0; index < count; index += 1) {
    tasks.push(
      freezeTask({
        id: `task-${String(index).padStart(2, "0")}`,
        dueAt: tieHeavy ? rng.pick(dueInstants) : randomDueAt(rng, now, -10, 60),
        importance: tieHeavy ? rng.pick(tieImportances) : rng.pick(IMPORTANCES),
        remainingMinutes: tieHeavy ? rng.pick(TIE_REMAINING_MINUTES) : rng.int(0, 1200),
        status: rng.pick(STATUSES),
      }),
    );
  }

  return Object.freeze(tasks);
}

/** Returns a new shuffled array, leaving the input untouched. */
function shuffled<T>(rng: Rng, values: readonly T[]): readonly T[] {
  const copy = [...values];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapWith = rng.int(0, index);
    const current = at(copy, index);
    copy[index] = at(copy, swapWith);
    copy[swapWith] = current;
  }

  return copy;
}

/** Looks up the original input task behind a ranked entry. */
function inputTask(tasks: readonly RankableTask[], taskId: string): RankableTask {
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) {
    throw new RangeError(`Ranked task ${taskId} is missing from the input`);
  }
  return task;
}

/** Asserts a ranking has exactly one entry and returns it. */
function single(ranking: readonly RankedTask[], context: string): RankedTask {
  expect(ranking, `${context}: expected exactly one ranked task`).toHaveLength(1);
  const entry = ranking[0];
  if (entry === undefined) {
    throw new Error(`${context}: expected exactly one ranked task`);
  }
  return entry;
}

describe("property: permutation invariance", () => {
  it("returns the same ranking for every input order", () => {
    const seed = SEEDS.permutation;
    const rng = createRng(seed);

    for (let index = 0; index < CASES_PER_PROPERTY; index += 1) {
      const now = randomNow(rng);
      const tieHeavy = index % TIE_HEAVY_EVERY === 0;
      const tasks = randomTasks(rng, now, rng.int(1, 12), tieHeavy);
      const availability = randomAvailability(rng);
      const baseline = rankTasks(tasks, availability, now);

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const ranking = rankTasks(shuffled(rng, tasks), availability, now);
        expect(
          ranking,
          caseMessage(
            seed,
            index,
            now,
            availability,
            tasks,
            `shuffle ${attempt} changed the ranking`,
          ),
        ).toEqual(baseline);
      }
    }
  });
});

describe("property: idempotence", () => {
  it("returns an equal ranking on every call and never mutates the input", () => {
    const seed = SEEDS.idempotence;
    const rng = createRng(seed);

    for (let index = 0; index < CASES_PER_PROPERTY; index += 1) {
      const now = randomNow(rng);
      const tasks = randomTasks(rng, now, rng.int(1, 12));
      const availability = randomAvailability(rng);
      const snapshot = tasks.map((task) => ({ ...task }));
      const dueTimes = tasks.map((task) => task.dueAt.getTime());

      expect(
        Object.isFrozen(tasks),
        caseMessage(seed, index, now, availability, tasks, "task array is not frozen"),
      ).toBe(true);
      for (const task of tasks) {
        expect(
          Object.isFrozen(task),
          caseMessage(seed, index, now, availability, tasks, `task ${task.id} is not frozen`),
        ).toBe(true);
      }

      const first = rankTasks(tasks, availability, now);
      const second = rankTasks(tasks, availability, now);

      expect(
        second,
        caseMessage(seed, index, now, availability, tasks, "second call differs from the first"),
      ).toEqual(first);
      expect(
        tasks,
        caseMessage(seed, index, now, availability, tasks, "input tasks were mutated"),
      ).toEqual(snapshot);
      expect(
        tasks.map((task) => task.dueAt.getTime()),
        caseMessage(seed, index, now, availability, tasks, "input dueAt instants were mutated"),
      ).toEqual(dueTimes);
    }
  });
});

describe("property: output shape", () => {
  it("ranks exactly the pending tasks with contiguous ranks and a sound order", () => {
    const seed = SEEDS.shape;
    const rng = createRng(seed);

    for (let index = 0; index < CASES_PER_PROPERTY; index += 1) {
      const now = randomNow(rng);
      const tieHeavy = index % TIE_HEAVY_EVERY === 0;
      const tasks = randomTasks(rng, now, rng.int(1, 12), tieHeavy);
      const availability = randomAvailability(rng);
      const ranking = rankTasks(tasks, availability, now);

      const expectedIds = tasks
        .filter((task) => task.status !== "DONE")
        .map((task) => task.id)
        .sort();
      const actualIds = ranking.map((entry) => entry.taskId).sort();
      expect(
        actualIds,
        caseMessage(seed, index, now, availability, tasks, "ranked ids differ from pending ids"),
      ).toEqual(expectedIds);

      const expectedRanks = ranking.map((_, position) => position + 1);
      expect(
        ranking.map((entry) => entry.rank),
        caseMessage(seed, index, now, availability, tasks, "ranks are not 1..n"),
      ).toEqual(expectedRanks);

      for (let position = 1; position < ranking.length; position += 1) {
        const previous = at(ranking, position - 1);
        const current = at(ranking, position);

        expect(
          TIER_ORDER[current.tier] >= TIER_ORDER[previous.tier],
          caseMessage(
            seed,
            index,
            now,
            availability,
            tasks,
            `tier decreased at rank ${current.rank}`,
          ),
        ).toBe(true);

        if (current.tier !== previous.tier) {
          continue;
        }

        expect(
          current.score <= previous.score + SCORE_TOLERANCE,
          caseMessage(
            seed,
            index,
            now,
            availability,
            tasks,
            `score increased within ${current.tier} at rank ${current.rank} ` +
              `(${previous.score} -> ${current.score})`,
          ),
        ).toBe(true);

        if (Math.abs(current.score - previous.score) < FULL_TIE_TOLERANCE) {
          const previousTask = inputTask(tasks, previous.taskId);
          const currentTask = inputTask(tasks, current.taskId);
          const previousDue = previousTask.dueAt.getTime();
          const currentDue = currentTask.dueAt.getTime();

          expect(
            currentDue >= previousDue,
            caseMessage(
              seed,
              index,
              now,
              availability,
              tasks,
              `tied scores at ranks ${previous.rank}/${current.rank} are not dueAt-ascending`,
            ),
          ).toBe(true);

          if (currentDue === previousDue) {
            expect(
              previousTask.id < currentTask.id,
              caseMessage(
                seed,
                index,
                now,
                availability,
                tasks,
                `full tie at ranks ${previous.rank}/${current.rank} is not id-ascending`,
              ),
            ).toBe(true);
          }
        }
      }
    }
  });
});

describe("property: tiers and pressure invariants", () => {
  it("derives overdue, no-capacity state, bounds, reasons and tiers from the input", () => {
    const seed = SEEDS.invariants;
    const rng = createRng(seed);

    for (let index = 0; index < CASES_PER_PROPERTY; index += 1) {
      const now = randomNow(rng);
      const tasks = randomTasks(rng, now, rng.int(1, 12));
      const availability = randomAvailability(rng);
      const ranking = rankTasks(tasks, availability, now);

      for (const entry of ranking) {
        const task = inputTask(tasks, entry.taskId);
        const context = (detail: string): string =>
          caseMessage(seed, index, now, availability, tasks, detail);

        const overdue = task.dueAt.getTime() < now.getTime();
        expect(entry.tier === "OVERDUE", context(`OVERDUE must be ${overdue}`)).toBe(overdue);

        const noCapacity = entry.availableMinutes === 0 && entry.remainingMinutes > 0;
        expect(entry.noCapacity, context(`noCapacity must be ${noCapacity}`)).toBe(noCapacity);

        expect(
          entry.pressure >= 0 && entry.pressure <= DEFAULT_ENGINE_CONFIG.maxPressure,
          context(
            `pressure ${entry.pressure} is outside [0, ${DEFAULT_ENGINE_CONFIG.maxPressure}]`,
          ),
        ).toBe(true);

        expect(
          entry.reasons.includes("NO_TIME_LEFT"),
          context(`NO_TIME_LEFT must be ${noCapacity}`),
        ).toBe(noCapacity);

        if (overdue) {
          continue;
        }

        if (entry.pressure >= DEFAULT_ENGINE_CONFIG.criticalThreshold) {
          expect(entry.tier, context("pressure >= 1 must be CRITICAL")).toBe("CRITICAL");
        } else if (entry.pressure >= DEFAULT_ENGINE_CONFIG.atRiskThreshold) {
          expect(entry.tier, context("0.5 <= pressure < 1 must be AT_RISK")).toBe("AT_RISK");
        }
      }
    }
  });
});

describe("property: monotonicity in effort", () => {
  it("never lowers pressure or score when remaining minutes increase", () => {
    const seed = SEEDS.effort;
    const rng = createRng(seed);

    for (let index = 0; index < CASES_PER_PROPERTY; index += 1) {
      const now = randomNow(rng);
      const availability = randomAvailability(rng);
      const dueAt = randomDueAt(rng, now, -10, 60);
      const remainingMinutes = rng.int(0, 1200);
      const extraMinutes = rng.int(0, 1200);
      const importance = rng.pick(IMPORTANCES);
      const status = rng.pick(NON_DONE_STATUSES);
      const baseTask = freezeTask({ id: "task", dueAt, importance, remainingMinutes, status });
      const increasedTask = freezeTask({
        id: "task",
        dueAt,
        importance,
        remainingMinutes: remainingMinutes + extraMinutes,
        status,
      });
      const tasks = [baseTask, increasedTask];

      const before = single(
        rankTasks([baseTask], availability, now),
        caseMessage(seed, index, now, availability, tasks, "effort baseline"),
      );
      const after = single(
        rankTasks([increasedTask], availability, now),
        caseMessage(seed, index, now, availability, tasks, "effort with extra minutes"),
      );

      expect(
        after.pressure >= before.pressure,
        caseMessage(
          seed,
          index,
          now,
          availability,
          tasks,
          `pressure fell from ${before.pressure} to ${after.pressure} ` +
            `after adding ${extraMinutes} minutes`,
        ),
      ).toBe(true);
      expect(
        after.score >= before.score,
        caseMessage(
          seed,
          index,
          now,
          availability,
          tasks,
          `score fell from ${before.score} to ${after.score} ` +
            `after adding ${extraMinutes} minutes`,
        ),
      ).toBe(true);
    }
  });
});

describe("property: monotonicity in time", () => {
  it("never lowers availability or raises pressure for a later, non-overdue deadline", () => {
    const seed = SEEDS.time;
    const rng = createRng(seed);

    for (let index = 0; index < CASES_PER_PROPERTY; index += 1) {
      const now = randomNow(rng);
      const availability = randomAvailability(rng);
      const dueAt = new Date(now.getTime() + rng.int(0, 60 * MINUTES_PER_DAY) * MINUTE_MS);
      const laterDueAt = new Date(dueAt.getTime() + rng.int(0, 30 * MINUTES_PER_DAY) * MINUTE_MS);
      const remainingMinutes = rng.int(0, 1200);
      const importance = rng.pick(IMPORTANCES);
      const status = rng.pick(NON_DONE_STATUSES);
      const earlierTask = freezeTask({
        id: "task",
        dueAt,
        importance,
        remainingMinutes,
        status,
      });
      const laterTask = freezeTask({
        id: "task",
        dueAt: laterDueAt,
        importance,
        remainingMinutes,
        status,
      });
      const tasks = [earlierTask, laterTask];

      const earlier = single(
        rankTasks([earlierTask], availability, now),
        caseMessage(seed, index, now, availability, tasks, "earlier deadline"),
      );
      const later = single(
        rankTasks([laterTask], availability, now),
        caseMessage(seed, index, now, availability, tasks, "later deadline"),
      );

      expect(
        earlier.tier,
        caseMessage(seed, index, now, availability, tasks, "generated deadline is overdue"),
      ).not.toBe("OVERDUE");
      expect(
        later.availableMinutes >= earlier.availableMinutes,
        caseMessage(
          seed,
          index,
          now,
          availability,
          tasks,
          `availability fell from ${earlier.availableMinutes} to ${later.availableMinutes} ` +
            "for a later deadline",
        ),
      ).toBe(true);
      expect(
        later.pressure <= earlier.pressure,
        caseMessage(
          seed,
          index,
          now,
          availability,
          tasks,
          `pressure rose from ${earlier.pressure} to ${later.pressure} ` + "for a later deadline",
        ),
      ).toBe(true);
    }
  });
});

describe("property: importance", () => {
  it("never lowers the score for a higher importance at equal pressure", () => {
    const seed = SEEDS.importance;
    const rng = createRng(seed);

    for (let index = 0; index < CASES_PER_PROPERTY; index += 1) {
      const now = randomNow(rng);
      const availability = randomAvailability(rng);
      const dueAt = randomDueAt(rng, now, -10, 60);
      const remainingMinutes = rng.int(0, 1200);
      const tasks = IMPORTANCES.map((importance) =>
        freezeTask({
          id: `task-${importance}`,
          dueAt,
          importance,
          remainingMinutes,
          status: "TODO",
        }),
      );

      const rankAt = (importance: Importance): RankedTask =>
        single(
          rankTasks([inputTask(tasks, `task-${importance}`)], availability, now),
          caseMessage(seed, index, now, availability, tasks, `single ranking for ${importance}`),
        );

      const low = rankAt("LOW");
      const medium = rankAt("MEDIUM");
      const high = rankAt("HIGH");

      expect(
        medium.pressure,
        caseMessage(seed, index, now, availability, tasks, "pressure changed with importance"),
      ).toBe(low.pressure);
      expect(
        high.pressure,
        caseMessage(seed, index, now, availability, tasks, "pressure changed with importance"),
      ).toBe(low.pressure);
      expect(
        medium.score >= low.score,
        caseMessage(
          seed,
          index,
          now,
          availability,
          tasks,
          `MEDIUM scored ${medium.score} below LOW ${low.score}`,
        ),
      ).toBe(true);
      expect(
        high.score >= medium.score,
        caseMessage(
          seed,
          index,
          now,
          availability,
          tasks,
          `HIGH scored ${high.score} below MEDIUM ${medium.score}`,
        ),
      ).toBe(true);
    }
  });
});

describe("property: uniform capacity", () => {
  it("equals capacity times daysUntilDue when every weekday has the same minutes", () => {
    const seed = SEEDS.uniformCapacity;
    const rng = createRng(seed);

    for (let index = 0; index < CASES_PER_PROPERTY; index += 1) {
      const now = randomNow(rng);
      const capacity = rng.int(0, 480);
      const availability = uniformAvailability(capacity);
      const dueAt = new Date(now.getTime() + rng.int(0, 60 * MINUTES_PER_DAY) * MINUTE_MS);
      const remainingMinutes = rng.int(0, 1200);
      const task = freezeTask({
        id: "task",
        dueAt,
        importance: "MEDIUM",
        remainingMinutes,
        status: "TODO",
      });

      const entry = single(
        rankTasks([task], availability, now),
        caseMessage(seed, index, now, availability, [task], "uniform-capacity ranking"),
      );

      expect(
        entry.availableMinutes,
        caseMessage(
          seed,
          index,
          now,
          availability,
          [task],
          `${capacity} min/day over ${entry.daysUntilDue} days ` +
            `did not equal ${capacity * entry.daysUntilDue}`,
        ),
      ).toBe(capacity * entry.daysUntilDue);
    }
  });
});
