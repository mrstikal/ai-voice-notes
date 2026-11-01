import {
  ElevenLabs,
  ElevenLabsClient,
} from "@elevenlabs/elevenlabs-js";

import {
  getUsageService,
  toUsageErrorResponse,
  UsageServiceError,
  type UsageOperationDto,
  type UsageService,
} from "../ai/usage.ts";
import {
  ConfigurationError,
  loadConfig,
  type AppConfig,
} from "../config.ts";
import { readEnvInt, readRateLimit } from "../env-limits.ts";
import {
  TOKEN_TOOL_MAX_BYTES,
  createGuardedJsonRoute,
  jsonError,
  jsonOk,
  type RateLimitOptions,
} from "../security/http.ts";
import { tokenRequestSchema } from "../security/schemas.ts";

export const SCRIBE_REALTIME_MODEL_ID = "scribe_v2_realtime";
export const SCRIBE_TOKEN_TYPE =
  ElevenLabs.SingleUseTokenType.RealtimeScribe;
export const SCRIBE_TOKEN_TTL_SECONDS = readEnvInt(
  "SCRIBE_TOKEN_TTL_SECONDS",
  15 * 60,
);
export const SCRIBE_TOKEN_TIMEOUT_SECONDS = readEnvInt(
  "SCRIBE_TOKEN_TIMEOUT_SECONDS",
  10,
);
export const SCRIBE_SESSION_MAX_SECONDS = readEnvInt(
  "SCRIBE_SESSION_MAX_SECONDS",
  180,
);
export const SCRIBE_REALTIME_USD_PER_HOUR = 0.39;
export const SCRIBE_TOKEN_ESTIMATED_MAX_COST_USD = 0.0195;
export const SCRIBE_TOKEN_OPERATION = "elevenlabs_scribe_token";

export interface ScribeTokenTransportRequest {
  readonly apiKey: string;
  readonly tokenType: typeof SCRIBE_TOKEN_TYPE;
  readonly baseUrl: string;
}

export interface ElevenLabsTransport {
  createToken(
    request: ScribeTokenTransportRequest,
  ): Promise<{ readonly token: string }>;
}

export interface ScribeTokenResult {
  readonly token: string;
  readonly expiresInSeconds: number;
  readonly expiresAt: string;
  readonly modelId: typeof SCRIBE_REALTIME_MODEL_ID;
  readonly maxSessionSeconds: number;
}

export interface ScribeTokenService {
  mintToken(): Promise<ScribeTokenResult>;
}

export interface ScribeTokenServiceOptions {
  readonly config: AppConfig;
  readonly usage: UsageService;
  readonly transport?: ElevenLabsTransport;
  readonly now?: () => number;
}

export class ScribeTokenError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ScribeTokenError";
    this.status = status;
    this.code = code;
  }
}

let testTransport: ElevenLabsTransport | null = null;

export function setElevenLabsTransportForTests(
  transport: ElevenLabsTransport | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "Testovací transport lze nastavit pouze v NODE_ENV=test.",
    );
  }

  testTransport = transport;
}

export function getElevenLabsTransport(): ElevenLabsTransport {
  if (process.env.NODE_ENV === "test") {
    if (testTransport) {
      return testTransport;
    }

    throw new ScribeTokenError(
      500,
      "unmocked_provider_call",
      "V testovacím režimu není povolený nemockovaný odchozí požadavek.",
    );
  }

  return createSdkTransport();
}

function createSdkTransport(): ElevenLabsTransport {
  return {
    async createToken({ apiKey, tokenType, baseUrl }) {
      const client = new ElevenLabsClient({
        apiKey,
        baseUrl,
        timeoutInSeconds: SCRIBE_TOKEN_TIMEOUT_SECONDS,
        maxRetries: 0,
      });
      const response = await client.tokens.singleUse.create(tokenType, {
        apiKey,
        timeoutInSeconds: SCRIBE_TOKEN_TIMEOUT_SECONDS,
        maxRetries: 0,
      });

      return { token: response.token };
    },
  };
}

function invalidProviderResponse(): ScribeTokenError {
  return new ScribeTokenError(
    502,
    "invalid_provider_response",
    "ElevenLabs vrátil neplatný token. Zkuste to znovu.",
  );
}

function validateToken(value: unknown): string {
  if (typeof value !== "string") {
    throw invalidProviderResponse();
  }

  const token = value.trim();

  if (
    token.length < 8 ||
    token.length > 4096 ||
    /[\s\x00-\x1f\x7f]/u.test(token)
  ) {
    throw invalidProviderResponse();
  }

  return token;
}

function providerStatusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const candidate = (error as { statusCode?: unknown }).statusCode;

  return typeof candidate === "number" ? candidate : null;
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "ElevenLabsTimeoutError" ||
    /timeout|timed out/iu.test(error.message)
  );
}

function mapProviderError(error: unknown): ScribeTokenError {
  if (error instanceof ScribeTokenError) {
    return error;
  }

  const status = providerStatusCode(error);

  if (status === 401 || status === 403) {
    return new ScribeTokenError(
      502,
      "elevenlabs_auth_failed",
      "ElevenLabs odmítl přihlašovací údaj. Zkontrolujte ELEVENLABS_API_KEY.",
    );
  }

  if (status === 429) {
    return new ScribeTokenError(
      503,
      "elevenlabs_rate_limited",
      "ElevenLabs dočasně omezil požadavky. Zkuste to znovu později.",
    );
  }

  if (isTimeoutError(error)) {
    return new ScribeTokenError(
      504,
      "elevenlabs_timeout",
      "ElevenLabs neodpověděl včas. Zkuste to znovu.",
    );
  }

  return new ScribeTokenError(
    502,
    "elevenlabs_error",
    "Token se nepodařilo vytvořit u ElevenLabs. Zkuste to znovu.",
  );
}

async function markUnknownQuietly(
  usage: UsageService,
  reservation: UsageOperationDto,
  chargeReason: string,
): Promise<void> {
  await usage
    .markUnknown(reservation.id, {
      tokenType: SCRIBE_TOKEN_TYPE,
      chargeReason,
    })
    .catch(() => undefined);
}

export function createScribeTokenService(
  options: ScribeTokenServiceOptions,
): ScribeTokenService {
  const now = options.now ?? Date.now;

  return {
    async mintToken() {
      const apiKey = options.config.elevenLabsApiKey;

      if (!apiKey) {
        throw new ScribeTokenError(
          503,
          "elevenlabs_not_configured",
          "ElevenLabs není nakonfigurovaný. Doplňte ELEVENLABS_API_KEY do .env.local.",
        );
      }

      const transport = options.transport ?? getElevenLabsTransport();
      let reservation: UsageOperationDto;

      try {
        reservation = await options.usage.reserve({
          operation: SCRIBE_TOKEN_OPERATION,
          provider: "elevenlabs",
          model: SCRIBE_REALTIME_MODEL_ID,
          estimatedMaxCostUsd: SCRIBE_TOKEN_ESTIMATED_MAX_COST_USD,
        });
      } catch (error) {
        if (error instanceof UsageServiceError) {
          throw error;
        }

        throw new ScribeTokenError(
          503,
          "database_unavailable",
          "Databázi využití se nepodařilo načíst. Zkontrolujte DATABASE_URL a spuštěnou databázi.",
        );
      }

      const issuedAt = now();
      let token: string;

      try {
        const result = await transport.createToken({
          apiKey,
          tokenType: SCRIBE_TOKEN_TYPE,
          baseUrl: options.config.elevenLabsApiBaseUrl,
        });
        token = validateToken(result.token);
      } catch (error) {
        await markUnknownQuietly(
          options.usage,
          reservation,
          "provider_request_failed",
        );
        throw mapProviderError(error);
      }

      try {
        await options.usage.markUnknown(reservation.id, {
          tokenType: SCRIBE_TOKEN_TYPE,
          tokenExpiresInSeconds: SCRIBE_TOKEN_TTL_SECONDS,
          sessionMaxSeconds: SCRIBE_SESSION_MAX_SECONDS,
          chargeReason: "realtime_session_usage_unknown",
        });
      } catch {
        throw new ScribeTokenError(
          503,
          "usage_settlement_failed",
          "Token byl vytvořen, ale využití se nepodařilo zapsat. Zkuste to znovu.",
        );
      }

      return {
        token,
        expiresInSeconds: SCRIBE_TOKEN_TTL_SECONDS,
        expiresAt: new Date(
          issuedAt + SCRIBE_TOKEN_TTL_SECONDS * 1000,
        ).toISOString(),
        modelId: SCRIBE_REALTIME_MODEL_ID,
        maxSessionSeconds: SCRIBE_SESSION_MAX_SECONDS,
      };
    },
  };
}

export function getScribeTokenService(): ScribeTokenService {
  const config = loadConfig();
  let usage: UsageService;

  try {
    usage = getUsageService();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }

    throw new ScribeTokenError(
      503,
      "database_unavailable",
      "Databáze není dostupná. Zkontrolujte DATABASE_URL a spuštěnou databázi.",
    );
  }

  return createScribeTokenService({
    config,
    usage,
  });
}

export function toScribeTokenErrorResponse(error: unknown): Response {
  if (error instanceof ScribeTokenError) {
    return jsonError(error.status, error.code, error.message);
  }

  if (error instanceof UsageServiceError) {
    return toUsageErrorResponse(error);
  }

  if (error instanceof ConfigurationError) {
    return jsonError(500, "invalid_config", "Konfigurace aplikace je neplatná.");
  }

  return jsonError(
    500,
    "internal_error",
    "Token pro diktování se nepodařilo vytvořit.",
  );
}

export const DEFAULT_SCRIBE_TOKEN_RATE_LIMIT = {
  ...readRateLimit("DEFAULT_SCRIBE_TOKEN_RATE_LIMIT", 5),
  key: "scribe-token",
} as const satisfies RateLimitOptions & { readonly key?: string };

export interface ScribeTokenRouteOptions {
  readonly serviceFactory?: () => ScribeTokenService;
  readonly rateLimit?: RateLimitOptions & { readonly key?: string };
}

export function createScribeTokenRouteHandler(
  options: ScribeTokenRouteOptions = {},
): (request: Request) => Promise<Response> {
  const serviceFactory = options.serviceFactory ?? getScribeTokenService;

  return createGuardedJsonRoute({
    maxBytes: TOKEN_TOOL_MAX_BYTES,
    schema: tokenRequestSchema,
    methods: ["POST"],
    rateLimit: options.rateLimit ?? DEFAULT_SCRIBE_TOKEN_RATE_LIMIT,
    handler: async () => {
      try {
        return jsonOk(await serviceFactory().mintToken());
      } catch (error) {
        return toScribeTokenErrorResponse(error);
      }
    },
  });
}
