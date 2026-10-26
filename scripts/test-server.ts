import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import process from "node:process";

import { Pool } from "pg";

import { runMigrations } from "./migrate.ts";
import { assertTestDatabaseTargets, loadTestEnvironment } from "./test-db-guard.ts";

const TEST_ORIGIN = "http://127.0.0.1:3100";
const MOCK_PROVIDER_ORIGIN = "http://127.0.0.1:4010";
const MOCK_PROVIDER_PORT = 4010;
const MOCK_ELEVENLABS_API_KEY = "test-only-elevenlabs";

function startMockProviderServer(): Promise<Server> {
  let tokenCounter = 0;
  const server = createServer((request, response) => {
    request.resume();
    const pathname = new URL(
      request.url ?? "/",
      "http://127.0.0.1",
    ).pathname;

    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");

    if (
      request.method !== "POST" ||
      pathname !== "/v1/single-use-token/realtime_scribe"
    ) {
      response.writeHead(404);
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    if (request.headers["xi-api-key"] !== MOCK_ELEVENLABS_API_KEY) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    tokenCounter += 1;
    response.writeHead(200);
    response.end(JSON.stringify({ token: `sutkn_mock_${tokenCounter}` }));
  });

  return new Promise<Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(MOCK_PROVIDER_PORT, "127.0.0.1", () => {
      server.off("error", reject);
      server.on("error", (error) => {
        console.error(
          `Mock ElevenLabs se nepodařilo provozovat: ${error.message}`,
        );
        process.exit(1);
      });
      resolve(server);
    });
  });
}

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

  const mockProvider = await startMockProviderServer();
  console.log(`Mock ElevenLabs poslouchá na ${MOCK_PROVIDER_ORIGIN}.`);

  const stopMockProvider = (exitCode: number): void => {
    mockProvider.close(() => process.exit(exitCode));
    mockProvider.closeAllConnections();
  };

  const child = spawn(
    process.execPath,
    [join(process.cwd(), "scripts", "next-server.ts"), "start"],
    {
      env: {
        ...process.env,
        NODE_ENV: "production",
        APP_ORIGIN: TEST_ORIGIN,
        APP_ALLOW_FORWARDED_LOOPBACK: "0",
        AI_TEST_MODE: "1",
        ELEVENLABS_API_KEY: MOCK_ELEVENLABS_API_KEY,
        ELEVENLABS_API_BASE_URL: MOCK_PROVIDER_ORIGIN,
        OPENROUTER_API_KEY: "test-only-openrouter",
        OPENAI_API_KEY: "test-only-openai",
        GEMINI_API_KEY: "test-only-gemini",
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
    stopMockProvider(1);
  });

  child.on("exit", (code) => {
    stopMockProvider(code ?? 1);
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
