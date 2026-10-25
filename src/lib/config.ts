import { CONTENT_MAX_GRAPHEMES } from "./notes/limits";

export const MIN_SUPPORTED_NODE_VERSION = "22.19.0";
export const DEFAULT_APP_ORIGIN = "http://127.0.0.1:3000";
export const DEFAULT_NOTE_MAX_CHARACTERS = CONTENT_MAX_GRAPHEMES;
export const DEFAULT_MEETING_MAX_MINUTES = 15;
export const DEFAULT_AI_REQUEST_BUDGET_USD = 2.0;

export type Environment = Record<string, string | undefined>;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export interface AppConfig {
  appOrigin: string;
  appHost: string;
  appPort: number;
  databaseUrl: string | null;
  testDatabaseUrl: string | null;
  aiTestMode: boolean;
  noteMaxCharacters: number;
  meetingMaxMinutes: number;
  aiRequestBudgetUsd: number;
}

type VersionTuple = readonly [number, number, number];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function parseVersion(version: string, label: string): VersionTuple {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) {
    throw new ConfigurationError(
      `${label} není platná verze. Očekává se formát například 22.19.0.`,
    );
  }

  return [
    Number(match[1] ?? Number.NaN),
    Number(match[2] ?? Number.NaN),
    Number(match[3] ?? Number.NaN),
  ];
}

function isVersionAtLeast(actual: VersionTuple, minimum: VersionTuple): boolean {
  for (let index = 0; index < 3; index += 1) {
    const actualPart = actual[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;

    if (actualPart > minimumPart) {
      return true;
    }

    if (actualPart < minimumPart) {
      return false;
    }
  }

  return true;
}

export function assertSupportedNodeVersion(
  version: string = process.versions.node,
): void {
  const actual = parseVersion(version, "Verze Node.js");
  const minimum = parseVersion(MIN_SUPPORTED_NODE_VERSION, "Minimální verze");

  if (!isVersionAtLeast(actual, minimum)) {
    throw new ConfigurationError(
      `Aplikace vyžaduje Node.js ${MIN_SUPPORTED_NODE_VERSION} nebo novější. ` +
        `Aktuální verze je ${version}. Přepněte verzi pomocí nvm use.`,
    );
  }
}

interface ParsedOrigin {
  origin: string;
  host: string;
  port: number;
}

export interface StartupEnvironment {
  appOrigin: string;
  appHost: string;
  appPort: number;
}

function extractExplicitPort(value: string): string | null {
  const authorityMatch = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value);
  if (!authorityMatch) {
    return null;
  }

  const authority = authorityMatch[1] ?? "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);

  if (hostPort.startsWith("[")) {
    const closingBracket = hostPort.indexOf("]");
    if (closingBracket === -1) {
      return null;
    }

    const suffix = hostPort.slice(closingBracket + 1);
    return suffix.startsWith(":") ? suffix.slice(1) : null;
  }

  const colonIndex = hostPort.lastIndexOf(":");
  return colonIndex === -1 ? null : hostPort.slice(colonIndex + 1);
}

function parseAppOrigin(rawOrigin: string | undefined): ParsedOrigin {
  const value = rawOrigin?.trim() || DEFAULT_APP_ORIGIN;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(
      `APP_ORIGIN musí být platná adresa, například ${DEFAULT_APP_ORIGIN}.`,
    );
  }

  if (url.protocol !== "http:") {
    throw new ConfigurationError("APP_ORIGIN musí používat protokol http.");
  }

  if (url.username !== "" || url.password !== "") {
    throw new ConfigurationError("APP_ORIGIN nesmí obsahovat přihlašovací údaje.");
  }

  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ConfigurationError(
      "APP_ORIGIN nesmí obsahovat cestu, dotaz ani fragment.",
    );
  }

  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ConfigurationError(
      "APP_ORIGIN musí používat pouze loopback adresu (127.0.0.1, localhost nebo ::1).",
    );
  }

  const explicitPort = extractExplicitPort(value);
  if (explicitPort === null || explicitPort === "") {
    throw new ConfigurationError("APP_ORIGIN musí obsahovat explicitní port.");
  }

  const port = Number(url.port === "" ? explicitPort : url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError("APP_ORIGIN obsahuje neplatný port.");
  }

  return {
    origin: url.origin,
    host: url.hostname === "[::1]" ? "::1" : url.hostname,
    port,
  };
}

function parseOptionalPostgresUrl(
  rawUrl: string | undefined,
  name: "DATABASE_URL" | "TEST_DATABASE_URL",
): string | null {
  const value = rawUrl?.trim();
  if (!value) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(
      `${name} musí být platná adresa PostgreSQL, například postgresql://user:heslo@127.0.0.1:5432/databaze.`,
    );
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConfigurationError(`${name} musí používat protokol postgres nebo postgresql.`);
  }

  if (url.hostname === "" || url.pathname === "" || url.pathname === "/") {
    throw new ConfigurationError(`${name} musí obsahovat hostitele a název databáze.`);
  }

  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ConfigurationError(
      `${name} musí používat pouze loopback hostitele (127.0.0.1, localhost nebo ::1).`,
    );
  }

  return value;
}

function parsePositiveInteger(
  env: Environment,
  name: "NOTE_MAX_CHARACTERS" | "MEETING_MAX_MINUTES",
  fallback: number,
): number {
  const rawValue = env[name]?.trim();
  if (!rawValue) {
    return fallback;
  }

  if (!/^\d+$/.test(rawValue)) {
    throw new ConfigurationError(`${name} musí být kladné celé číslo.`);
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConfigurationError(`${name} musí být kladné celé číslo.`);
  }

  return value;
}

function parseBudget(env: Environment): number {
  const rawValue = env.AI_REQUEST_BUDGET_USD?.trim();
  if (!rawValue) {
    return DEFAULT_AI_REQUEST_BUDGET_USD;
  }

  if (!/^\d+(?:\.\d{1,6})?$/.test(rawValue)) {
    throw new ConfigurationError(
      "AI_REQUEST_BUDGET_USD musí být kladné číslo s nejvýše šesti desetinnými místy.",
    );
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigurationError("AI_REQUEST_BUDGET_USD musí být kladné číslo.");
  }

  return value;
}

function parseAiTestMode(env: Environment): boolean {
  const rawValue = env.AI_TEST_MODE?.trim();
  if (!rawValue || rawValue === "0") {
    return false;
  }

  if (rawValue === "1") {
    return true;
  }

  throw new ConfigurationError("AI_TEST_MODE může být pouze 1 nebo 0.");
}

export function validateStartupEnvironment(
  env: Environment = process.env,
  nodeVersion: string = process.versions.node,
): StartupEnvironment {
  assertSupportedNodeVersion(nodeVersion);

  const appOrigin = parseAppOrigin(env.APP_ORIGIN);

  return {
    appOrigin: appOrigin.origin,
    appHost: appOrigin.host,
    appPort: appOrigin.port,
  };
}

export function loadConfig(
  env: Environment = process.env,
  nodeVersion: string = process.versions.node,
): AppConfig {
  const startup = validateStartupEnvironment(env, nodeVersion);
  const noteMaxCharacters = parsePositiveInteger(
    env,
    "NOTE_MAX_CHARACTERS",
    DEFAULT_NOTE_MAX_CHARACTERS,
  );

  if (noteMaxCharacters > CONTENT_MAX_GRAPHEMES) {
    throw new ConfigurationError(
      `NOTE_MAX_CHARACTERS nesmí překročit ${CONTENT_MAX_GRAPHEMES}.`,
    );
  }

  return {
    ...startup,
    databaseUrl: parseOptionalPostgresUrl(env.DATABASE_URL, "DATABASE_URL"),
    testDatabaseUrl: parseOptionalPostgresUrl(
      env.TEST_DATABASE_URL,
      "TEST_DATABASE_URL",
    ),
    aiTestMode: parseAiTestMode(env),
    noteMaxCharacters,
    meetingMaxMinutes: parsePositiveInteger(
      env,
      "MEETING_MAX_MINUTES",
      DEFAULT_MEETING_MAX_MINUTES,
    ),
    aiRequestBudgetUsd: parseBudget(env),
  };
}
