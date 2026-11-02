import { Router } from "express";
import { createWorkspaceSessionController } from "../controllers/workspace-session.controller.js";
import { asyncHandler } from "../lib/async-handler.js";
import type { WorkspaceSessionService } from "../services/workspace-session.service.js";

export interface WorkspaceSessionRouterOptions {
  service: WorkspaceSessionService;
  secureCookies: boolean;
  clock: () => Date;
}

export function createWorkspaceSessionRouter(options: WorkspaceSessionRouterOptions): Router {
  const router = Router();
  const controller = createWorkspaceSessionController(options);

  router.post("/session", asyncHandler(controller));

  return router;
}
