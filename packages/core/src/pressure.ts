import { DEFAULT_ENGINE_CONFIG } from "./config.js";
import type { EngineConfig } from "./config.js";
import type { Tier } from "./types.js";

/**
 * Pressure and feasibility for a single task (PLAN section 6, step 3).
 *
 * `infeasible` is `true` only when no minutes are available and minutes remain;
 * a pressure that was merely capped at `maxPressure` is still feasible.
 */
export interface PressureResult {
  readonly pressure: number;
  readonly infeasible: boolean;
}

/**
 * Pressure of a task: `remainingMinutes / availableMinutes`, capped at
 * `config.maxPressure` so the value stays serializable.
 *
 * Rules, in order:
 * - no minutes remaining -> pressure 0, feasible (even with no availability);
 * - no availability and minutes remaining -> `maxPressure`, infeasible;
 * - otherwise the ratio, capped at `maxPressure`.
 *
 * Pure and deterministic. Throws a `RangeError` naming the argument when either
 * minute count is negative or not an integer.
 */
export function calculatePressure(
  remainingMinutes: number,
  availableMinutes: number,
  config: EngineConfig = DEFAULT_ENGINE_CONFIG,
): PressureResult {
  assertNonNegativeInteger("remainingMinutes", remainingMinutes);
  assertNonNegativeInteger("availableMinutes", availableMinutes);

  if (remainingMinutes === 0) {
    return { pressure: 0, infeasible: false };
  }

  if (availableMinutes === 0) {
    return { pressure: config.maxPressure, infeasible: true };
  }

  return {
    pressure: Math.min(remainingMinutes / availableMinutes, config.maxPressure),
    infeasible: false,
  };
}

/**
 * Priority tier of a task (PLAN section 6, step 4). `overdue` takes precedence
 * over the pressure thresholds; the caller derives it as `dueAt < now` so this
 * function stays free of dates and of the clock.
 *
 * Thresholds come from `config` (`criticalThreshold`, `atRiskThreshold`).
 */
export function classifyTier(
  pressure: number,
  overdue: boolean,
  config: EngineConfig = DEFAULT_ENGINE_CONFIG,
): Tier {
  if (overdue) {
    return "OVERDUE";
  }

  if (pressure >= config.criticalThreshold) {
    return "CRITICAL";
  }

  if (pressure >= config.atRiskThreshold) {
    return "AT_RISK";
  }

  return "ON_TRACK";
}

/** Throws a `RangeError` naming the argument unless `value` is an integer >= 0. */
function assertNonNegativeInteger(
  argument: "remainingMinutes" | "availableMinutes",
  value: number,
): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${argument} must be a non-negative integer (got ${value})`);
  }
}
