import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { checkDatabase as defaultCheckDatabase } from "./db.js";
import { createHealthRouter } from "./routes/health.js";

export interface CreateAppOptions {
  // Injectable so the smoke test covers the up/down paths without
  // needing a live Postgres. Defaults to a real `SELECT 1` probe.
  checkDatabase?: () => Promise<void>;
}

// Application factory (no `listen()` here) so Supertest can use it.
// Full layers (controllers/services/repositories) arrive in P2.
export function createApp(options: CreateAppOptions = {}): Express {
  const check = options.checkDatabase ?? defaultCheckDatabase;
  const app = express();

  app.disable("x-powered-by");
  // Matches the demo body-size limit in PLAN.md; P3-T2 makes it configurable.
  app.use(express.json({ limit: "100kb" }));

  app.use("/api/v1/health", createHealthRouter({ checkDatabase: check }));

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found" } });
  });

  // Central error handler. Typed error classes arrive with the P2 endpoints.
  app.use((_err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  });

  return app;
}
