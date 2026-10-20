// Public surface of `packages/core`: pure domain types, the priority engine
// configuration (P1-T1), `availableMinutes` (P1-T2), and pressure and tiers
// (P1-T3). `rankTasks` and the planner land in P1-T4+.

export { availableMinutes } from "./availability.js";
export { DEFAULT_ENGINE_CONFIG, createEngineConfig } from "./config.js";
export type { EngineConfig, EngineConfigOverrides } from "./config.js";
export { calculatePressure, classifyTier } from "./pressure.js";
export type { PressureResult } from "./pressure.js";
export type {
  Importance,
  RankableTask,
  RankedTask,
  ReasonCode,
  TaskStatus,
  Tier,
  Weekday,
  WeeklyAvailability,
} from "./types.js";
