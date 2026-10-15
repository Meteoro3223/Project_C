import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("GET /api/v1/health", () => {
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

  it("returns the shared error shape for unknown routes", async () => {
    const app = createApp({
      checkDatabase: (): Promise<void> => Promise.resolve(),
    });

    const res = await request(app).get("/api/v1/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });
  });
});
