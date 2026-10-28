import { randomInt } from "node:crypto";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { readMigrationFiles } from "drizzle-orm/migrator";

import nextEnv from "@next/env";

import { SEED_FIXTURES, SEED_KEY_PREFIX } from "./seed-fixtures.ts";
import {
  assertTestDatabaseTargets,
  loadTestEnvironment,
} from "./test-db-guard.ts";

const { loadEnvConfig } = nextEnv;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const FORBIDDEN_QUERY_KEYS = new Set([
  "host",
  "hostaddr",
  "port",
  "dbname",
  "database",
  "user",
  "password",
]);

interface SeedRunOptions {
  readonly databaseUrl: string;
  readonly now: Date;
  readonly random: () => number;
  readonly failAfterInserts?: number;
}

interface SeedRunResult {
  readonly count: number;
  readonly seedIds: string[];
}

function clampRandom(random: () => number): number {
  const value = random();

  if (!Number.isFinite(value)) {
    throw new Error("Testovací RNG vrátil neplatnou hodnotu.");
  }

  return Math.min(Math.max(value, 0), 0.9999999999999999);
}

function seedCreatedAt(
  fixture: (typeof SEED_FIXTURES)[number],
  now: Date,
  random: () => number,
): Date {
  const nowMs = now.getTime();
  const value = clampRandom(random);

  if (fixture.code === "D01") {
    const startOfUtcDay = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const span = Math.max(0, nowMs - startOfUtcDay);

    return new Date(nowMs - Math.floor(value * (span + 1)));
  }

  return new Date(nowMs - Math.floor(value * (THIRTY_DAYS_MS + 1)));
}

async function runSeed(
  options: SeedRunOptions,
): Promise<SeedRunResult> {
  if (!Number.isFinite(options.now.getTime())) {
    throw new Error("Čas seedu není platný.");
  }

  if (
    options.failAfterInserts !== undefined &&
    (!Number.isSafeInteger(options.failAfterInserts) ||
      options.failAfterInserts < 1)
  ) {
    throw new Error("SEED_TEST_FAIL_AFTER_INSERTS musí být kladné celé číslo.");
  }

  const [
    { createDatabase },
    { createSeededNoteInTransaction },
    { notes },
    { like, sql },
  ] = await Promise.all([
    import("../src/lib/db/client.ts"),
    import("../src/lib/notes/service.ts"),
    import("../src/lib/db/schema.ts"),
    import("drizzle-orm"),
  ]);

  const connection = createDatabase(options.databaseUrl);

  try {
    return await connection.db.transaction(async (tx) => {
      const migrations = readMigrationFiles({
        migrationsFolder: join(process.cwd(), "drizzle"),
      });
      const latestMigration = migrations.at(-1);
      let latestApplied: string | undefined;

      try {
        const migrationResult = await tx.execute(
          sql`select max(created_at)::bigint as latest from drizzle.__drizzle_migrations`,
        );
        latestApplied = migrationResult.rows[0]?.latest as string | undefined;
      } catch {
        throw new Error(
          "Cílová databáze není migrovaná. Před seedem spusťte pnpm db:migrate:test (testovací DB) nebo pnpm db:migrate (vývojová DB); seed nic nesmazal.",
        );
      }

      if (
        !latestMigration ||
        latestApplied === undefined ||
        Number(latestApplied) < latestMigration.folderMillis
      ) {
        throw new Error(
          "Cílová databáze není migrovaná na nejnovější schéma. Před seedem spusťte pnpm db:migrate:test (testovací DB) nebo pnpm db:migrate (vývojová DB); seed nic nesmazal.",
        );
      }

      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${SEED_KEY_PREFIX}))`,
      );

      await tx.delete(notes).where(like(notes.seedKey, `${SEED_KEY_PREFIX}%`));

      const seedIds: string[] = [];

      for (const fixture of SEED_FIXTURES) {
        const createdAt = seedCreatedAt(fixture, options.now, options.random);
        const note = await createSeededNoteInTransaction(tx, {
          seedKey: fixture.key,
          title: fixture.title,
          contentMd: fixture.contentMd,
          createdAt,
          updatedAt: createdAt,
        });

        seedIds.push(note.id);

        if (
          options.failAfterInserts !== undefined &&
          seedIds.length >= options.failAfterInserts
        ) {
          throw new Error("Testovací selhání seedu.");
        }
      }

      return { count: seedIds.length, seedIds };
    });
  } finally {
    await connection.pool.end().catch(() => undefined);
  }
}

function cryptoRandom(): number {
  return randomInt(0, 2 ** 32) / 2 ** 32;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function parseInjectedNow(): Date | undefined {
  const rawValue = process.env.SEED_TEST_NOW_MS;

  if (rawValue === undefined || rawValue === "") {
    return undefined;
  }

  const milliseconds = Number(rawValue);

  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("SEED_TEST_NOW_MS musí být celé číslo v milisekundách.");
  }

  const date = new Date(milliseconds);

  if (!Number.isFinite(date.getTime())) {
    throw new Error("SEED_TEST_NOW_MS není platné datum.");
  }

  return date;
}

function parseInjectedRandom(): (() => number) | undefined {
  const rawValue = process.env.SEED_TEST_RANDOM_SEED;

  if (rawValue === undefined || rawValue === "") {
    return undefined;
  }

  const seed = Number(rawValue);

  if (!Number.isSafeInteger(seed)) {
    throw new Error("SEED_TEST_RANDOM_SEED musí být celé číslo.");
  }

  return createSeededRandom(seed);
}

function parseFailAfterInserts(): number | undefined {
  const rawValue = process.env.SEED_TEST_FAIL_AFTER_INSERTS;

  if (rawValue === undefined || rawValue === "") {
    return undefined;
  }

  const value = Number(rawValue);

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("SEED_TEST_FAIL_AFTER_INSERTS musí být kladné celé číslo.");
  }

  return value;
}

function requireLoopbackDatabaseUrl(rawValue: string | undefined): string {
  const value = rawValue?.trim();

  if (!value) {
    throw new Error(
      "DATABASE_URL není nastavená. Doplňte ji do .env.local před seedem.",
    );
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL není platná PostgreSQL adresa.");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL musí používat protokol postgres nebo postgresql.");
  }

  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      "Seed smí běžet pouze proti loopback databázi (127.0.0.1, localhost nebo ::1).",
    );
  }

  for (const key of url.searchParams.keys()) {
    if (FORBIDDEN_QUERY_KEYS.has(key.toLowerCase())) {
      throw new Error(
        "DATABASE_URL nesmí přepisovat hostitele, port ani název databáze v query parametrech.",
      );
    }
  }

  if (!url.pathname || url.pathname === "/") {
    throw new Error("DATABASE_URL musí obsahovat název databáze.");
  }

  return value;
}

function assertNoArguments(): void {
  if (process.argv.length > 2) {
    throw new Error(
      "Seed nepřijímá žádné argumenty. Cíl se nastavuje pouze přes prostředí.",
    );
  }
}

async function main(): Promise<void> {
  assertNoArguments();

  const testMode = process.env.NODE_ENV === "test";
  let databaseUrl: string;
  let now: Date;
  let random: () => number;
  let failAfterInserts: number | undefined;

  if (testMode) {
    loadTestEnvironment();
    const targets = assertTestDatabaseTargets();
    databaseUrl = targets.testUrl;
    now = parseInjectedNow() ?? new Date();
    random = parseInjectedRandom() ?? cryptoRandom;
    failAfterInserts = parseFailAfterInserts();
  } else {
    loadEnvConfig(process.cwd(), true);
    databaseUrl = requireLoopbackDatabaseUrl(process.env.DATABASE_URL);
    now = new Date();
    random = cryptoRandom;
    console.warn(
      "Seed přepíše všechny poznámky s klíčem demo-v1:* v cílové databázi. Uživatelské poznámky zůstanou nedotčené.",
    );
  }

  const result = await runSeed({
    databaseUrl,
    now,
    random,
    failAfterInserts,
  });

  console.log(`Seed dokončen: ${result.count} poznámek.`);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Seed selhal.");
    process.exit(1);
  });
}
