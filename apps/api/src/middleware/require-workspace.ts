import type { Request, RequestHandler, Response } from "express";
import { SESSION_COOKIE_NAME } from "../config/session.js";
import { UnauthorizedError } from "../errors.js";
import { asyncHandler } from "../lib/async-handler.js";
import { readCookie, setSessionCookie } from "../lib/cookies.js";
import type { WorkspaceSessionService } from "../services/workspace-session.service.js";

// Declaration merging so `req.workspaceId` is typed without `any`. It is set
// only by `requireWorkspace` and never read from client input.
declare global {
  // Express's `Request` lives in this global namespace; augmenting the
  // `express` module cannot preserve its generic parameters.
  // eslint-disable-next-line @typescript-eslint/no-namespace -- canonical Express augmentation.
  namespace Express {
    interface Request {
      workspaceId?: string;
    }
  }
}

export interface RequireWorkspaceOptions {
  service: WorkspaceSessionService;
  secureCookies: boolean;
  clock: () => Date;
}

// Reads only the `sid` cookie. It never creates a workspace: no cookie,
// malformed value or unknown secret is a 401 through the central handler.
export function createRequireWorkspace(options: RequireWorkspaceOptions): RequestHandler {
  return asyncHandler(async (req: Request, res: Response, next): Promise<void> => {
    const secret = readCookie(req, SESSION_COOKIE_NAME);
    if (secret === undefined) {
      throw new UnauthorizedError();
    }

    const resolved = await options.service.resolveWorkspace(secret, options.clock());
    if (resolved === null) {
      throw new UnauthorizedError();
    }

    req.workspaceId = resolved.workspace.id;

    // Sliding expiration for any authenticated request, not just the session
    // endpoint.
    if (resolved.touched) {
      setSessionCookie(res, secret, { secure: options.secureCookies });
    }

    next();
  });
}

// Controllers use this instead of `req.workspaceId!`, so a missing middleware
// is a programming error rather than a silently empty filter.
export function getWorkspaceId(req: Request): string {
  const workspaceId = req.workspaceId;
  if (workspaceId === undefined) {
    throw new Error("getWorkspaceId() called without requireWorkspace middleware");
  }
  return workspaceId;
}
