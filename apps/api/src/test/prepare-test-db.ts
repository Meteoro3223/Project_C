import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

// Resolve paths from this file so the script works from any current directory.
const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "../..");
const repoRoot = path.resolve(here, "../../../..");

function loadRootEnv(): void {
  try {
    process.loadEnvFile(path.join(repoRoot, ".env"));
  } catch {
    // CI and direct callers provide TEST_DATABASE_URL through the environment.
  }
}

function getTestDatabaseUrl(): string {
  const url = process.env["TEST_DATABASE_URL"];
  if (url === undefined || url.trim() === "") {
    throw new Error(
      "TEST_DATABASE_URL is missing. Add it to the root `.env` (see `.env.example`) or export it before running this script.",
    );
  }
  return url;
}

function getDatabaseName(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  // Only plain identifiers are supported by the local/CI setup; quoting a
  // validated identifier keeps the unparameterisable CREATE DATABASE safe.
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Unsupported test database name: "${name}".`);
  }
  return name;
}

function toMaintenanceUrl(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = "/postgres";
  return parsed.toString();
}

async function createDatabaseIfMissing(databaseUrl: string): Promise<void> {
  const databaseName = getDatabaseName(databaseUrl);
  const admin = new PrismaClient({ datasourceUrl: toMaintenanceUrl(databaseUrl) });

  try {
    const rows = await admin.$queryRaw<{ found: number }[]>`
      SELECT 1 AS found FROM pg_database WHERE datname = ${databaseName}
    `;

    if (rows.length === 0) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
      console.warn(`Created test database "${databaseName}".`);
    }
  } finally {
    await admin.$disconnect();
  }
}

function applyMigrations(databaseUrl: string): void {
  const prismaCli = path.join(apiRoot, "node_modules/prisma/build/index.js");
  const schemaPath = path.join(apiRoot, "prisma/schema.prisma");

  execFileSync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", schemaPath], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
}

async function main(): Promise<void> {
  loadRootEnv();
  const testDatabaseUrl = getTestDatabaseUrl();

  await createDatabaseIfMissing(testDatabaseUrl);
  applyMigrations(testDatabaseUrl);

  console.warn("Test database is ready.");
}

await main();
