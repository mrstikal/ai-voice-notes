import { z } from "zod";

import { OpenRouterHttpError } from "@/lib/ai/openrouter";
import { UsageServiceError, toUsageErrorResponse } from "@/lib/ai/usage";
import { ConfigurationError } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import {
  EMBEDDING_MODEL_ID,
  EMBEDDING_QUERY_OPERATION,
  EMBEDDING_QUERY_REQUEST_KIND,
  EmbeddingError,
  estimateEmbeddingMaxCostUsd,
  getEmbeddingProviderStatus,
  getEmbeddingService,
} from "@/lib/search/embeddings";
import {
  GROUNDING_LLM_MAX_COST_USD,
  GroundingError,
  askGroundedQuestion,
  getGroundingLlm,
  normalizeAskQuestion,
} from "@/lib/search/grounding";
import { SearchQueryError } from "@/lib/search/fts";
import { getReindexStatus } from "@/lib/search/reindex";
import { SemanticSearchError } from "@/lib/search/semantic";
import {
  createGuardedJsonRoute,
  jsonError,
  jsonOk,
  type RateLimitOptions,
} from "@/lib/security/http";
import { getLlmProviderStatus } from "@/lib/ai/structured";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const ASK_RATE_LIMIT = {
  limit: process.env.NODE_ENV === "test" ? 1_000 : 6,
  windowMs: 60_000,
  key: "ask-notes",
} as const satisfies RateLimitOptions & { readonly key?: string };

const askRequestSchema = z
  .object({
    question: z.string().max(4_000),
    confirmCost: z.boolean().optional().default(false),
    approvedMaxCostUsd: z.number().finite().nonnegative().max(1).optional(),
  })
  .strict();

type AskRequest = z.infer<typeof askRequestSchema>;

function ceil6(value: number): number {
  return Math.ceil(value * 1e6) / 1e6;
}

function askErrorResponse(error: unknown): Response {
  if (error instanceof GroundingError) {
    return jsonError(
      error.status,
      error.code,
      error.message,
      undefined,
      error.details,
    );
  }

  if (error instanceof SearchQueryError) {
    return jsonError(error.status, error.code, error.message);
  }

  if (error instanceof SemanticSearchError) {
    return jsonError(error.status, error.code, error.message);
  }

  if (error instanceof EmbeddingError) {
    return jsonError(
      error.status,
      error.code,
      error.message,
      undefined,
      error.details,
    );
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
    "ask_failed",
    "Odpověď z poznámek se nepodařilo vytvořit.",
  );
}

export const POST = createGuardedJsonRoute<AskRequest>({
  maxBytes: 16 * 1024,
  schema: askRequestSchema,
  methods: ["POST"],
  rateLimit: ASK_RATE_LIMIT,
  handler: async ({ data }) => {
    try {
      const question = normalizeAskQuestion(data.question);
      const llmStatus = getLlmProviderStatus();

      if (!llmStatus.configured) {
        return jsonError(
          503,
          "grounding_not_configured",
          llmStatus.blockedReason ??
            "Grounded odpovědi nejsou nakonfigurované. Fulltextové hledání funguje dál.",
        );
      }

      const db = getDb();
      const indexStatus = await getReindexStatus(db, EMBEDDING_MODEL_ID);
      const semanticAvailable =
        indexStatus.chunks.ready > 0 &&
        getEmbeddingProviderStatus().configured;
      const queryEmbeddingUsd = semanticAvailable
        ? estimateEmbeddingMaxCostUsd([question])
        : 0;
      const estimatedMaxCostUsd = ceil6(
        GROUNDING_LLM_MAX_COST_USD + queryEmbeddingUsd,
      );

      if (!data.confirmCost) {
        return jsonError(
          400,
          "ask_cost_not_confirmed",
          "Odpověď z poznámek vyžaduje výslovné potvrzení placeného volání.",
        );
      }

      if (
        data.approvedMaxCostUsd === undefined ||
        data.approvedMaxCostUsd + 1e-9 < estimatedMaxCostUsd
      ) {
        return jsonError(
          409,
          "ask_cost_not_approved",
          "Potvrzený limit ceny je nižší než odhad. Potvrďte nový odhad.",
          undefined,
          {
            approvedMaxCostUsd: data.approvedMaxCostUsd,
            estimatedMaxCostUsd,
          },
        );
      }

      const embedder = semanticAvailable
        ? getEmbeddingService({
            operation: EMBEDDING_QUERY_OPERATION,
            requestKind: EMBEDDING_QUERY_REQUEST_KIND,
          })
        : null;
      const result = await askGroundedQuestion(
        {
          db,
          embedder,
          llm: getGroundingLlm(),
          semanticAvailable,
        },
        {
          question,
          approvedMaxCostUsd: data.approvedMaxCostUsd,
        },
      );

      return jsonOk({
        ...result,
        approvalCeilingUsd: estimatedMaxCostUsd,
      });
    } catch (error) {
      return askErrorResponse(error);
    }
  },
});
