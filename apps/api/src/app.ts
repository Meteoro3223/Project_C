import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { checkDatabase as defaultCheckDatabase, prisma as defaultPrisma } from "./db.js";
import {
  ApiError,
  apiErrorBody,
  getBodyParserErrorType,
  InvalidJsonError,
  PayloadTooLargeError,
} from "./errors.js";
import { CACHE_CONTROL_HEADER, NO_STORE_CACHE_CONTROL } from "./middleware/no-store.js";
import { WorkspaceRepository } from "./repositories/workspace.repository.js";
import { createApiRouter } from "./routes/index.js";
import type { ProtectedRoute } from "./routes/index.js";
import { WorkspaceSessionService } from "./services/workspace-session.service.js";

export interface CreateAppOptions {
  // Injectable so the smoke test covers the up/down paths without
  // needing a live Postgres. Defaults to a real `SELECT 1` probe.
  checkDatabase?: () => Promise<void>;
  // Tests inject the test-database client; production uses the shared client.
  prisma?: PrismaClient;
  // Injected from the composition root (`server.ts`), never read from
  // `process.env` inside the middleware. Tests can cover both cookie modes.
  secureCookies?: boolean;
  // Injected clock so session tests never sleep.
  clock?: () => Date;
  // Test seam for a probe route. Production resources are added here too.
  protectedRouters?: readonly ProtectedRoute[];
}

// Translates body-parser failures into typed API errors. Any other error is
// unexpected and stays opaque to the client.
function toApiError(error: unknown): ApiError | null {
  if (error instanceof ApiError) {
    return error;
  }

  const parserType = getBodyParserErrorType(error);
  if (parserType === "entity.parse.failed") {
    return new InvalidJsonError();
  }
  if (parserType === "entity.too.large") {
    return new PayloadTooLargeError();
  }

  return null;
}

// Application factory (no `listen()` here) so Supertest can use it.
export function createApp(options: CreateAppOptions = {}): Express {
  const check = options.checkDatabase ?? defaultCheckDatabase;
  const prisma = options.prisma ?? defaultPrisma;
  const secureCookies = options.secureCookies ?? false;
  const clock = options.clock ?? ((): Date => new Date());

  const app = express();

  app.disable("x-powered-by");
  // Matches the demo body-size limit in PLAN.md; P3-T2 makes it configurable.
  app.use(express.json({ limit: "100kb" }));

  const workspaceSession = new WorkspaceSessionService(new WorkspaceRepository(prisma));

  app.use(
    "/api/v1",
    createApiRouter({
      health: { checkDatabase: check },
      workspaceSession: { service: workspaceSession, secureCookies, clock },
      protectedRouters: options.protectedRouters ?? [],
    }),
  );

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found" } });
  });

  // Central error handler. Typed errors keep their status/code; anything else
  // is logged server-side and returned as an opaque 500.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    // `express.json` runs before the API router, so its failures never reach
    // the router-level Cache-Control middleware. Cover them here.
    if (req.originalUrl.startsWith("/api/v1")) {
      res.setHeader(CACHE_CONTROL_HEADER, NO_STORE_CACHE_CONTROL);
    }

    const apiError = toApiError(err);
    if (apiError !== null) {
      res.status(apiError.statusCode).json(apiErrorBody(apiError));
      return;
    }

    // Never log the parser's message or request body: only opaque failures
    // reach this branch, and only their message is logged.
    console.error("Unhandled API error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  });

  return app;
}
