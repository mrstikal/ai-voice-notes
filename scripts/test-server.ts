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
const MOCK_MAX_REQUEST_BYTES = 26 * 1024 * 1024;
const MOCK_BATCH_TRANSCRIPT = {
  language_code: "cs",
  language_probability: 0.99,
  text: "Dobrý den, týme. Schůzka začíná v devět.",
  audio_duration_secs: 2,
  words: [
    { text: "Dobrý", type: "word", speaker_id: "speaker_0", start: 0, end: 0.3, logprob: -0.1 },
    { text: " ", type: "spacing", logprob: -0.1 },
    { text: "den,", type: "word", speaker_id: "speaker_0", start: 0.3, end: 0.6, logprob: -0.1 },
    { text: " ", type: "spacing", logprob: -0.1 },
    { text: "týme.", type: "word", speaker_id: "speaker_0", start: 0.6, end: 0.9, logprob: -0.1 },
    { text: " ", type: "spacing", logprob: -0.1 },
    { text: "Schůzka", type: "word", speaker_id: "speaker_1", start: 0.9, end: 1.2, logprob: -0.1 },
    { text: " ", type: "spacing", logprob: -0.1 },
    { text: "začíná", type: "word", speaker_id: "speaker_1", start: 1.2, end: 1.5, logprob: -0.1 },
    { text: " ", type: "spacing", logprob: -0.1 },
    { text: "v", type: "word", speaker_id: "speaker_1", start: 1.5, end: 1.6, logprob: -0.1 },
    { text: " ", type: "spacing", logprob: -0.1 },
    { text: "devět.", type: "word", speaker_id: "speaker_1", start: 1.6, end: 2, logprob: -0.1 },
  ],
} as const;

interface MockUpload {
  readonly ok: boolean;
  readonly reason: string;
}

function validateMockUpload(
  contentType: string,
  body: Buffer,
): MockUpload {
  if (!contentType.startsWith("multipart/form-data")) {
    return { ok: false, reason: "invalid_content_type" };
  }

  if (body.byteLength < 1_000) {
    return { ok: false, reason: "empty_audio" };
  }

  const header = body.subarray(0, 4_096).toString("latin1");

  if (
    !/name="file"; filename="meeting-upload\.(?:wav|mp3|webm)"/u.test(header)
  ) {
    return { ok: false, reason: "missing_file_part" };
  }

  return { ok: true, reason: "ok" };
}

function startMockProviderServer(): Promise<Server> {
  let tokenCounter = 0;
  const server = createServer((request, response) => {
    const pathname = new URL(
      request.url ?? "/",
      "http://127.0.0.1",
    ).pathname;

    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");

    const isTokenPath =
      pathname === "/v1/single-use-token/realtime_scribe";
    const isTranscribePath = pathname === "/v1/speech-to-text";

    if (
      request.method !== "POST" ||
      (!isTokenPath && !isTranscribePath)
    ) {
      request.resume();
      response.writeHead(404);
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    if (request.headers["xi-api-key"] !== MOCK_ELEVENLABS_API_KEY) {
      request.resume();
      response.writeHead(401);
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (isTranscribePath) {
      const chunks: Buffer[] = [];
      let total = 0;
      let tooLarge = false;

      request.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;

        if (total > MOCK_MAX_REQUEST_BYTES) {
          tooLarge = true;
          return;
        }

        chunks.push(chunk);
      });

      request.on("end", () => {
        if (tooLarge) {
          response.writeHead(413);
          response.end(JSON.stringify({ error: "payload_too_large" }));
          return;
        }

        const upload = validateMockUpload(
          String(request.headers["content-type"] ?? ""),
          Buffer.concat(chunks),
        );

        if (!upload.ok) {
          response.writeHead(422);
          response.end(
            JSON.stringify({ error: `mock_upload_rejected:${upload.reason}` }),
          );
          return;
        }

        response.writeHead(200);
        response.end(JSON.stringify(MOCK_BATCH_TRANSCRIPT));
      });
      return;
    }

    request.resume();
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
    await pool.query("TRUNCATE TABLE meeting_saves");
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
