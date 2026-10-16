import { Router } from "express";
import type { Request, Response } from "express";

export interface HealthCheckOptions {
  checkDatabase: () => Promise<void>;
}

export function createHealthRouter(options: HealthCheckOptions): Router {
  const router = Router();

  router.get("/", async (_req: Request, res: Response) => {
    try {
      await options.checkDatabase();
      res.status(200).json({ status: "ok", db: "up" });
    } catch (err) {
      // Log server-side only, without credentials: just the message, never
      // connection strings or env vars. The HTTP response stays unchanged.
      console.error(
        "Health check database probe failed:",
        err instanceof Error ? err.message : err,
      );
      res.status(503).json({ status: "degraded", db: "down" });
    }
  });

  return router;
}
