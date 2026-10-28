import Link from "next/link";
import type { ReactNode } from "react";

import type { SearchResult } from "@/lib/search/fts";

function snippetNodes(value: string): ReactNode[] {
  const parts = value.split(/(\[\[\[|\]\]\])/u);
  const nodes: ReactNode[] = [];
  let highlighted = false;

  for (const [index, part] of parts.entries()) {
    if (part === "[[[") {
      highlighted = true;
      continue;
    }

    if (part === "]]]") {
      highlighted = false;
      continue;
    }

    nodes.push(
      highlighted ? (
        <mark className="rounded bg-amber-200 px-0.5" key={index}>
          {part}
        </mark>
      ) : (
        <span key={index}>{part}</span>
      ),
    );
  }

  return nodes;
}

function Snippet({ value }: { readonly value: string }) {
  if (value.trim() === "") {
    return <span className="text-stone-500">Bez viditelného textu.</span>;
  }

  return <>{snippetNodes(value)}</>;
}

export interface SearchResultsProps {
  readonly result: SearchResult;
}

export function SearchResults({ result }: SearchResultsProps) {
  if (result.empty) {
    return (
      <div
        className="mt-6 rounded-xl border border-stone-200 bg-white p-6"
        data-testid="search-empty"
      >
        <p className="text-stone-700">
          Zadejte hledaný výraz. Bez dotazu se žádné soukromé poznámky
          nezobrazují.
        </p>
      </div>
    );
  }

  if (result.items.length === 0) {
    return (
      <div
        className="mt-6 rounded-xl border border-stone-200 bg-white p-6"
        data-testid="search-no-results"
      >
        <p className="font-medium text-stone-900">
          Pro „{result.query}“ se nenašla žádná aktivní poznámka.
        </p>
        <p className="mt-1 text-sm text-stone-600">
          Zkuste jiný výraz nebo zkontrolujte diakritiku; hledání je
          bezrozlišování velikosti písmen.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-6" data-testid="search-results">
      <p className="text-sm text-stone-600">
        Nalezeno {result.total.toLocaleString("cs-CZ")} poznámek. Stránka{" "}
        {result.page}.
      </p>
      <ol className="mt-3 space-y-3">
        {result.items.map((item) => (
          <li
            className="rounded-xl border border-stone-200 bg-white p-5"
            data-testid={`search-result-${item.id}`}
            key={item.id}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Link
                className="text-lg font-semibold text-stone-950 underline decoration-stone-300 underline-offset-4 hover:text-emerald-800"
                href={`/notes/${item.id}`}
              >
                {item.title}
              </Link>
              <span className="text-xs text-stone-500">
                {new Date(item.updatedAt).toLocaleDateString("cs-CZ")}
              </span>
            </div>
            <p className="mt-2 text-sm leading-6 text-stone-700">
              <Snippet value={item.snippet} />
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-600">
              {item.category ? (
                <span className="rounded-full bg-stone-100 px-2 py-1">
                  {item.category}
                </span>
              ) : null}
              {item.tags.map((tag) => (
                <span
                  className="rounded-full border border-stone-200 px-2 py-1"
                  key={tag}
                >
                  {tag}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-5 flex gap-3">
        {result.page > 1 ? (
          <Link
            className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100"
            href={`/search?${new URLSearchParams({
              mode: "fulltext",
              page: String(result.page - 1),
              q: result.query,
            }).toString()}`}
          >
            Předchozí stránka
          </Link>
        ) : null}
        {result.hasNext ? (
          <Link
            className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100"
            href={`/search?${new URLSearchParams({
              mode: "fulltext",
              page: String(result.page + 1),
              q: result.query,
            }).toString()}`}
          >
            Další stránka
          </Link>
        ) : null}
      </div>
    </div>
  );
}
