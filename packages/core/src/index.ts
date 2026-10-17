// Public surface of `packages/core`: pure domain types and the priority engine
// configuration (P1-T1). The engine and planner functions land in P1-T2+.

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
