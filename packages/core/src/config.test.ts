import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_CONFIG, createEngineConfig } from "./config.js";
import type { EngineConfigOverrides } from "./config.js";

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

describe("DEFAULT_ENGINE_CONFIG", () => {
  it("holds the documented thresholds, weights and maxPressure", () => {
    expect(DEFAULT_ENGINE_CONFIG.criticalThreshold).toBe(1);
    expect(DEFAULT_ENGINE_CONFIG.atRiskThreshold).toBe(0.5);
    expect(DEFAULT_ENGINE_CONFIG.importanceWeights).toEqual({ LOW: 1, MEDIUM: 1.5, HIGH: 2 });
    expect(DEFAULT_ENGINE_CONFIG.maxPressure).toBe(10);
  });

  it("is deeply frozen", () => {
    expect(Object.isFrozen(DEFAULT_ENGINE_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ENGINE_CONFIG.importanceWeights)).toBe(true);
  });

  it("passes the same validation as createEngineConfig", () => {
    expect(createEngineConfig(DEFAULT_ENGINE_CONFIG)).toEqual(DEFAULT_ENGINE_CONFIG);
  });
});

describe("createEngineConfig", () => {
  it("returns the defaults when called without overrides", () => {
    expect(createEngineConfig()).toEqual(DEFAULT_ENGINE_CONFIG);
  });

  it("applies full overrides", () => {
    const config = createEngineConfig({
      criticalThreshold: 2,
      atRiskThreshold: 1,
      maxPressure: 20,
      importanceWeights: { LOW: 1, MEDIUM: 2, HIGH: 3 },
    });

    expect(config).toEqual({
      criticalThreshold: 2,
      atRiskThreshold: 1,
      maxPressure: 20,
      importanceWeights: { LOW: 1, MEDIUM: 2, HIGH: 3 },
    });
  });

  it("merges partial overrides over the defaults", () => {
    const config = createEngineConfig({ maxPressure: 5 });

    expect(config.maxPressure).toBe(5);
    expect(config.criticalThreshold).toBe(DEFAULT_ENGINE_CONFIG.criticalThreshold);
    expect(config.atRiskThreshold).toBe(DEFAULT_ENGINE_CONFIG.atRiskThreshold);
    expect(config.importanceWeights).toEqual(DEFAULT_ENGINE_CONFIG.importanceWeights);
  });

  it("merges individual importance weights", () => {
    const config = createEngineConfig({ importanceWeights: { HIGH: 3 } });

    expect(config.importanceWeights).toEqual({ LOW: 1, MEDIUM: 1.5, HIGH: 3 });
  });

  it("returns a deeply frozen config", () => {
    const config = createEngineConfig({ maxPressure: 5 });

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.importanceWeights)).toBe(true);
  });

  it("does not mutate or alias its input", () => {
    const overrides = { maxPressure: 5, importanceWeights: { HIGH: 3 } };
    const config = createEngineConfig(overrides);

    expect(overrides).toEqual({ maxPressure: 5, importanceWeights: { HIGH: 3 } });
    expect(config.importanceWeights).not.toBe(overrides.importanceWeights);
    expect(config.importanceWeights).not.toBe(DEFAULT_ENGINE_CONFIG.importanceWeights);
  });
});

describe("createEngineConfig validation", () => {
  it("reports the thresholds and value in the message", () => {
    const error = captureError(() =>
      createEngineConfig({ atRiskThreshold: 1.2, criticalThreshold: 1 }),
    );

    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toBe("atRiskThreshold must be < criticalThreshold (got 1.2 and 1)");
  });

  it("rejects non-positive or non-finite values with a RangeError naming the field", () => {
    const cases: readonly { overrides: EngineConfigOverrides; field: string }[] = [
      { overrides: { criticalThreshold: 0 }, field: "criticalThreshold" },
      { overrides: { criticalThreshold: Number.NaN }, field: "criticalThreshold" },
      { overrides: { atRiskThreshold: 0 }, field: "atRiskThreshold" },
      { overrides: { atRiskThreshold: Number.POSITIVE_INFINITY }, field: "atRiskThreshold" },
      { overrides: { maxPressure: 0 }, field: "maxPressure" },
      { overrides: { maxPressure: Number.NEGATIVE_INFINITY }, field: "maxPressure" },
    ];

    for (const { overrides, field } of cases) {
      const error = captureError(() => createEngineConfig(overrides));
      expect(error).toBeInstanceOf(RangeError);
      expect(error.message).toContain(field);
    }
  });

  it("rejects atRiskThreshold >= criticalThreshold", () => {
    const error = captureError(() => createEngineConfig({ atRiskThreshold: 1, criticalThreshold: 1 }));

    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toContain("atRiskThreshold");
  });

  it("rejects maxPressure below criticalThreshold", () => {
    const error = captureError(() => createEngineConfig({ maxPressure: 0.5, criticalThreshold: 1 }));

    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toContain("maxPressure");
  });

  it("rejects non-positive or non-finite importance weights", () => {
    const cases: readonly { overrides: EngineConfigOverrides; field: string }[] = [
      { overrides: { importanceWeights: { LOW: 0 } }, field: "importanceWeights.LOW" },
      { overrides: { importanceWeights: { MEDIUM: Number.NaN } }, field: "importanceWeights.MEDIUM" },
      { overrides: { importanceWeights: { HIGH: Number.POSITIVE_INFINITY } }, field: "importanceWeights.HIGH" },
    ];

    for (const { overrides, field } of cases) {
      const error = captureError(() => createEngineConfig(overrides));
      expect(error).toBeInstanceOf(RangeError);
      expect(error.message).toContain(field);
    }
  });

  it("rejects importance weights that break LOW <= MEDIUM <= HIGH", () => {
    const error = captureError(() =>
      createEngineConfig({ importanceWeights: { MEDIUM: 2, HIGH: 1 } }),
    );

    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toContain("importanceWeights");
  });
});
