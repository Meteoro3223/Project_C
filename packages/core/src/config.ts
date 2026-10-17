import type { Importance } from "./types.js";

/**
 * Aggregated tunables for the priority engine (PLAN section 6). Grouping the
 * thresholds, importance weights and `maxPressure` lets callers adjust the
 * engine without touching its formula.
 */
export interface EngineConfig {
  /** Pressure >= this value is classified as `CRITICAL`. */
  readonly criticalThreshold: number;
  /** Pressure >= this value (and below `criticalThreshold`) is `AT_RISK`. */
  readonly atRiskThreshold: number;
  /** Multiplier applied to pressure per importance level. */
  readonly importanceWeights: Readonly<Record<Importance, number>>;
  /** Upper bound applied to pressure so the result stays serializable. */
  readonly maxPressure: number;
}

/** Partial overrides accepted by {@link createEngineConfig}. */
export interface EngineConfigOverrides {
  readonly criticalThreshold?: number;
  readonly atRiskThreshold?: number;
  readonly importanceWeights?: Partial<Record<Importance, number>>;
  readonly maxPressure?: number;
}

const DEFAULT_IMPORTANCE_WEIGHTS: Readonly<Record<Importance, number>> = Object.freeze({
  LOW: 1,
  MEDIUM: 1.5,
  HIGH: 2,
});

/** Frozen engine defaults: critical >= 1, at risk >= 0.5, maxPressure 10. */
export const DEFAULT_ENGINE_CONFIG: EngineConfig = Object.freeze({
  criticalThreshold: 1,
  atRiskThreshold: 0.5,
  importanceWeights: DEFAULT_IMPORTANCE_WEIGHTS,
  maxPressure: 10,
});

/**
 * Builds a validated {@link EngineConfig} from partial overrides, falling back
 * to {@link DEFAULT_ENGINE_CONFIG} for anything omitted. The input is never
 * mutated and the returned config (including its weights) is deeply frozen.
 *
 * Throws a `RangeError` whose message names the offending field and the value
 * it received when an override is out of range.
 */
export function createEngineConfig(overrides: EngineConfigOverrides = {}): EngineConfig {
  const criticalThreshold = overrides.criticalThreshold ?? DEFAULT_ENGINE_CONFIG.criticalThreshold;
  const atRiskThreshold = overrides.atRiskThreshold ?? DEFAULT_ENGINE_CONFIG.atRiskThreshold;
  const maxPressure = overrides.maxPressure ?? DEFAULT_ENGINE_CONFIG.maxPressure;

  assertPositiveFinite("criticalThreshold", criticalThreshold);
  assertPositiveFinite("atRiskThreshold", atRiskThreshold);
  assertPositiveFinite("maxPressure", maxPressure);

  if (atRiskThreshold >= criticalThreshold) {
    throw new RangeError(
      `atRiskThreshold must be < criticalThreshold (got ${atRiskThreshold} and ${criticalThreshold})`,
    );
  }

  if (maxPressure < criticalThreshold) {
    throw new RangeError(
      `maxPressure must be >= criticalThreshold (got ${maxPressure} and ${criticalThreshold})`,
    );
  }

  const importanceWeights: Record<Importance, number> = {
    LOW: overrides.importanceWeights?.LOW ?? DEFAULT_ENGINE_CONFIG.importanceWeights.LOW,
    MEDIUM: overrides.importanceWeights?.MEDIUM ?? DEFAULT_ENGINE_CONFIG.importanceWeights.MEDIUM,
    HIGH: overrides.importanceWeights?.HIGH ?? DEFAULT_ENGINE_CONFIG.importanceWeights.HIGH,
  };

  assertPositiveFinite("importanceWeights.LOW", importanceWeights.LOW);
  assertPositiveFinite("importanceWeights.MEDIUM", importanceWeights.MEDIUM);
  assertPositiveFinite("importanceWeights.HIGH", importanceWeights.HIGH);

  if (importanceWeights.LOW > importanceWeights.MEDIUM || importanceWeights.MEDIUM > importanceWeights.HIGH) {
    throw new RangeError(
      "importanceWeights must satisfy LOW <= MEDIUM <= HIGH " +
        `(got LOW=${importanceWeights.LOW}, MEDIUM=${importanceWeights.MEDIUM}, HIGH=${importanceWeights.HIGH})`,
    );
  }

  return Object.freeze({
    criticalThreshold,
    atRiskThreshold,
    importanceWeights: Object.freeze(importanceWeights),
    maxPressure,
  });
}

/** Throws a `RangeError` unless `value` is a finite number strictly above zero. */
function assertPositiveFinite(field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} must be a finite number > 0 (got ${value})`);
  }
}
