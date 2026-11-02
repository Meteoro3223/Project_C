import { createHash, randomBytes } from "node:crypto";
import {
  isSessionSecret,
  LAST_SEEN_TOUCH_INTERVAL_MS,
  SESSION_SECRET_BYTES,
} from "../config/session.js";
import type { WorkspaceRecord, WorkspaceRepository } from "../repositories/workspace.repository.js";

export interface CreatedWorkspaceSession {
  workspace: WorkspaceRecord;
  secret: string;
}

export interface ResolvedWorkspaceSession {
  workspace: WorkspaceRecord;
  // True when `lastSeenAt` was actually written, so the caller knows whether
  // to re-issue the sliding cookie.
  touched: boolean;
}

// SHA-256 is enough because the secret has 256 bits of entropy. This is not a
// password, so bcrypt/argon2 would only add cost without adding security.
function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export class WorkspaceSessionService {
  constructor(private readonly workspaces: WorkspaceRepository) {}

  async createWorkspaceSession(now: Date): Promise<CreatedWorkspaceSession> {
    const secret = randomBytes(SESSION_SECRET_BYTES).toString("base64url");
    const workspace = await this.workspaces.create(hashSecret(secret), now);

    // The raw secret is returned once, to be sent in the cookie. It is never
    // stored or logged.
    return { workspace, secret };
  }

  async resolveWorkspace(secret: string, now: Date): Promise<ResolvedWorkspaceSession | null> {
    if (!isSessionSecret(secret)) {
      return null;
    }

    const workspace = await this.workspaces.findByTokenHash(hashSecret(secret));
    if (workspace === null) {
      return null;
    }

    const staleBefore = new Date(now.getTime() - LAST_SEEN_TOUCH_INTERVAL_MS);
    const touched = await this.workspaces.touchLastSeen(workspace.id, now, staleBefore);

    return touched
      ? { workspace: { ...workspace, lastSeenAt: now }, touched: true }
      : { workspace, touched: false };
  }
}
