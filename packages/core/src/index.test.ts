import { describe, expect, it } from "vitest";
import { CORE_PLACEHOLDER } from "./index.js";

describe("core placeholder", () => {
  it("exposes the P0-T6 placeholder value", () => {
    expect(CORE_PLACEHOLDER).toBe("core");
  });
});
