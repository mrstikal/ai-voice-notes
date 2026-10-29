"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { formatUsdAmount } from "@/lib/ai/usage-format";
import type { HybridSearchResponse } from "@/lib/search/hybrid";

export interface HybridProviderInfo {
  readonly configured: boolean;
  readonly model: string;
  readonly dimensions: number;
  readonly liveStatus: "live_unverified" | "verified";
  readonly blockedReason: string | null;
}

interface HybridSearchProps {
  readonly initialQuery: string;
  readonly provider: HybridProviderInfo;
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

    return payload.error?.message ?? "Kombinované hledání se nepodařilo.";
  } catch {
    return "Kombinované hledání se nepodařilo.";
  }
}

export function HybridSearch({
  initialQuery,
  provider,
  approvalUsd,
}: HybridSearchProps) {
  const [query, setQuery] = useState(initialQuery);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<HybridSearchResponse | null>(null);

  const blocked = !provider.configured;
  const canSubmit =
    !blocked && !loading && confirmed && query.trim() !== "";

  async function runSearch() {
    const trimmed = query.trim();

    if (trimmed === "") {
      setError("Zadejte hledaný výraz.");
      return;
    }

    if (!confirmed) {
      setError("Potvrďte placené kombinované hledání.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "hybrid",
          q: trimmed,
          page: 1,
          confirmCost: true,
          approvedMaxCostUsd: approvalUsd,
        }),
      });

      if (!response.ok) {
        setResult(null);
        setError(await readError(response));
        return;
      }

      const payload = (await response.json()) as HybridSearchResponse;
      setResult(payload);

      const params = new URLSearchParams({
        mode: "hybrid",
        q: trimmed,
      });

      window.history.replaceState(null, "", `/search?${params.toString()}`);
    } catch {
      setResult(null);
      setError("Kombinované hledání se nepodařilo dokončit.");
    } finally {
      setLoading(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runSearch();
  }

  const incompleteIndex =
    result !== null &&
    result.index.pendingNotes + result.index.errorNotes > 0;

  return (
    <section
      className="mt-6 rounded-2xl border border-stone-200 bg-white p-5"
      data-testid="hybrid-search"
    >
      <h2 className="text-lg font-semibold text-stone-950">
        Kombinované hledání
      </h2>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-stone-600">
        Spojuje pořadí fulltextového a významového hledání pomocí reciprocal
        rank fusion. Textová část je zdarma; placené je jedno embedding volání
        dotazu. Pořadí se počítá z nejlepších 20 textových a 20 významových
        poznámek.
      </p>

      {blocked ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          {provider.blockedReason ??
            "Kombinované hledání není nakonfigurované. Fulltextové hledání funguje dál."}
        </p>
      ) : (
        <>
          <form className="mt-4" onSubmit={submit}>
            <label className="block text-sm font-medium text-stone-700">
              Hledaný výraz
              <input
                className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900"
                data-testid="hybrid-query"
                maxLength={2_000}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setResult(null);
                  setError(null);
                }}
                placeholder="například migrace databáze"
                type="search"
                value={query}
              />
            </label>
            <label className="mt-3 flex items-start gap-2 text-sm text-stone-700">
              <input
                checked={confirmed}
                className="mt-1"
                data-testid="hybrid-confirm"
                onChange={(event) => {
                  setConfirmed(event.target.checked);
                  setError(null);
                }}
                type="checkbox"
              />
              <span>
                Potvrzuji placené kombinované hledání. Odesílá se pouze text
                dotazu; jedno embedding volání, odhad nejvýše{" "}
                {formatUsdAmount(String(approvalUsd))}. Cena se zaznamená do
                evidence využití.
              </span>
            </label>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
                data-testid="hybrid-submit"
                disabled={!canSubmit}
                type="submit"
              >
                {loading ? "Hledám…" : "Hledat kombinovaně"}
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
              data-testid="hybrid-error"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          {incompleteIndex ? (
            <p
              className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"
              data-testid="hybrid-index-notice"
            >
              Index není úplný: {result.index.pendingNotes} poznámek čeká a{" "}
              {result.index.errorNotes} má chybu. Výsledky nemusí obsahovat
              všechny poznámky; chybějící vektory doplníte v panelu Indexace.
            </p>
          ) : null}

          {result ? (
            <div className="mt-5" data-testid="hybrid-results">
              {result.items.length === 0 ? (
                <div
                  className="rounded-xl border border-stone-200 bg-stone-50 p-5"
                  data-testid="hybrid-empty"
                >
                  <p className="font-medium text-stone-900">
                    Pro „{result.query}“ se v kombinovaném pořadí nenašla žádná
                    poznámka.
                  </p>
                  <p className="mt-1 text-sm text-stone-600">
                    Zkuste jiný výraz nebo nejprve doplňte index. Hledání
                    nevrátilo falešný úspěch.
                  </p>
                </div>
              ) : (
                <>
                  <p className="text-sm text-stone-600">
                    Pro „{result.query}“ složeno {result.total} poznámek z{" "}
                    {result.components.textCandidates} textových a{" "}
                    {result.components.semanticCandidates} významových
                    kandidátů. Rezervace nejvýše{" "}
                    {formatUsdAmount(String(result.estimatedMaxCostUsd))}.
                  </p>
                  <ol className="mt-3 space-y-3">
                    {result.items.map((item) => (
                      <li
                        className="rounded-xl border border-stone-200 bg-white p-5"
                        data-testid={`hybrid-result-${item.id}`}
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
                        <div
                          className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-600"
                          data-testid={`hybrid-ranks-${item.id}`}
                        >
                          {item.textRank !== null ? (
                            <span className="rounded-full border border-stone-300 bg-stone-50 px-2 py-1">
                              Textově #{item.textRank}
                            </span>
                          ) : null}
                          {item.semanticRank !== null ? (
                            <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-1 text-emerald-900">
                              Významově #{item.semanticRank}
                            </span>
                          ) : null}
                          {item.textRank === null ? (
                            <span className="rounded-full bg-stone-100 px-2 py-1">
                              pouze významově
                            </span>
                          ) : null}
                          {item.semanticRank === null ? (
                            <span className="rounded-full bg-stone-100 px-2 py-1">
                              pouze textově
                            </span>
                          ) : null}
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
                  <p className="mt-3 text-xs leading-5 text-stone-500">
                    Další kombinované hledání je nové placené embedding volání.
                    Fulltextové hledání zůstává zdarma.
                  </p>
                </>
              )}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
