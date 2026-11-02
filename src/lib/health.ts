import { Client } from "pg";

import { loadConfig } from "./config";

const HEALTH_TIMEOUT_MS = 1_500;

export interface HealthResult {
  readonly ok: boolean;
  readonly message: string;
}

export async function checkHealth(): Promise<HealthResult> {
  let databaseUrl: string | null;

  try {
    databaseUrl = loadConfig().databaseUrl;
  } catch {
    return {
      ok: false,
      message:
        "Konfigurace aplikace je neplatná. Zkontrolujte .env.local.",
    };
  }

  if (!databaseUrl) {
    return {
      ok: false,
      message:
        "Databáze není nakonfigurována. Nastavte DATABASE_URL v .env.local a spusťte docker compose up -d db.",
    };
  }

  const client = new Client({
    connectionString: databaseUrl,
    application_name: "ai-voice-notes-health",
    connectionTimeoutMillis: HEALTH_TIMEOUT_MS,
    query_timeout: HEALTH_TIMEOUT_MS,
    statement_timeout: HEALTH_TIMEOUT_MS,
  });

  try {
    await client.connect();
    await client.query("SELECT 1");

    return {
      ok: true,
      message: "Aplikace je v pořádku. Databáze odpovídá.",
    };
  } catch {
    return {
      ok: false,
      message:
        "Databáze není dostupná. Zkontrolujte, zda běží kontejner db příkazem docker compose up -d db.",
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}
