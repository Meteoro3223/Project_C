import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, loadEnv, parsePort } from "./env.js";

describe("parsePort", () => {
  it("falls back to the default when unset or blank", () => {
    expect(parsePort(undefined)).toBe(DEFAULT_PORT);
    expect(parsePort("")).toBe(DEFAULT_PORT);
    expect(parsePort("   ")).toBe(DEFAULT_PORT);
  });

  it("parses a valid port", () => {
    expect(parsePort("4010")).toBe(4010);
    expect(parsePort("3000")).toBe(3000);
  });

  it("falls back to the default for invalid ports", () => {
    expect(parsePort("abc")).toBe(DEFAULT_PORT);
    expect(parsePort("3.5")).toBe(DEFAULT_PORT);
    expect(parsePort("-1")).toBe(DEFAULT_PORT);
    expect(parsePort("0")).toBe(DEFAULT_PORT);
  });
});

describe("loadEnv", () => {
  const databaseUrl = "postgresql://proyecto_c:proyecto_c_dev@localhost:5432/proyecto_c_dev";

  it("returns the port and database URL", () => {
    expect(loadEnv({ DATABASE_URL: databaseUrl, PORT: "3000" })).toEqual({
      port: 3000,
      databaseUrl,
    });
  });

  it("defaults the port when PORT is missing", () => {
    expect(loadEnv({ DATABASE_URL: databaseUrl })).toEqual({
      port: DEFAULT_PORT,
      databaseUrl,
    });
  });

  it("throws a clear error when DATABASE_URL is missing", () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL is missing/);
  });

  it("throws when DATABASE_URL is blank", () => {
    expect(() => loadEnv({ DATABASE_URL: "   " })).toThrow(/DATABASE_URL is missing/);
  });
});
