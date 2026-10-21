// Public surface of `packages/core`: pure domain types, the priority engine
// (P1-T1 to P1-T4) and the civil-day helpers it builds on. The planner lands in
// P5.

export { availableMinutes, civilDaysBetween } from "./availability.js";
export { DEFAULT_ENGINE_CONFIG, createEngineConfig } from "./config.js";
export type { EngineConfig, EngineConfigOverrides } from "./config.js";
export { calculatePressure, classifyTier } from "./pressure.js";
export type { PressureResult } from "./pressure.js";
export { rankTasks } from "./rank.js";
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
