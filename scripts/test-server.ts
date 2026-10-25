import { spawn } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

import { Pool } from "pg";

import { runMigrations } from "./migrate.ts";
import { assertTestDatabaseTargets, loadTestEnvironment } from "./test-db-guard.ts";

const TEST_ORIGIN = "http://127.0.0.1:3100";

async function main(): Promise<void> {
  loadTestEnvironment();
  const targets = assertTestDatabaseTargets();

  await runMigrations(targets.testUrl);

  const pool = new Pool({
    connectionString: targets.testUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
  });

  try {
    await pool.query("TRUNCATE TABLE notes CASCADE");
    await pool.query("TRUNCATE TABLE ai_usage");
  } finally {
    await pool.end().catch(() => undefined);
  }

  console.log("Testovací databáze je připravená.");

  const child = spawn(
    process.execPath,
    [join(process.cwd(), "scripts", "next-server.ts"), "start"],
    {
      env: {
        ...process.env,
        NODE_ENV: "production",
        APP_ORIGIN: TEST_ORIGIN,
        DATABASE_URL: targets.testUrl,
        TEST_DATABASE_URL: targets.testUrl,
      },
      stdio: "inherit",
    },
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }

  child.on("error", (error) => {
    console.error(`Testovací server se nepodařilo spustit: ${error.message}`);
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Testovací server se nepodařilo spustit.",
  );
  process.exit(1);
});
