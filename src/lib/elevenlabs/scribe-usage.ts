import { z } from "zod";

import { ConfigurationError } from "../config.ts";
import {
  UsageServiceError,
  getUsageService,
  toUsageErrorResponse,
  type UsageOperationDto,
  type UsageService,
} from "../ai/usage.ts";
import { readEnvInt, readRateLimit } from "../env-limits.ts";
import {
  TOKEN_TOOL_MAX_BYTES,
  createGuardedJsonRoute,
  jsonError,
  jsonOk,
  type RateLimitOptions,
} from "../security/http.ts";
import {
  SCRIBE_REALTIME_USD_PER_HOUR,
  SCRIBE_SESSION_MAX_SECONDS,
  SCRIBE_TOKEN_OPERATION,
  SCRIBE_TOKEN_TYPE,
} from "./client.ts";

export const SCRIBE_USAGE_PROVIDER = "elevenlabs";
export const SCRIBE_USAGE_CHARGE_REASON = "realtime_audio_duration_price";
export const SCRIBE_USAGE_DURATION_GRACE_SECONDS = readEnvInt(
  "SCRIBE_USAGE_DURATION_GRACE_SECONDS",
  60,
);

export const DEFAULT_SCRIBE_USAGE_RATE_LIMIT = {
  ...readRateLimit("SCRIBE_USAGE_RATE_LIMIT", 60),
  key: "scribe-usage",
} as const satisfies RateLimitOptions & { readonly key?: string };

export const scribeUsageSchema = z
  .object({
    usageId: z.string().uuid(),
    audioSeconds: z
      .number()
      .finite()
      .positive()
      .max(SCRIBE_SESSION_MAX_SECONDS + SCRIBE_USAGE_DURATION_GRACE_SECONDS),
  })
  .strict();

export type ScribeUsageRequest = z.infer<typeof scribeUsageSchema>;

export interface ScribeUsageServiceOptions {
  readonly usage: UsageService;
}

export interface ScribeUsageSettlement {
  readonly operation: UsageOperationDto;
  readonly billedSeconds: number;
  readonly costUsd: number;
}

export async function settleScribeRealtimeUsage(
  options: ScribeUsageServiceOptions,
  request: ScribeUsageRequest,
): Promise<ScribeUsageSettlement> {
  const billedSeconds = Math.min(
    request.audioSeconds,
    SCRIBE_SESSION_MAX_SECONDS,
  );
  const costUsd = (billedSeconds * SCRIBE_REALTIME_USD_PER_HOUR) / 3600;

  const operation = await options.usage.settle(
    request.usageId,
    {
      reportedCostUsd: costUsd,
      providerUsage: {
        tokenType: SCRIBE_TOKEN_TYPE,
        audioDurationSecs: billedSeconds,
        usdPerHour: SCRIBE_REALTIME_USD_PER_HOUR,
        chargeBasis: "audio_duration",
        chargeReason: SCRIBE_USAGE_CHARGE_REASON,
      },
    },
    {
      allowUnknown: true,
      expectedOperation: SCRIBE_TOKEN_OPERATION,
      expectedProvider: SCRIBE_USAGE_PROVIDER,
    },
  );

  return { operation, billedSeconds, costUsd };
}

export interface ScribeUsageRouteOptions {
  readonly usageFactory?: () => UsageService;
  readonly rateLimit?: RateLimitOptions & { readonly key?: string };
}

function resolveUsage(options: ScribeUsageRouteOptions): UsageService {
  if (options.usageFactory) {
    return options.usageFactory();
  }

  try {
    return getUsageService();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }

    throw new UsageServiceError(
      503,
      "database_unavailable",
      "Databázi využití se nepodařilo načíst. Zkontrolujte DATABASE_URL a spuštěnou databázi.",
    );
  }
}

function toScribeUsageErrorResponse(error: unknown): Response {
  if (error instanceof UsageServiceError) {
    return toUsageErrorResponse(error);
  }

  if (error instanceof ConfigurationError) {
    return jsonError(
      500,
      "invalid_config",
      "Konfigurace aplikace je neplatná.",
    );
  }

  return jsonError(500, "internal_error", "Cenu relace se nepodařilo zapsat.");
}

export function createScribeUsageRouteHandler(
  options: ScribeUsageRouteOptions = {},
): (request: Request) => Promise<Response> {
  return createGuardedJsonRoute({
    maxBytes: TOKEN_TOOL_MAX_BYTES,
    schema: scribeUsageSchema,
    methods: ["POST"],
    rateLimit: options.rateLimit ?? DEFAULT_SCRIBE_USAGE_RATE_LIMIT,
    handler: async ({ data }) => {
      try {
        const settlement = await settleScribeRealtimeUsage(
          { usage: resolveUsage(options) },
          data,
        );

        return jsonOk({
          settled: true,
          billedSeconds: settlement.billedSeconds,
          reportedCostUsd: settlement.operation.reportedCostUsd,
        });
      } catch (error) {
        return toScribeUsageErrorResponse(error);
      }
    },
  });
}
