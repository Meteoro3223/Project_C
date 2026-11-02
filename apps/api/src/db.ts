import { PrismaClient } from "@prisma/client";

// Single shared client. Cached on globalThis so `tsx watch` reloads
// in development do not exhaust database connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env["NODE_ENV"] !== "production") {
  globalForPrisma.prisma = prisma;
}

// Minimal probe used by `GET /api/v1/health`. Workspace-scoped data access
// lives in `src/repositories/`, which all require an explicit `workspaceId`.
export async function checkDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}
