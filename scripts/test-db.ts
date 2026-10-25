import { spawn } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

import { runMigrations } from "./migrate.ts";
import { assertTestDatabaseTargets, loadTestEnvironment } from "./test-db-guard.ts";

async function main(): Promise<void> {
  loadTestEnvironment();
  const targets = assertTestDatabaseTargets();

  await runMigrations(targets.testUrl);
  console.log("Testovací databáze je migrovaná.");

  const vitestBinary = join(process.cwd(), "node_modules", ".bin", "vitest");
  const child = spawn(vitestBinary, ["run", "tests/db"], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: targets.devUrl,
      TEST_DATABASE_URL: targets.testUrl,
    },
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error(`Nepodařilo se spustit testy databáze: ${error.message}`);
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Testy databáze se nepodařilo spustit.",
  );
  process.exit(1);
});
