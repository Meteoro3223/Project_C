import { CORE_PLACEHOLDER } from "@proyecto-c/core";
import { describe, expect, it } from "vitest";
import { SHARED_PLACEHOLDER } from "./index.js";

describe("shared placeholder", () => {
  it("resolves @proyecto-c/core from source without a build step", () => {
    expect(SHARED_PLACEHOLDER).toBe(CORE_PLACEHOLDER);
  });
});
