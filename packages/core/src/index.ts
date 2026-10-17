// Public surface of `packages/core`: pure domain types, the priority engine
// configuration (P1-T1) and `availableMinutes` (P1-T2). The remaining engine and
// planner functions land in P1-T3+.

export { availableMinutes } from "./availability.js";
export { DEFAULT_ENGINE_CONFIG, createEngineConfig } from "./config.js";
export type { EngineConfig, EngineConfigOverrides } from "./config.js";
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
