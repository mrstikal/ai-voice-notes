import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;

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

export interface TestDatabaseTargets {
  devUrl: string;
  testUrl: string;
  testDatabaseName: string;
  testHost: string;
}

export class TestDatabaseGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDatabaseGuardError";
  }
}

export function loadTestEnvironment(cwd: string = process.cwd()): void {
  Object.assign(process.env, { NODE_ENV: "test" });
  loadEnvConfig(cwd, false);
}

function parsePostgresUrl(
  rawValue: string | undefined,
  name: "DATABASE_URL" | "TEST_DATABASE_URL",
): { url: URL; value: string } {
  const value = rawValue?.trim();
  if (!value) {
    throw new TestDatabaseGuardError(
      `${name} není nastavená. Doplňte ji do .env.test.local.`,
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TestDatabaseGuardError(`${name} není platná PostgreSQL adresa.`);
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new TestDatabaseGuardError(
      `${name} musí používat protokol postgres nebo postgresql.`,
    );
  }

  if (url.hostname === "" || url.pathname === "" || url.pathname === "/") {
    throw new TestDatabaseGuardError(
      `${name} musí obsahovat hostitele a název databáze.`,
    );
  }

  return { url, value };
}

function databaseName(
  url: URL,
  name: "DATABASE_URL" | "TEST_DATABASE_URL",
): string {
  try {
    return decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new TestDatabaseGuardError(
      `${name} obsahuje neplatný název databáze.`,
    );
  }
}

function databaseTargetKey(url: URL): string {
  const port = url.port || "5432";
  return `${url.hostname.toLowerCase()}:${port}${url.pathname}`;
}

export function assertEvaluationTargets(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): TestDatabaseTargets {
  if (env.NEXT_PHASE === "phase-production-build") {
    throw new TestDatabaseGuardError(
      "Hodnocení vyhledávání se nesmí spouštět během produkčního buildu.",
    );
  }

  return assertTestDatabaseTargets(env);
}

export function assertTestDatabaseTargets(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): TestDatabaseTargets {
  const dev = parsePostgresUrl(env.DATABASE_URL, "DATABASE_URL");
  const test = parsePostgresUrl(env.TEST_DATABASE_URL, "TEST_DATABASE_URL");
  const testDatabaseName = databaseName(test.url, "TEST_DATABASE_URL");
  const devDatabaseName = databaseName(dev.url, "DATABASE_URL");

  if (!testDatabaseName.endsWith("_test")) {
    throw new TestDatabaseGuardError(
      "TEST_DATABASE_URL musí mířit na databázi s názvem končícím na _test.",
    );
  }

  if (!LOOPBACK_HOSTS.has(test.url.hostname)) {
    throw new TestDatabaseGuardError(
      "TEST_DATABASE_URL musí používat loopback hostitele (127.0.0.1, localhost nebo ::1).",
    );
  }

  if (test.url.port === "") {
    throw new TestDatabaseGuardError(
      "TEST_DATABASE_URL musí obsahovat explicitní port testovací databáze.",
    );
  }

  for (const key of test.url.searchParams.keys()) {
    if (FORBIDDEN_QUERY_KEYS.has(key.toLowerCase())) {
      throw new TestDatabaseGuardError(
        "TEST_DATABASE_URL nesmí přepisovat hostitele, port ani název databáze v query parametrech.",
      );
    }
  }

  if (databaseTargetKey(dev.url) === databaseTargetKey(test.url)) {
    throw new TestDatabaseGuardError(
      "DATABASE_URL a TEST_DATABASE_URL musí být rozdílné.",
    );
  }

  if (devDatabaseName === testDatabaseName) {
    throw new TestDatabaseGuardError(
      "Testovací databáze musí mít jiný název než vývojová.",
    );
  }

  return {
    devUrl: dev.value,
    testUrl: test.value,
    testDatabaseName,
    testHost: test.url.hostname,
  };
}
