import { NextResponse } from "next/server";
import { Client } from "pg";

import { loadConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEALTH_TIMEOUT_MS = 1_500;

function unavailable(message: string) {
  return NextResponse.json(
    { status: "error", message },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET() {
  let databaseUrl: string | null;

  try {
    databaseUrl = loadConfig().databaseUrl;
  } catch {
    return unavailable("Konfigurace aplikace je neplatná. Zkontrolujte .env.local.");
  }

  if (!databaseUrl) {
    return unavailable(
      "Databáze není nakonfigurována. Nastavte DATABASE_URL v .env.local a spusťte docker compose up -d db.",
    );
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

    return NextResponse.json(
      { status: "ok" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return unavailable(
      "Databáze není dostupná. Zkontrolujte, zda běží kontejner db příkazem docker compose up -d db.",
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
