import type { Request, Response } from "express";
import { SESSION_COOKIE_NAME } from "../config/session.js";
import { readCookie, setSessionCookie } from "../lib/cookies.js";
import type { WorkspaceSessionService } from "../services/workspace-session.service.js";

export interface WorkspaceSessionControllerOptions {
  service: WorkspaceSessionService;
  secureCookies: boolean;
  clock: () => Date;
}

export function createWorkspaceSessionController(
  options: WorkspaceSessionControllerOptions,
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    const now = options.clock();
    const presented = readCookie(req, SESSION_COOKIE_NAME);

    if (presented !== undefined) {
      const resolved = await options.service.resolveWorkspace(presented, now);
      if (resolved !== null) {
        // Sliding expiration: re-issue the same secret only when the stored
        // `lastSeenAt` was actually touched.
        if (resolved.touched) {
          setSessionCookie(res, presented, { secure: options.secureCookies });
        }
        res.status(200).json({ workspace: { timezone: resolved.workspace.timezone } });
        return;
      }
    }

    // No cookie, a malformed cookie or an unknown secret: this endpoint
    // creates a fresh workspace. It never resumes an unrelated one.
    const created = await options.service.createWorkspaceSession(now);
    setSessionCookie(res, created.secret, { secure: options.secureCookies });
    res.status(200).json({ workspace: { timezone: created.workspace.timezone } });
  };
}
