import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

// Load the repo-root `.env` for direct `vitest` runs. CI already exports the
// variables, and process.loadEnvFile never overrides existing values.
function loadRootEnv(): void {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    process.loadEnvFile(path.resolve(here, "../../../../.env"));
  } catch {
    // No `.env` in this checkout; the explicit error below explains the fix.
  }
}

function getTestDatabaseUrl(): string {
  const url = process.env["TEST_DATABASE_URL"];
  if (url === undefined || url.trim() === "") {
    throw new Error(
      "TEST_DATABASE_URL is missing. Run `pnpm db:test:prepare` or export it before running API integration tests.",
    );
  }
  return url;
}

loadRootEnv();

// Integration tests use their own client pointed at the test database, never
// the development database used by the API process.
export const testPrisma = new PrismaClient({ datasourceUrl: getTestDatabaseUrl() });

// Truncate every public table except Prisma's migration history. Dynamic table
// discovery keeps this correct as later phases add models.
export async function resetDatabase(): Promise<void> {
  const tables = await testPrisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    ORDER BY tablename
  `;

  if (tables.length === 0) {
    return;
  }

  const identifiers = tables
    .map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`)
    .join(", ");

  await testPrisma.$executeRawUnsafe(`TRUNCATE TABLE ${identifiers} RESTART IDENTITY CASCADE`);
}

export async function disconnectTestDatabase(): Promise<void> {
  await testPrisma.$disconnect();
}
