import { availableMinutes, civilDaysBetween } from "./availability.js";
import { DEFAULT_ENGINE_CONFIG } from "./config.js";
import type { EngineConfig } from "./config.js";
import { calculatePressure, classifyTier } from "./pressure.js";
import type { RankableTask, RankedTask, ReasonCode, Tier, WeeklyAvailability } from "./types.js";

/** Sort position of each tier: most urgent first (PLAN section 6, step 7). */
const TIER_ORDER: Readonly<Record<Tier, number>> = {
  OVERDUE: 0,
  CRITICAL: 1,
  AT_RISK: 2,
  ON_TRACK: 3,
};

/**
 * Scale used to round scores for sorting only. Mathematically equal scores can
 * differ in the last bits when computed from different pressure/weight pairs
 * (e.g. `0.2 * 1.5` vs `0.3 * 1`), so the comparator uses a rounded key and
 * lets `dueAt` and `id` break genuine ties. The reported `score` stays exact.
 */
const SCORE_SORT_PRECISION = 1e9;

/**
 * Internal row that keeps `dueAt` around for the deterministic tie-breaker and
 * a rounded score used only for comparison. `rank` is assigned once the whole
 * array is sorted.
 */
interface Candidate {
  readonly dueAt: Date;
  readonly sortScore: number;
  readonly ranked: Omit<RankedTask, "rank">;
}

/**
 * Ranks every pending task for the "Today" view (PLAN section 6).
 *
 * Steps, in order: exclude `DONE` tasks, compute each task's available minutes,
 * pressure, tier, importance weight, score, days until due and explanation
 * reasons, then sort by tier, score descending (compared after rounding to
 * absorb floating-point noise), `dueAt` ascending and `id` ascending (ordinal,
 * not locale-aware). `rank` is 1-based after sorting.
 *
 * Pure and deterministic: `now` is a parameter and neither the input array nor
 * its tasks are mutated. Throws a `RangeError` naming a duplicated task id, an
 * invalid date or an invalid timezone, even when there is nothing to rank.
 */
export function rankTasks(
  tasks: readonly RankableTask[],
  availability: WeeklyAvailability,
  now: Date,
  config: EngineConfig = DEFAULT_ENGINE_CONFIG,
): readonly RankedTask[] {
  // Validate the timezone and `now` up front, even if no task gets ranked.
  civilDaysBetween(availability.timezone, now, now);
  assertUniqueIds(tasks);

  const candidates: Candidate[] = [];
  for (const task of tasks) {
    if (task.status === "DONE") {
      continue;
    }
    candidates.push(scoreTask(task, availability, now, config));
  }

  candidates.sort(compareCandidates);

  return candidates.map(({ ranked }, index) => ({ ...ranked, rank: index + 1 }));
}

/** Computes every derived field of one task, leaving `rank` for after sorting. */
function scoreTask(
  task: RankableTask,
  availability: WeeklyAvailability,
  now: Date,
  config: EngineConfig,
): Candidate {
  const available = availableMinutes(availability, now, task.dueAt);
  const { pressure, noCapacity } = calculatePressure(task.remainingMinutes, available, config);
  // Instant comparison: a deadline later today is not overdue, just out of time.
  const overdue = task.dueAt.getTime() < now.getTime();
  const tier = classifyTier(pressure, overdue, config);
  const importanceWeight = config.importanceWeights[task.importance];
  const daysUntilDue = civilDaysBetween(availability.timezone, now, task.dueAt);
  const score = pressure * importanceWeight;

  return {
    dueAt: task.dueAt,
    sortScore: Math.round(score * SCORE_SORT_PRECISION) / SCORE_SORT_PRECISION,
    ranked: {
      taskId: task.id,
      tier,
      pressure,
      noCapacity,
      importanceWeight,
      score,
      remainingMinutes: task.remainingMinutes,
      availableMinutes: available,
      daysUntilDue,
      reasons: reasonsFor(task.importance, tier, noCapacity),
    },
  };
}

/**
 * Explanation codes that apply to a task, in the order the UI displays them
 * (PLAN section 6, `ReasonCode`). A task can carry several codes at once.
 */
function reasonsFor(
  importance: RankableTask["importance"],
  tier: Tier,
  noCapacity: boolean,
): readonly ReasonCode[] {
  const reasons: ReasonCode[] = [];

  if (tier === "OVERDUE") {
    reasons.push("OVERDUE");
  }
  if (noCapacity) {
    reasons.push("NO_TIME_LEFT");
  }
  if (!noCapacity && (tier === "AT_RISK" || tier === "CRITICAL")) {
    reasons.push("TIGHT_SCHEDULE");
  }
  if (importance === "HIGH") {
    reasons.push("HIGH_IMPORTANCE");
  }
  if (tier === "ON_TRACK") {
    reasons.push("COMFORTABLE");
  }

  return reasons;
}

/** Full ordering: tier, then rounded score desc, then `dueAt` asc, then id asc. */
function compareCandidates(a: Candidate, b: Candidate): number {
  const byTier = TIER_ORDER[a.ranked.tier] - TIER_ORDER[b.ranked.tier];
  if (byTier !== 0) {
    return byTier;
  }

  if (a.sortScore !== b.sortScore) {
    return b.sortScore - a.sortScore;
  }

  const byDueAt = a.dueAt.getTime() - b.dueAt.getTime();
  if (byDueAt !== 0) {
    return byDueAt;
  }

  if (a.ranked.taskId === b.ranked.taskId) {
    return 0;
  }
  // Ordinal (UTF-16 code unit) comparison, so results do not depend on locale.
  return a.ranked.taskId < b.ranked.taskId ? -1 : 1;
}

/**
 * Rejects duplicated task ids, including those of `DONE` tasks: a duplicate is
 * a caller bug regardless of the task's status. The error names the id.
 */
function assertUniqueIds(tasks: readonly RankableTask[]): void {
  const seen = new Set<string>();

  for (const task of tasks) {
    if (seen.has(task.id)) {
      throw new RangeError(`Duplicate task id: ${task.id}`);
    }
    seen.add(task.id);
  }
}
