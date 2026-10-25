import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import nextEnv from "@next/env";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { assertTestDatabaseTargets, loadTestEnvironment } from "./test-db-guard.ts";

const { loadEnvConfig } = nextEnv;

export async function runMigrations(
  databaseUrl: string,
  migrationsFolder: string = join(process.cwd(), "drizzle"),
): Promise<void> {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
  });

  try {
    const database = drizzle(pool);
    await migrate(database, { migrationsFolder });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--test-db")) {
    loadTestEnvironment();
    const targets = assertTestDatabaseTargets();
    await runMigrations(targets.testUrl);
    console.log("Testovací databáze je migrovaná.");
    return;
  }

  loadEnvConfig(process.cwd(), true);
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL není nastavená. Doplňte ji do .env.local před migrací vývojové databáze.",
    );
  }

  console.warn(
    "Migruji vývojovou databázi. Spouštějte pouze po schválení a se zálohou, pokud obsahuje data.",
  );
  await runMigrations(databaseUrl);
  console.log("Vývojová databáze je migrovaná.");
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Migrace selhala.");
    process.exit(1);
  });
}
