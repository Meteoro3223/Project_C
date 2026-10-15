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
    } catch {
      res.status(503).json({ status: "degraded", db: "down" });
    }
  });

  return router;
}
