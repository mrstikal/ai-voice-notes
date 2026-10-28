import type { Metadata } from "next";
import Link from "next/link";

import { SearchResults } from "@/components/search/SearchResults";
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
import { getIndexStatuses } from "@/lib/search/index-state";

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
  let query = rawQuery;
  let result = emptySearchResult("", 1);
  let error: string | null = null;

  if (mode !== "" && mode !== "fulltext") {
    error = "V této fázi je dostupné pouze fulltextové hledání.";
  } else {
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


  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-800">
        Knihovna
      </p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight text-stone-950">
        Vyhledávání
      </h1>
      <p className="mt-3 max-w-2xl leading-7 text-stone-600">
        Fulltextové hledání v názvu, viditelném textu a tazích aktivních
        poznámek. Hledání nerozlišuje velikost písmen ani diakritiku.
      </p>

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
    </div>
  );
}
