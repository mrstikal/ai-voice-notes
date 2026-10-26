import { Client } from "pg";

import { reconcileInterruptedReservations } from "./usage.ts";
import { loadConfig, type AppConfig } from "../config.ts";
import { createDatabase } from "../db/client.ts";

const SERVER_LOCK_KEY = 7001001;
const PRODUCTION_BUILD_PHASE = "phase-production-build";

type LockGlobal = typeof globalThis & {
  __aiVoiceNotesServerLock?: { readonly client: Client };
};

const lockGlobal = globalThis as LockGlobal;

function runtimeDatabaseUrl(config: AppConfig): string | undefined {
  if (process.env.NODE_ENV === "test") {
    return config.testDatabaseUrl ?? undefined;
  }

  return config.databaseUrl ?? undefined;
}

export async function acquireServerLock(): Promise<void> {
  if (process.env.NEXT_PHASE === PRODUCTION_BUILD_PHASE) {
    return;
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    return;
  }

  if (lockGlobal.__aiVoiceNotesServerLock) {
    return;
  }

  let config: AppConfig;

  try {
    config = loadConfig();
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Konfigurace aplikace je neplatná.",
    );
    process.exit(1);
  }

  const databaseUrl = runtimeDatabaseUrl(config);

  if (!databaseUrl) {
    return;
  }

  const client = new Client({
    connectionString: databaseUrl,
    application_name: "ai-voice-notes-server-lock",
    connectionTimeoutMillis: 5_000,
  });

  try {
    await client.connect();
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [SERVER_LOCK_KEY],
    );

    if (!lock.rows[0]?.locked) {
      await client.end().catch(() => undefined);
      console.error(
        "Aplikace už běží v jiném procesu se stejnou databází. Ukončete předchozí server a zkuste to znovu.",
      );
      process.exit(1);
    }

    lockGlobal.__aiVoiceNotesServerLock = { client };
  } catch {
    await client.end().catch(() => undefined);
    console.error(
      "Databázi se při startu nepodařilo ověřit, proto aplikace neběží. Zkontrolujte připojení k databázi a zkuste to znovu.",
    );
    process.exit(1);
  }

  try {
    const connection = createDatabase(databaseUrl);

    try {
      const reconciled = await reconcileInterruptedReservations(connection.db);

      if (reconciled > 0) {
        console.warn(
          `Po předchozím přerušení bylo ${reconciled} rezervací označeno jako neznámá cena.`,
        );
      }
    } finally {
      await connection.pool.end().catch(() => undefined);
    }
  } catch {
    delete lockGlobal.__aiVoiceNotesServerLock;
    await client.end().catch(() => undefined);
    console.error(
      "Přerušené rezervace se nepodařilo ověřit, proto aplikace neběží. Spusťte migrace databáze a zkuste to znovu.",
    );
    process.exit(1);
  }
}

