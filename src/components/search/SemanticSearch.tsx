"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { formatUsdAmount } from "@/lib/ai/usage-format";
import type { SemanticSearchResponse } from "@/lib/search/semantic";

export interface SemanticProviderInfo {
  readonly configured: boolean;
  readonly model: string;
  readonly dimensions: number;
  readonly liveStatus: "live_unverified" | "verified";
  readonly blockedReason: string | null;
}

interface SemanticSearchProps {
  readonly initialQuery: string;
  readonly provider: SemanticProviderInfo;
  readonly approvalUsd: number;
}

interface ApiErrorPayload {
  readonly error?: {
    readonly message?: string;
  };
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ApiErrorPayload;

    return payload.error?.message ?? "Sémantické hledání se nepodařilo.";
  } catch {
    return "Sémantické hledání se nepodařilo.";
  }
}

export function SemanticSearch({
  initialQuery,
  provider,
  approvalUsd,
}: SemanticSearchProps) {
  const [query, setQuery] = useState(initialQuery);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SemanticSearchResponse | null>(null);
  const [page, setPage] = useState(1);

  const blocked = !provider.configured;
  const canSubmit =
    !blocked && !loading && confirmed && query.trim() !== "";

  async function runSearch(
    nextPage: number,
    searchQuery: string = query.trim(),
  ) {
    const trimmed = searchQuery.trim();

    if (trimmed === "") {
      setError("Zadejte hledaný výraz.");
      return;
    }

    if (!confirmed) {
      setError("Potvrďte placené sémantické hledání.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "semantic",
          q: trimmed,
          page: nextPage,
          confirmCost: true,
          approvedMaxCostUsd: approvalUsd,
        }),
      });

      if (!response.ok) {
        setResult(null);
        setError(await readError(response));
        return;
      }

      const payload = (await response.json()) as SemanticSearchResponse;
      setResult(payload);
      setPage(nextPage);

      const params = new URLSearchParams({
        mode: "semantic",
        q: trimmed,
      });

      if (nextPage > 1) {
        params.set("page", String(nextPage));
      }

      window.history.replaceState(null, "", `/search?${params.toString()}`);
    } catch {
      setResult(null);
      setError("Sémantické hledání se nepodařilo dokončit.");
    } finally {
      setLoading(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runSearch(1);
  }

  const incompleteIndex =
    result !== null &&
    result.index.pendingNotes + result.index.errorNotes > 0;

  return (
    <section
      className="mt-6 rounded-2xl border border-stone-200 bg-white p-5"
      data-testid="semantic-search"
    >
      <h2 className="text-lg font-semibold text-stone-950">
        Významové hledání
      </h2>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-stone-600">
        Hledá podle významu mezi poznámkami, které už mají připravené vektory.
        Každé hledání je placené: nejprve se embeduje dotaz a teprve potom se
        počítá cosine vzdálenost v databázi. Fulltextové hledání zůstává zdarma.
      </p>

      {blocked ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          {provider.blockedReason ??
            "Sémantické hledání není nakonfigurované. Fulltextové hledání funguje dál."}
        </p>
      ) : (
        <>
          <form className="mt-4" onSubmit={submit}>
            <label className="block text-sm font-medium text-stone-700">
              Hledaný význam
              <input
                className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900"
                data-testid="semantic-query"
                maxLength={2_000}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setResult(null);
                  setError(null);
                }}
                placeholder="například plán migrace databáze"
                type="search"
                value={query}
              />
            </label>
            <label className="mt-3 flex items-start gap-2 text-sm text-stone-700">
              <input
                checked={confirmed}
                className="mt-1"
                data-testid="semantic-confirm"
                onChange={(event) => {
                  setConfirmed(event.target.checked);
                  setError(null);
                }}
                type="checkbox"
              />
              <span>
                Potvrzuji placené sémantické hledání. Odesílá se pouze text
                dotazu; jedno embedding volání, odhad nejvýše{" "}
                {formatUsdAmount(String(approvalUsd))}. Cena se zaznamená do
                evidence využití.
              </span>
            </label>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
                data-testid="semantic-submit"
                disabled={!canSubmit}
                type="submit"
              >
                {loading ? "Hledám…" : "Hledat významově"}
              </button>
              <span className="text-xs leading-5 text-stone-500">
                {provider.model} · {provider.dimensions} dimenzí ·{" "}
                {provider.liveStatus === "verified"
                  ? "ověřeno živým voláním"
                  : "live neověřeno"}
              </span>
            </div>
          </form>

          {error ? (
            <p
              className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
              data-testid="semantic-error"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          {incompleteIndex ? (
            <p
              className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"
              data-testid="semantic-index-notice"
            >
              Index není úplný: {result.index.pendingNotes} poznámek čeká a{" "}
              {result.index.errorNotes} má chybu. Výsledky nemusí obsahovat
              všechny poznámky; chybějící vektory doplníte v panelu Indexace.
            </p>
          ) : null}

          {result ? (
            <div className="mt-5" data-testid="semantic-results">
              {result.items.length === 0 ? (
                <div
                  className="rounded-xl border border-stone-200 bg-stone-50 p-5"
                  data-testid="semantic-empty"
                >
                  <p className="font-medium text-stone-900">
                    Pro „{result.query}“ se v připraveném sémantickém indexu
                    nenašla žádná poznámka.
                  </p>
                  <p className="mt-1 text-sm text-stone-600">
                    Zkuste jiný význam nebo nejprve doplňte index. Hledání
                    nevrátilo falešný úspěch.
                  </p>
                </div>
              ) : (
                <>
                  <p className="text-sm text-stone-600">
                    Pro „{result.query}“ nalezeno{" "}
                    {result.total.toLocaleString("cs-CZ")} poznámek podle
                    nejbližšího chunku. Stránka {result.page}, zobrazeno{" "}
                    {result.items.length}. Rezervace nejvýše{" "}
                    {formatUsdAmount(String(result.estimatedMaxCostUsd))}.
                  </p>
                  <ol className="mt-3 space-y-3">
                    {result.items.map((item) => (
                      <li
                        className="rounded-xl border border-stone-200 bg-white p-5"
                        data-testid={`semantic-result-${item.id}`}
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
                            {new Date(item.updatedAt).toLocaleDateString(
                              "cs-CZ",
                            )}
                          </span>
                        </div>
                        <p className="mt-2 text-sm leading-6 text-stone-700">
                          {item.excerpt}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-600">
                          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-900">
                            Připravený vektor
                          </span>
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
                  {result.hasNext ? (
                    <div className="mt-4">
                      <button
                        className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
                        data-testid="semantic-next"
                        disabled={loading || !confirmed}
                        onClick={() => {
                          if (result) {
                            void runSearch(page + 1, result.query);
                          }
                        }}
                        type="button"
                      >
                        Další stránka (další placené volání)
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
