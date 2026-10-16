import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

describe("GET /api/v1/health", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {
      // Silenced in tests; the logging behavior itself is asserted below.
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 when the database is reachable", async () => {
    const app = createApp({
      checkDatabase: (): Promise<void> => Promise.resolve(),
    });

    const res = await request(app).get("/api/v1/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: "up" });
  });

  it("returns 503 when the database is unreachable", async () => {
    const app = createApp({
      checkDatabase: async () => {
        throw new Error("db down");
      },
    });

    const res = await request(app).get("/api/v1/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "degraded", db: "down" });
  });

  it("logs the probe error server-side without changing the response", async () => {
    const app = createApp({
      checkDatabase: async () => {
        throw new Error("db down");
      },
    });

    const res = await request(app).get("/api/v1/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "degraded", db: "down" });
    expect(console.error).toHaveBeenCalledWith(
      "Health check database probe failed:",
      "db down",
    );
  });

  it("returns the shared error shape for unknown routes", async () => {
    const app = createApp({
      checkDatabase: (): Promise<void> => Promise.resolve(),
    });

    const res = await request(app).get("/api/v1/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });
  });
});
