import { z } from "zod";

import {
  OpenRouterHttpError,
} from "@/lib/ai/openrouter";
import {
  UsageServiceError,
  toUsageErrorResponse,
} from "@/lib/ai/usage";
import { ConfigurationError } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import {
  EMBEDDING_MODEL_ID,
  EmbeddingError,
  getEmbeddingProviderStatus,
  getEmbeddingService,
} from "@/lib/search/embeddings";
import {
  ReindexError,
  getReindexStatus,
  runReindex,
} from "@/lib/search/reindex";
import {
  createGuardedJsonRoute,
  createGuardedReadHandler,
  jsonError,
  jsonOk,
  type RateLimitOptions,
} from "@/lib/security/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DEFAULT_REINDEX_RATE_LIMIT = {
  limit: 6,
  windowMs: 60_000,
  key: "search-reindex",
} as const satisfies RateLimitOptions & { readonly key?: string };

const reindexRequestSchema = z
  .object({
    confirmCost: z.boolean().optional().default(false),
    approvedMaxCostUsd: z.number().finite().nonnegative().max(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.confirmCost && value.approvedMaxCostUsd === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvedMaxCostUsd"],
        message: "Potvrzená reindexace vyžaduje schválený odhad ceny.",
      });
    }
  });

type ReindexRequest = z.infer<typeof reindexRequestSchema>;

function errorResponse(error: unknown): Response {
  if (error instanceof ReindexError) {
    return jsonError(error.status, error.code, error.message, undefined, error.details);
  }

  if (error instanceof EmbeddingError) {
    return jsonError(error.status, error.code, error.message, undefined, error.details);
  }

  if (error instanceof UsageServiceError) {
    return toUsageErrorResponse(error);
  }

  if (error instanceof OpenRouterHttpError) {
    return jsonError(error.status, error.code, error.message);
  }

  if (error instanceof ConfigurationError) {
    return jsonError(500, "invalid_config", error.message);
  }

  return jsonError(
    500,
    "reindex_failed",
    "Indexaci se nepodařilo dokončit.",
  );
}

export const GET = createGuardedReadHandler({
  handler: async () => {
    const provider = getEmbeddingProviderStatus();
    const index = await getReindexStatus(getDb(), EMBEDDING_MODEL_ID);

    return jsonOk({ provider, index });
  },
});

export const POST = createGuardedJsonRoute<ReindexRequest>({
  maxBytes: 4 * 1024,
  schema: reindexRequestSchema,
  methods: ["POST"],
  rateLimit: DEFAULT_REINDEX_RATE_LIMIT,
  handler: async ({ data }) => {
    const provider = getEmbeddingProviderStatus();

    if (!provider.configured) {
      return jsonError(
        503,
        "embedding_not_configured",
        provider.blockedReason ??
          "Semantické indexování není nakonfigurované.",
      );
    }

    try {
      const outcome = await runReindex({
        db: getDb(),
        embedder: getEmbeddingService(),
        modelId: EMBEDDING_MODEL_ID,
        confirmCost: data.confirmCost,
        approvedMaxCostUsd: data.approvedMaxCostUsd,
      });

      return jsonOk({ ...outcome, provider });
    } catch (error) {
      return errorResponse(error);
    }
  },
});
