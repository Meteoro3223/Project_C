import type { PrismaClient } from "@prisma/client";

export interface WorkspaceRecord {
  id: string;
  tokenHash: string;
  timezone: string;
  createdAt: Date;
  lastSeenAt: Date;
}

const WORKSPACE_SELECT = {
  id: true,
  tokenHash: true,
  timezone: true,
  createdAt: true,
  lastSeenAt: true,
} as const;

// The workspace is the root of every ownership chain, so this is the only
// repository that is not always scoped by an authenticated `workspaceId`:
// `create` and `findByTokenHash` bootstrap the session itself. `touchLastSeen`
// still receives the id it updates, but it never reads another workspace's
// user data.
export class WorkspaceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(tokenHash: string, now: Date): Promise<WorkspaceRecord> {
    return this.prisma.workspace.create({
      // `now` is injected so session behaviour is deterministic in tests.
      data: { tokenHash, lastSeenAt: now },
      select: WORKSPACE_SELECT,
    });
  }

  async findByTokenHash(tokenHash: string): Promise<WorkspaceRecord | null> {
    return this.prisma.workspace.findUnique({
      where: { tokenHash },
      select: WORKSPACE_SELECT,
    });
  }

  // Single conditional write: the row is touched only when it is older than
  // `staleBefore`, so concurrent requests cannot both "win" the update.
  // Returns whether the touch actually happened.
  async touchLastSeen(workspaceId: string, now: Date, staleBefore: Date): Promise<boolean> {
    const { count } = await this.prisma.workspace.updateMany({
      where: { id: workspaceId, lastSeenAt: { lt: staleBefore } },
      data: { lastSeenAt: now },
    });

    return count > 0;
  }
}
