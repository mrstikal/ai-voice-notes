"use client";

import { useCallback, useEffect, useState } from "react";

import { formatUsdAmount } from "@/lib/ai/usage-format";

interface EmbeddingProviderStatusDto {
  readonly configured: boolean;
  readonly model: string;
  readonly dimensions: number;
  readonly liveStatus: "live_unverified" | "verified";
  readonly maxBatchTexts: number;
  readonly checkedAt: string;
  readonly blockedReason: string | null;
}

interface ReindexIndexSummary {
  readonly notes: {
    readonly total: number;
    readonly ready: number;
    readonly pending: number;
    readonly error: number;
    readonly noContent: number;
  };
  readonly chunks: {
    readonly current: number;
    readonly ready: number;
    readonly pending: number;
    readonly error: number;
  };
}

interface ReindexStatusResponse {
  readonly provider: EmbeddingProviderStatusDto;
  readonly index: ReindexIndexSummary;
}

interface EstimateResponse {
  readonly status: "estimate" | "skipped";
  readonly reason?: "ready" | "no_content";
  readonly model: string;
  readonly preparedNotes: number;
  readonly candidateNotes: number;
  readonly candidateChunks: number;
  readonly remainingChunks: number;
  readonly estimatedMaxCostUsd: number;
}

interface CompletedResponse {
  readonly status: "completed";
  readonly model: string;
  readonly preparedNotes: number;
  readonly candidateNotes: number;
  readonly candidateChunks: number;
  readonly readyChunks: number;
  readonly discardedChunks: number;
  readonly staleChunks: number;
  readonly staleNotes: number;
  readonly remainingChunks: number;
  readonly estimatedMaxCostUsd: number;
  readonly promptTokens: number | null;
}

interface ApiErrorPayload {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ApiErrorPayload;

    return (
      payload.error?.message ?? "Požadavek se nepodařilo dokončit."
    );
  } catch {
    return "Požadavek se nepodařilo dokončit.";
  }
}

export function IndexControls() {
  const [summary, setSummary] = useState<ReindexStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [running, setRunning] = useState(false);
  const [estimate, setEstimate] = useState<EstimateResponse | null>(null);
  const [completed, setCompleted] = useState<CompletedResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/search/reindex", {
        cache: "no-store",
      });

      if (!response.ok) {
        setError(await readError(response));
        return;
      }

      setSummary((await response.json()) as ReindexStatusResponse);
    } catch {
      setError("Stav indexu se nepodařilo načíst.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      await Promise.resolve();

      if (!cancelled) {
        await refresh();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const provider = summary?.provider ?? null;
  const blocked = provider !== null && !provider.configured;
  const busy = estimating || running;

  async function requestEstimate() {
    setEstimating(true);
    setError(null);
    setNotice(null);
    setCompleted(null);
    setEstimate(null);

    try {
      const response = await fetch("/api/search/reindex", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmCost: false }),
      });

      if (!response.ok) {
        setError(await readError(response));
        return;
      }

      const payload = (await response.json()) as EstimateResponse;
      setEstimate(payload);
      await refresh();

      if (payload.status === "skipped") {
        setNotice(
          payload.reason === "no_content"
            ? "Žádná aktivní poznámka nemá text k indexaci."
            : "Všechny aktuální chunky už mají vektory pro tento model. Placené volání se neprovádí.",
        );
      }
    } catch {
      setError("Odhad indexace se nepodařilo načíst.");
    } finally {
      setEstimating(false);
    }
  }

  async function confirmReindex() {
    if (!estimate || estimate.status !== "estimate") {
      return;
    }

    setRunning(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/search/reindex", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmCost: true,
          approvedMaxCostUsd: estimate.estimatedMaxCostUsd,
        }),
      });

      if (!response.ok) {
        setError(await readError(response));
        await refresh();
        return;
      }

      const payload = (await response.json()) as
        | CompletedResponse
        | EstimateResponse;

      if (payload.status === "completed") {
        setCompleted(payload);
        setEstimate(null);
        await refresh();
      } else {
        setEstimate(payload);
      }
    } catch {
      setError("Reindexaci se nepodařilo dokončit.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <section
      aria-labelledby="index-controls-heading"
      className="mt-6 rounded-2xl border border-stone-200 bg-white p-5"
      data-testid="index-controls"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            className="text-lg font-semibold text-stone-950"
            id="index-controls-heading"
          >
            Indexace pro vyhledávání
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-stone-600">
            Fulltextové hledání funguje bez indexace. Vektory pro sémantické
            hledání vznikají jen na explicitní kliknutí, protože odesílají text
            chunků do OpenRouteru. Cena je místní odhad, ne limit poskytovatele.
          </p>
        </div>
        <button
          className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={loading || busy}
          onClick={() => void refresh()}
          type="button"
        >
          Obnovit stav
        </button>
      </div>

      {loading ? (
        <p className="mt-3 text-sm text-stone-500">Načítám stav indexu…</p>
      ) : summary ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
            <p className="font-semibold text-stone-900">Poznámky</p>
            <p className="mt-1">
              Připraveno {summary.index.notes.ready} · Čeká{" "}
              {summary.index.notes.pending} · Chyba{" "}
              {summary.index.notes.error} · Bez textu{" "}
              {summary.index.notes.noContent}
            </p>
          </div>
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
            <p className="font-semibold text-stone-900">Chunky aktuální verze</p>
            <p className="mt-1">
              Připraveno {summary.index.chunks.ready} · Čeká{" "}
              {summary.index.chunks.pending} · Chyba{" "}
              {summary.index.chunks.error}
            </p>
          </div>
        </div>
      ) : null}

      {provider ? (
        <p className="mt-3 text-xs leading-5 text-stone-500">
          OpenRouter · {provider.model} · {provider.dimensions} dimenzí ·{" "}
          {provider.liveStatus === "verified"
            ? "ověřeno živým voláním"
            : "live neověřeno"}{" "}
          · max {provider.maxBatchTexts} chunků na dávku. Ověřeno{" "}
          {provider.checkedAt}.
        </p>
      ) : null}

      {blocked ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          {provider?.blockedReason ??
            "Semantické indexování není nakonfigurované. Fulltextové hledání funguje dál."}
        </p>
      ) : null}

      {error ? (
        <p
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
          data-testid="index-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {notice ? (
        <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950">
          {notice}
        </p>
      ) : null}

      <div className="mt-4">
        <button
          className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
          data-testid="index-reindex"
          disabled={busy || blocked || loading}
          onClick={() => void requestEstimate()}
          type="button"
        >
          {estimating ? "Zjišťuji rozsah…" : "Reindexovat"}
        </button>
        <span className="ml-2 text-xs leading-5 text-stone-500">
          Nejdřív se zobrazí odhad; placené volání proběhne až po potvrzení.
        </span>
      </div>

      {estimate && estimate.status === "estimate" ? (
        <div
          className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950"
          data-testid="index-estimate"
        >
          <p className="font-semibold">Odhad dávky</p>
          <p className="mt-1">
            {estimate.candidateNotes} poznámek · {estimate.candidateChunks}{" "}
            chunků · odhad až{" "}
            {formatUsdAmount(String(estimate.estimatedMaxCostUsd))}
            {estimate.remainingChunks > 0
              ? ` · dalších ${estimate.remainingChunks} chunků zůstane na nové kliknutí`
              : ""}
            .
          </p>
          <p className="mt-1 text-xs leading-5">
            Odesílá se pouze text těchto chunků. Dávka je omezena na 3
            poznámky a 20 chunků; další dávka vyžaduje nové potvrzení.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
              data-testid="index-confirm"
              disabled={running}
              onClick={() => void confirmReindex()}
              type="button"
            >
              {running ? "Indexuji…" : "Potvrdit a reindexovat"}
            </button>
            <button
              className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100"
              disabled={running}
              onClick={() => {
                setEstimate(null);
                setError(null);
              }}
              type="button"
            >
              Zrušit
            </button>
          </div>
        </div>
      ) : null}

      {completed ? (
        <div
          className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950"
          data-testid="index-completed"
        >
          <p className="font-semibold">Reindexace dokončena</p>
          <p className="mt-1">
            Připraveno {completed.readyChunks} chunků v{" "}
            {completed.candidateNotes} poznámkách.
            {completed.staleNotes > 0
              ? ` ${completed.staleNotes} poznámek se mezitím změnilo; jejich ${completed.staleChunks} výsledků bylo zahozeno a zůstává Čeká/Chyba.`
              : ""}
            {completed.discardedChunks > 0
              ? ` ${completed.discardedChunks} chunků už neexistovalo a bylo přeskočeno.`
              : ""}
            {completed.remainingChunks > 0
              ? ` Zbývá ${completed.remainingChunks} chunků; spusťte další dávku novým kliknutím.`
              : ""}
          </p>
        </div>
      ) : null}
    </section>
  );
}
