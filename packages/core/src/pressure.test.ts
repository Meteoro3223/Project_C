import { describe, expect, it } from "vitest";
import { createEngineConfig } from "./config.js";
import type { EngineConfig } from "./config.js";
import { calculatePressure, classifyTier } from "./pressure.js";
import type { Tier } from "./types.js";

/** Critical from 2 upwards, at risk from 1 upwards. */
const HIGH_THRESHOLDS_CONFIG = createEngineConfig({ criticalThreshold: 2, atRiskThreshold: 1 });

/** Critical from 0.5 upwards, at risk from 0.25 upwards. */
const LOW_THRESHOLDS_CONFIG = createEngineConfig({ criticalThreshold: 0.5, atRiskThreshold: 0.25 });

interface PressureCase {
  readonly name: string;
  readonly remainingMinutes: number;
  readonly availableMinutes: number;
  readonly expectedPressure: number;
  readonly expectedInfeasible: boolean;
  readonly config?: EngineConfig;
}

const PRESSURE_CASES: readonly PressureCase[] = [
  {
    // S1-A: 180 min/day, Monday to Wednesday's exclusive deadline = 360 min.
    name: "S1-A: 240 remaining of 360 available -> 2/3",
    remainingMinutes: 240,
    availableMinutes: 360,
    expectedPressure: 2 / 3,
    expectedInfeasible: false,
  },
  {
    // S1-B: 180 min/day, Monday to Saturday's exclusive deadline = 900 min.
    name: "S1-B: 180 remaining of 900 available -> 1/5",
    remainingMinutes: 180,
    availableMinutes: 900,
    expectedPressure: 1 / 5,
    expectedInfeasible: false,
  },
  {
    // S1-C: 180 min/day over 10 days = 1800 min.
    name: "S1-C: 360 remaining of 1800 available -> 1/5",
    remainingMinutes: 360,
    availableMinutes: 1800,
    expectedPressure: 1 / 5,
    expectedInfeasible: false,
  },
  {
    name: "returns 0 when nothing remains, even with no availability",
    remainingMinutes: 0,
    availableMinutes: 0,
    expectedPressure: 0,
    expectedInfeasible: false,
  },
  {
    name: "returns 0 when nothing remains and time is available",
    remainingMinutes: 0,
    availableMinutes: 360,
    expectedPressure: 0,
    expectedInfeasible: false,
  },
  {
    name: "returns maxPressure and marks infeasible when no time is available",
    remainingMinutes: 60,
    availableMinutes: 0,
    expectedPressure: 10,
    expectedInfeasible: true,
  },
  {
    name: "caps a pressure above maxPressure but stays feasible",
    remainingMinutes: 3000,
    availableMinutes: 180,
    expectedPressure: 10,
    expectedInfeasible: false,
  },
  {
    name: "keeps a pressure exactly at maxPressure",
    remainingMinutes: 1800,
    availableMinutes: 180,
    expectedPressure: 10,
    expectedInfeasible: false,
  },
  {
    name: "keeps a pressure of exactly 1 (deadline exactly covered)",
    remainingMinutes: 240,
    availableMinutes: 240,
    expectedPressure: 1,
    expectedInfeasible: false,
  },
  {
    name: "keeps a pressure of exactly 0.5 (twice the available time)",
    remainingMinutes: 180,
    availableMinutes: 360,
    expectedPressure: 0.5,
    expectedInfeasible: false,
  },
  {
    name: "returns a fractional pressure below the thresholds",
    remainingMinutes: 1,
    availableMinutes: 3,
    expectedPressure: 1 / 3,
    expectedInfeasible: false,
  },
  {
    name: "uses a custom maxPressure for the cap",
    remainingMinutes: 100,
    availableMinutes: 10,
    expectedPressure: 3,
    expectedInfeasible: false,
    config: createEngineConfig({ maxPressure: 3 }),
  },
  {
    name: "uses a custom maxPressure when no time is available",
    remainingMinutes: 60,
    availableMinutes: 0,
    expectedPressure: 3,
    expectedInfeasible: true,
    config: createEngineConfig({ maxPressure: 3 }),
  },
];

const VALIDATION_CASES = [
  { argument: "remainingMinutes", remainingMinutes: -1, availableMinutes: 360 },
  { argument: "remainingMinutes", remainingMinutes: 1.5, availableMinutes: 360 },
  { argument: "remainingMinutes", remainingMinutes: Number.NaN, availableMinutes: 360 },
  {
    argument: "remainingMinutes",
    remainingMinutes: Number.POSITIVE_INFINITY,
    availableMinutes: 360,
  },
  { argument: "availableMinutes", remainingMinutes: 60, availableMinutes: -1 },
  { argument: "availableMinutes", remainingMinutes: 60, availableMinutes: 1.5 },
  { argument: "availableMinutes", remainingMinutes: 60, availableMinutes: Number.NaN },
  {
    argument: "availableMinutes",
    remainingMinutes: 60,
    availableMinutes: Number.NEGATIVE_INFINITY,
  },
];

interface TierCase {
  readonly name: string;
  readonly pressure: number;
  readonly overdue: boolean;
  readonly expected: Tier;
  readonly config?: EngineConfig;
}

const TIER_CASES: readonly TierCase[] = [
  { name: "no pressure is on track", pressure: 0, overdue: false, expected: "ON_TRACK" },
  { name: "0.2 is on track", pressure: 0.2, overdue: false, expected: "ON_TRACK" },
  { name: "just below 0.5 is on track", pressure: 0.499, overdue: false, expected: "ON_TRACK" },
  { name: "exactly 0.5 is at risk", pressure: 0.5, overdue: false, expected: "AT_RISK" },
  { name: "just above 0.5 is at risk", pressure: 0.5001, overdue: false, expected: "AT_RISK" },
  { name: "just below 1 is at risk", pressure: 0.999, overdue: false, expected: "AT_RISK" },
  { name: "exactly 1 is critical", pressure: 1, overdue: false, expected: "CRITICAL" },
  { name: "just above 1 is critical", pressure: 1.0001, overdue: false, expected: "CRITICAL" },
  { name: "maxPressure is critical", pressure: 10, overdue: false, expected: "CRITICAL" },
  { name: "overdue wins over no pressure", pressure: 0, overdue: true, expected: "OVERDUE" },
  {
    name: "overdue wins over at-risk pressure",
    pressure: 0.75,
    overdue: true,
    expected: "OVERDUE",
  },
  { name: "overdue wins over critical pressure", pressure: 1, overdue: true, expected: "OVERDUE" },
  { name: "overdue wins over maxPressure", pressure: 10, overdue: true, expected: "OVERDUE" },
  {
    name: "custom thresholds: just below 1 is on track",
    pressure: 0.999,
    overdue: false,
    expected: "ON_TRACK",
    config: HIGH_THRESHOLDS_CONFIG,
  },
  {
    name: "custom thresholds: exactly 1 is at risk",
    pressure: 1,
    overdue: false,
    expected: "AT_RISK",
    config: HIGH_THRESHOLDS_CONFIG,
  },
  {
    name: "custom thresholds: just below 2 is at risk",
    pressure: 1.999,
    overdue: false,
    expected: "AT_RISK",
    config: HIGH_THRESHOLDS_CONFIG,
  },
  {
    name: "custom thresholds: exactly 2 is critical",
    pressure: 2,
    overdue: false,
    expected: "CRITICAL",
    config: HIGH_THRESHOLDS_CONFIG,
  },
  {
    name: "custom thresholds: below 0.25 is on track",
    pressure: 0.249,
    overdue: false,
    expected: "ON_TRACK",
    config: LOW_THRESHOLDS_CONFIG,
  },
  {
    name: "custom thresholds: exactly 0.25 is at risk",
    pressure: 0.25,
    overdue: false,
    expected: "AT_RISK",
    config: LOW_THRESHOLDS_CONFIG,
  },
  {
    name: "custom thresholds: exactly 0.5 is critical",
    pressure: 0.5,
    overdue: false,
    expected: "CRITICAL",
    config: LOW_THRESHOLDS_CONFIG,
  },
];

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

describe("calculatePressure", () => {
  it.each(PRESSURE_CASES)(
    "$name",
    ({ remainingMinutes, availableMinutes, expectedPressure, expectedInfeasible, config }) => {
      const result =
        config === undefined
          ? calculatePressure(remainingMinutes, availableMinutes)
          : calculatePressure(remainingMinutes, availableMinutes, config);

      expect(result.pressure).toBeCloseTo(expectedPressure, 12);
      expect(result.infeasible).toBe(expectedInfeasible);
    },
  );

  it("is deterministic for identical inputs", () => {
    const first = calculatePressure(240, 360);
    const second = calculatePressure(240, 360);

    expect(first).toEqual(second);
  });
});

describe("calculatePressure validation", () => {
  it.each(VALIDATION_CASES)(
    "throws a RangeError naming $argument when it is invalid",
    ({ argument, remainingMinutes, availableMinutes }) => {
      const error = captureError(() => calculatePressure(remainingMinutes, availableMinutes));

      expect(error).toBeInstanceOf(RangeError);
      expect(error.message).toContain(argument);
    },
  );

  it("reports the received value and the expected shape", () => {
    const error = captureError(() => calculatePressure(1.5, 360));

    expect(error.message).toBe("remainingMinutes must be a non-negative integer (got 1.5)");
  });

  it("accepts zero for both arguments", () => {
    expect(calculatePressure(0, 0)).toEqual({ pressure: 0, infeasible: false });
  });
});

describe("classifyTier", () => {
  it.each(TIER_CASES)("$name", ({ pressure, overdue, expected, config }) => {
    const tier =
      config === undefined
        ? classifyTier(pressure, overdue)
        : classifyTier(pressure, overdue, config);

    expect(tier).toBe(expected);
  });
});

describe("pressure and tiers together (S1)", () => {
  const S1_TASKS = [
    {
      name: "A: 240 of 360 min",
      remainingMinutes: 240,
      availableMinutes: 360,
      expected: "AT_RISK",
    },
    {
      name: "B: 180 of 900 min",
      remainingMinutes: 180,
      availableMinutes: 900,
      expected: "ON_TRACK",
    },
    {
      name: "C: 360 of 1800 min",
      remainingMinutes: 360,
      availableMinutes: 1800,
      expected: "ON_TRACK",
    },
  ] as const satisfies readonly {
    readonly name: string;
    readonly remainingMinutes: number;
    readonly availableMinutes: number;
    readonly expected: Tier;
  }[];

  it.each(S1_TASKS)(
    "classifies $name as $expected",
    ({ remainingMinutes, availableMinutes, expected }) => {
      const { pressure } = calculatePressure(remainingMinutes, availableMinutes);

      expect(classifyTier(pressure, false)).toBe(expected);
    },
  );
});
