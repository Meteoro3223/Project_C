import { DEFAULT_ENGINE_CONFIG } from "@proyecto-c/core";
import { describe, expect, it } from "vitest";
import { SHARED_PLACEHOLDER } from "./index.js";

describe("shared placeholder", () => {
  it("resolves @proyecto-c/core from source without a build step", () => {
    expect(DEFAULT_ENGINE_CONFIG.maxPressure).toBe(10);
    expect(SHARED_PLACEHOLDER).toBe("shared");
  });
});
