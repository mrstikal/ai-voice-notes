import { z } from "zod";

import { OpenRouterHttpError } from "@/lib/ai/openrouter";
import { UsageServiceError, toUsageErrorResponse } from "@/lib/ai/usage";
import { ConfigurationError } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { readRateLimit } from "@/lib/env-limits";
import {
  InvalidPageError,
  parsePageParam,
} from "@/lib/notes/service";
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
  SearchQueryError,
  emptySearchResult,
  normalizeSearchQuery,
  searchNotesFullText,
} from "@/lib/search/fts";
import {
  HYBRID_COMPONENT_LIMIT,
  HYBRID_RESULT_LIMIT,
  fuseHybridResults,
} from "@/lib/search/hybrid";
import { getReindexStatus } from "@/lib/search/reindex";
import {
  SEMANTIC_QUERY_MAX_CODE_UNITS,
  SemanticSearchError,
  searchNotesSemantic,
} from "@/lib/search/semantic";
import {
  createGuardedJsonRoute,
  createGuardedReadHandler,
  jsonError,
  jsonOk,
  type RateLimitOptions,
} from "@/lib/security/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const SEARCH_SEMANTIC_RATE_LIMIT = {
  ...readRateLimit("SEARCH_SEMANTIC_RATE_LIMIT", 10),
  key: "search-semantic",
} as const satisfies RateLimitOptions & { readonly key?: string };

const semanticSearchRequestSchema = z
  .object({
    mode: z.enum(["semantic", "hybrid"]),
    q: z.string().max(4_000),
    page: z.number().int().positive().max(1_000).optional().default(1),
    confirmCost: z.boolean().optional().default(false),
    approvedMaxCostUsd: z.number().finite().nonnegative().max(1).optional(),
  })
  .strict();

type SemanticSearchRequest = z.infer<typeof semanticSearchRequestSchema>;

function semanticErrorResponse(error: unknown): Response {
  if (error instanceof SearchQueryError) {
    return jsonError(error.status, error.code, error.message);
  }

  if (error instanceof InvalidPageError) {
    return jsonError(400, "invalid_page", error.message);
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
    "semantic_search_failed",
    "Sémantické hledání se nepodařilo dokončit.",
  );
}

export const GET = createGuardedReadHandler({
  handler: async (request) => {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") ?? "fulltext";

    if (mode === "semantic") {
      return jsonError(
        400,
        "semantic_requires_post",
        "Sémantické hledání je placená akce. Odešlete potvrzený POST, ne GET.",
      );
    }

    if (mode === "hybrid") {
      return jsonError(
        400,
        "hybrid_requires_post",
        "Kombinované hledání je placená akce. Odešlete potvrzený POST, ne GET.",
      );
    }

    if (mode !== "fulltext" && mode !== "") {
      return jsonError(
        400,
        "search_mode_unsupported",
        "V této fázi je dostupné pouze fulltextové hledání.",
      );
    }

    try {
      const page = parsePageParam(url.searchParams.get("page"));
      const query = normalizeSearchQuery(
        url.searchParams.get("q") ?? "",
      );

      if (query === "") {
        return jsonOk(emptySearchResult(query, page));
      }

      return jsonOk(
        await searchNotesFullText(getDb(), { page, query }),
      );
    } catch (error) {
      if (error instanceof SearchQueryError) {
        return jsonError(error.status, error.code, error.message);
      }

      if (error instanceof InvalidPageError) {
        return jsonError(400, "invalid_page", error.message);
      }

      throw error;
    }
  },
});

export const POST = createGuardedJsonRoute<SemanticSearchRequest>({
  maxBytes: 16 * 1024,
  schema: semanticSearchRequestSchema,
  methods: ["POST"],
  rateLimit: SEARCH_SEMANTIC_RATE_LIMIT,
  handler: async ({ data }) => {
    try {
      const query = normalizeSearchQuery(data.q);

      if (query === "") {
        return jsonError(
          400,
          "semantic_query_empty",
          "Zadejte hledaný výraz pro sémantické hledání.",
        );
      }

      if (query.length > SEMANTIC_QUERY_MAX_CODE_UNITS) {
        return jsonError(
          400,
          "search_query_too_long",
          "Hledaný výraz je příliš dlouhý.",
        );
      }

      if (!data.confirmCost) {
        return jsonError(
          400,
          "semantic_cost_not_confirmed",
          "Sémantické hledání vyžaduje výslovné potvrzení placeného volání.",
        );
      }

      const provider = getEmbeddingProviderStatus();

      if (!provider.configured) {
        return jsonError(
          503,
          "embedding_not_configured",
          provider.blockedReason ??
            "Sémantické hledání není nakonfigurované. Fulltextové hledání funguje dál.",
        );
      }

      const db = getDb();
      const estimatedMaxCostUsd = estimateEmbeddingMaxCostUsd([query]);
      const approved = data.approvedMaxCostUsd;

      if (
        approved === undefined ||
        !Number.isFinite(approved) ||
        approved + 1e-9 < estimatedMaxCostUsd
      ) {
        return jsonError(
          409,
          "semantic_cost_not_approved",
          "Potvrzený limit ceny je nižší než odhad tohoto dotazu. Potvrďte nový odhad.",
          undefined,
          { approvedMaxCostUsd: approved, estimatedMaxCostUsd },
        );
      }

      const indexStatus = await getReindexStatus(db, EMBEDDING_MODEL_ID);

      if (indexStatus.chunks.ready === 0) {
        return jsonError(
          409,
          "semantic_index_empty",
          "Sémantický index zatím nemá žádné připravené vektory. Spusťte Reindexovat v panelu Indexace; fulltextové hledání funguje dál.",
        );
      }

      const embedding = getEmbeddingService({
        operation: EMBEDDING_QUERY_OPERATION,
        requestKind: EMBEDDING_QUERY_REQUEST_KIND,
      });
      const embedded = await embedding.embed([query]);
      const vector = embedded.vectors[0];

      if (!vector) {
        return jsonError(
          502,
          "semantic_query_embedding_missing",
          "Poskytovatel nevrátil vektor dotazu. Sémantické hledání se nepodařilo.",
        );
      }

      const index = {
        readyNotes: indexStatus.notes.ready,
        readyChunks: indexStatus.chunks.ready,
        pendingNotes: indexStatus.notes.pending,
        errorNotes: indexStatus.notes.error,
        noContentNotes: indexStatus.notes.noContent,
      };

      if (data.mode === "semantic") {
        const result = await searchNotesSemantic(db, {
          query,
          page: data.page,
          vector,
          modelId: EMBEDDING_MODEL_ID,
        });

        return jsonOk({
          mode: "semantic",
          ...result,
          estimatedMaxCostUsd,
          index,
        });
      }

      const firstTextPage = await searchNotesFullText(db, {
        page: 1,
        query,
      });
      const textItems = [...firstTextPage.items];

      if (firstTextPage.hasNext) {
        const secondTextPage = await searchNotesFullText(db, {
          page: 2,
          query,
        });
        textItems.push(...secondTextPage.items);
      }

      const firstSemanticPage = await searchNotesSemantic(db, {
        query,
        page: 1,
        vector,
        modelId: EMBEDDING_MODEL_ID,
      });
      const semanticItems = [...firstSemanticPage.items];

      if (firstSemanticPage.hasNext) {
        const secondSemanticPage = await searchNotesSemantic(db, {
          query,
          page: 2,
          vector,
          modelId: EMBEDDING_MODEL_ID,
        });
        semanticItems.push(...secondSemanticPage.items);
      }

      const fused = fuseHybridResults(
        textItems.slice(0, HYBRID_COMPONENT_LIMIT),
        semanticItems.slice(0, HYBRID_COMPONENT_LIMIT),
        HYBRID_RESULT_LIMIT,
      );

      return jsonOk({
        mode: "hybrid",
        query,
        page: 1,
        pageSize: HYBRID_RESULT_LIMIT,
        total: fused.length,
        hasNext: false,
        items: fused,
        model: EMBEDDING_MODEL_ID,
        estimatedMaxCostUsd,
        components: {
          textCandidates: Math.min(
            textItems.length,
            HYBRID_COMPONENT_LIMIT,
          ),
          semanticCandidates: Math.min(
            semanticItems.length,
            HYBRID_COMPONENT_LIMIT,
          ),
        },
        index,
      });
    } catch (error) {
      return semanticErrorResponse(error);
    }
  },
});
