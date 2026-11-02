import type { Metadata } from "next";
import Link from "next/link";

import { AskNotes } from "@/components/search/AskNotes";
import { HybridSearch } from "@/components/search/HybridSearch";
import { IndexControls } from "@/components/search/IndexControls";
import { SearchResults } from "@/components/search/SearchResults";
import { SemanticSearch } from "@/components/search/SemanticSearch";
import { getDb } from "@/lib/db/client";
import {
  InvalidPageError,
  parsePageParam,
} from "@/lib/notes/service";
import {
  SearchQueryError,
  emptySearchResult,
  normalizeSearchQuery,
  searchNotesFullText,
} from "@/lib/search/fts";
import {
  EMBEDDING_MODEL_ID,
  getEmbeddingProviderStatus,
} from "@/lib/search/embeddings";
import { getLlmProviderStatus } from "@/lib/ai/structured";
import { GROUNDING_LLM_MAX_COST_USD } from "@/lib/search/grounding";
import { getReindexStatus } from "@/lib/search/reindex";
import { getIndexStatuses } from "@/lib/search/index-state";
import { SEMANTIC_QUERY_APPROVAL_USD } from "@/lib/search/semantic";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Vyhledávání",
};

interface SearchPageProps {
  readonly searchParams: Promise<{
    mode?: string | string[];
    page?: string | string[];
    q?: string | string[];
  }>;
}

function firstValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  const mode = firstValue(params.mode);
  const rawQuery = firstValue(params.q);
  const semanticMode = mode === "semantic";
  const hybridMode = mode === "hybrid";
  const fulltextMode = !semanticMode && !hybridMode;
  let query = rawQuery;
  let result = emptySearchResult("", 1);
  let error: string | null = null;

  if (
    mode !== "" &&
    mode !== "fulltext" &&
    !semanticMode &&
    !hybridMode
  ) {
    error = "Neznámý režim hledání.";
  } else if (fulltextMode) {
    try {
      const rawPage = firstValue(params.page);
      const page = parsePageParam(rawPage === "" ? undefined : rawPage);
      query = normalizeSearchQuery(rawQuery);
      result =
        query === ""
          ? emptySearchResult(query, page)
          : await searchNotesFullText(getDb(), { page, query });
    } catch (caught) {
      if (caught instanceof SearchQueryError) {
        error = caught.message;
      } else if (caught instanceof InvalidPageError) {
        error = caught.message;
      } else {
        throw caught;
      }
    }
  }

  const fulltextHref = `/search?${new URLSearchParams({
    mode: "fulltext",
    ...(rawQuery === "" ? {} : { q: rawQuery }),
  }).toString()}`;
  const semanticHref = `/search?${new URLSearchParams({
    mode: "semantic",
    ...(rawQuery === "" ? {} : { q: rawQuery }),
  }).toString()}`;
  const hybridHref = `/search?${new URLSearchParams({
    mode: "hybrid",
    ...(rawQuery === "" ? {} : { q: rawQuery }),
  }).toString()}`;
  const askDb = getDb();
  const llmStatus = getLlmProviderStatus();
  const embeddingStatus = getEmbeddingProviderStatus();
  const askIndexStatus = await getReindexStatus(askDb, EMBEDDING_MODEL_ID);
  const askSemanticAvailable =
    askIndexStatus.chunks.ready > 0 && embeddingStatus.configured;
  const askApprovalUsd =
    Math.ceil(
      (GROUNDING_LLM_MAX_COST_USD + SEMANTIC_QUERY_APPROVAL_USD) * 1e6,
    ) / 1e6;

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-800">
        Knihovna
      </p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight text-stone-950">
        Vyhledávání
      </h1>
      <p className="mt-3 max-w-2xl leading-7 text-stone-600">
        {semanticMode
          ? "Sémantické hledání podle významu je placená akce s výslovným potvrzením. Fulltextové hledání zůstává zdarma a bez klíče."
          : hybridMode
            ? "Kombinované hledání spojuje textové a významové pořadí. Textová část je zdarma; embedding dotazu je placený a vyžaduje potvrzení."
            : "Fulltextové hledání v názvu, viditelném textu a tazích aktivních poznámek. Hledání nerozlišuje velikost písmen ani diakritiku."}
      </p>

      <nav aria-label="Režim hledání" className="mt-6 flex gap-2">
        <Link
          aria-current={fulltextMode ? "page" : undefined}
          className={`rounded-lg px-3 py-2 text-sm font-semibold ${
            fulltextMode
              ? "bg-emerald-800 text-white"
              : "border border-stone-300 text-stone-800 hover:bg-stone-100"
          }`}
          href={fulltextHref}
        >
          Textově
        </Link>
        <Link
          aria-current={semanticMode ? "page" : undefined}
          className={`rounded-lg px-3 py-2 text-sm font-semibold ${
            semanticMode
              ? "bg-emerald-800 text-white"
              : "border border-stone-300 text-stone-800 hover:bg-stone-100"
          }`}
          href={semanticHref}
        >
          Významově
        </Link>
        <Link
          aria-current={hybridMode ? "page" : undefined}
          className={`rounded-lg px-3 py-2 text-sm font-semibold ${
            hybridMode
              ? "bg-emerald-800 text-white"
              : "border border-stone-300 text-stone-800 hover:bg-stone-100"
          }`}
          href={hybridHref}
        >
          Kombinovaně
        </Link>
      </nav>

      {semanticMode || hybridMode ? (
        <AskNotes
          provider={{
            configured: llmStatus.configured,
            model: llmStatus.model,
            blockedReason: llmStatus.blockedReason,
            llmMaxUsd: GROUNDING_LLM_MAX_COST_USD,
            approvalUsd: askApprovalUsd,
            semanticAvailable: askSemanticAvailable,
            embeddingModel: embeddingStatus.model,
            readyChunks: askIndexStatus.chunks.ready,
          }}
        />
      ) : null}

      {semanticMode ? (
        <SemanticSearch
          approvalUsd={SEMANTIC_QUERY_APPROVAL_USD}
          initialQuery={rawQuery}
          provider={getEmbeddingProviderStatus()}
        />
      ) : hybridMode ? (
        <HybridSearch
          approvalUsd={SEMANTIC_QUERY_APPROVAL_USD}
          initialQuery={rawQuery}
          provider={getEmbeddingProviderStatus()}
        />
      ) : (
        <>
          <form
            action="/search"
            className="mt-6 flex flex-wrap gap-2"
            method="get"
          >
            <input name="mode" type="hidden" value="fulltext" />
            <label className="min-w-56 flex-1 text-sm font-medium text-stone-700">
              Hledaný výraz
              <input
                className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900"
                defaultValue={query}
                name="q"
                placeholder="například databáze nebo “plán migrace”"
                type="search"
              />
            </label>
            <button
              className="self-end rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900"
              type="submit"
            >
              Hledat
            </button>
            {query ? (
              <Link
                className="self-end rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100"
                href="/search"
              >
                Zrušit
              </Link>
            ) : null}
          </form>

          {error ? (
            <p
              className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
              data-testid="search-error"
              role="alert"
            >
              {error}
            </p>
          ) : (
            <SearchResults
              indexStatuses={
                result.items.length === 0
                  ? undefined
                  : await getIndexStatuses(
                      getDb(),
                      result.items.map((item) => item.id),
                    )
              }
              result={result}
            />
          )}
        </>
      )}

      <IndexControls />
    </div>
  );
}
