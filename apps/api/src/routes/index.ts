import { Router } from "express";
import { createRequireWorkspace } from "../middleware/require-workspace.js";
import { noStore } from "../middleware/no-store.js";
import { createHealthRouter } from "./health.js";
import type { HealthCheckOptions } from "./health.js";
import { createWorkspaceSessionRouter } from "./workspace-session.js";
import type { WorkspaceSessionRouterOptions } from "./workspace-session.js";

export interface ProtectedRoute {
  // Absolute path under /api/v1, for example "/courses".
  path: string;
  router: Router;
}

export interface ApiRouterOptions {
  health: HealthCheckOptions;
  workspaceSession: WorkspaceSessionRouterOptions;
  // Every future resource router is registered here and therefore protected
  // by default. Public routes above are the explicit exception.
  protectedRouters: readonly ProtectedRoute[];
}

export function createApiRouter(options: ApiRouterOptions): Router {
  const api = Router();

  // Applied to every response under /api/v1, including the 404 that falls
  // through to the app-level handler.
  api.use(noStore);

  // Public: health check and anonymous workspace bootstrap only.
  api.use("/health", createHealthRouter(options.health));
  api.use("/workspace", createWorkspaceSessionRouter(options.workspaceSession));

  const requireWorkspace = createRequireWorkspace({
    service: options.workspaceSession.service,
    secureCookies: options.workspaceSession.secureCookies,
    clock: options.workspaceSession.clock,
  });

  // Protected: each resource is mounted behind the session middleware.
  // `workspaceId` always comes from `requireWorkspace`, never from the client.
  for (const protectedRoute of options.protectedRouters) {
    api.use(protectedRoute.path, requireWorkspace, protectedRoute.router);
  }

  return api;
}
