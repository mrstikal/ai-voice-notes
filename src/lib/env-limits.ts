export class EnvLimitError extends Error {
  readonly variable: string;

  constructor(variable: string, message: string) {
    super(`${variable}: ${message}`);
    this.name = "EnvLimitError";
    this.variable = variable;
  }
}

function parsePositiveInteger(variable: string, raw: string): number {
  if (!/^\d+$/u.test(raw)) {
    throw new EnvLimitError(variable, "musí být kladné celé číslo.");
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new EnvLimitError(variable, "musí být kladné celé číslo.");
  }

  return value;
}

function parseFiniteNumber(variable: string, raw: string): number {
  const value = Number(raw);

  if (!Number.isFinite(value) || value < 0) {
    throw new EnvLimitError(variable, "musí být nezáporné číslo.");
  }

  return value;
}

export function readEnvInt(variable: string, fallback: number): number {
  const raw = process.env[variable]?.trim();

  if (!raw) {
    return fallback;
  }

  return parsePositiveInteger(variable, raw);
}

export function readEnvNumber(variable: string, fallback: number): number {
  const raw = process.env[variable]?.trim();

  if (!raw) {
    return fallback;
  }

  return parseFiniteNumber(variable, raw);
}

export function publicEnvInt(
  raw: string | undefined,
  variable: string,
  fallback: number,
): number {
  const value = raw?.trim();

  if (!value) {
    return fallback;
  }

  return parsePositiveInteger(variable, value);
}

export interface RateLimitEnv {
  readonly limit: number;
  readonly windowMs: number;
}

export function readRateLimit(
  variable: string,
  fallbackLimit: number,
  fallbackWindowMs = 60_000,
): RateLimitEnv {
  return {
    limit: readEnvInt(variable, fallbackLimit),
    windowMs: readEnvInt(`${variable}_WINDOW_MS`, fallbackWindowMs),
  };
}
