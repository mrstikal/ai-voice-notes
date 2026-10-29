"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { formatUsdAmount } from "@/lib/ai/usage-format";

export interface AskProviderInfo {
  readonly configured: boolean;
  readonly model: string;
  readonly blockedReason: string | null;
  readonly llmMaxUsd: number;
  readonly approvalUsd: number;
  readonly semanticAvailable: boolean;
  readonly embeddingModel: string;
  readonly readyChunks: number;
}

interface AskNotesProps {
  readonly provider: AskProviderInfo;
}

interface AskClaimCitation {
  readonly noteId: string;
  readonly chunkId: string;
  readonly noteTitle: string;
  readonly noteVersion: number;
}

interface AskClaim {
  readonly text: string;
  readonly citations: readonly AskClaimCitation[];
}

interface AskCost {
  readonly approvedMaxCostUsd: number;
  readonly queryEmbeddingUsd: number;
  readonly llmUsd: number;
  readonly totalEstimatedUsd: number;
}

interface AskResponse {
  readonly status: "answered" | "insufficient_evidence";
  readonly answer: string;
  readonly retrieval: "hybrid" | "text_only";
  readonly claims: readonly AskClaim[];
  readonly sources: readonly unknown[];
  readonly cost: AskCost;
  readonly manualFactualReview: "required";
  readonly approvalCeilingUsd: number;
}

interface ApiErrorPayload {
  readonly error?: {
    readonly message?: string;
  };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ApiErrorPayload;

    return payload.error?.message ?? "Odpověď z poznámek se nepodařilo vytvořit.";
  } catch {
    return "Odpověď z poznámek se nepodařilo vytvořit.";
  }
}

function hasInvalidCitations(result: AskResponse): boolean {
  return result.claims.some(
    (claim) =>
      claim.citations.length === 0 ||
      claim.citations.some(
        (citation) =>
          !UUID_PATTERN.test(citation.noteId) ||
          !UUID_PATTERN.test(citation.chunkId),
      ),
  );
}

export function AskNotes({ provider }: AskNotesProps) {
  const [question, setQuestion] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [answeredQuestion, setAnsweredQuestion] = useState<string | null>(
    null,
  );

  const blocked = !provider.configured;
  const canSubmit =
    !blocked &&
    !loading &&
    confirmed &&
    question.trim() !== "";
  const invalidCitations =
    result !== null &&
    result.status === "answered" &&
    hasInvalidCitations(result);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = question.trim();

    if (trimmed === "") {
      setError("Zadejte otázku, na kterou mají poznámky odpovědět.");
      return;
    }

    if (!confirmed) {
      setError("Potvrďte placenou odpověď z poznámek.");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    setAnsweredQuestion(trimmed);

    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: trimmed,
          confirmCost: true,
          approvedMaxCostUsd: provider.approvalUsd,
        }),
      });

      if (!response.ok) {
        setAnsweredQuestion(null);
        setError(await readError(response));
        return;
      }

      setResult((await response.json()) as AskResponse);
    } catch {
      setAnsweredQuestion(null);
      setError("Odpověď z poznámek se nepodařilo dokončit.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section
      aria-labelledby="ask-notes-heading"
      className="mt-6 rounded-2xl border border-stone-200 bg-white p-5"
      data-testid="ask-notes"
    >
      <h2
        className="text-lg font-semibold text-stone-950"
        id="ask-notes-heading"
      >
        Zeptat se poznámek
      </h2>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-stone-600">
        Odpověď vzniká pouze z ověřených tvrzení s citacemi aktuálních chunků.
        Citace dokazují zdroj, ne věcnou správnost; odpověď je potřeba ručně
        zkontrolovat. Fulltextové hledání funguje i bez LLM klíče.
      </p>

      {blocked ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          {provider.blockedReason ??
            "Grounded odpovědi nejsou nakonfigurované. Fulltextové hledání funguje dál."}
        </p>
      ) : (
        <>
          <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs leading-5 text-stone-700">
            <p>
              LLM: {provider.model} · max.{" "}
              {formatUsdAmount(String(provider.llmMaxUsd))}
              {provider.semanticAvailable
                ? ` + dotazový embedding (${provider.embeddingModel}) max. ${formatUsdAmount(
                    String(provider.approvalUsd - provider.llmMaxUsd),
                  )}`
                : provider.readyChunks > 0
                  ? " · sémantické hledání je zablokované konfigurací, použije se pouze fulltext"
                  : " · připravené vektory nejsou, použije se pouze fulltext"}
              .
            </p>
            <p>
              Strop schválení:{" "}
              {formatUsdAmount(String(provider.approvalUsd))}. Cena LLM může být
              v evidenci <strong>Neznámá</strong>, pokud ji provider nehlásí.
              {provider.semanticAvailable
                ? ` Připravených chunků: ${provider.readyChunks}.`
                : provider.readyChunks > 0
                  ? " Sémantické hledání je zablokované konfigurací; fulltext funguje dál."
                  : " Sémantické hledání zůstává dostupné v režimu Významově."}{" "}
              Strop vždy zahrnuje rezervu na případný dotazový embedding;
              skutečný režim se řídí stavem indexu v okamžiku odeslání.
            </p>
          </div>

          <form className="mt-4" onSubmit={submit}>
            <label className="block text-sm font-medium text-stone-700">
              Otázka
              <input
                className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900"
                data-testid="ask-question"
                maxLength={2_000}
                disabled={loading}
                onChange={(event) => {
                  setQuestion(event.target.value);
                  setResult(null);
                  setAnsweredQuestion(null);
                  setError(null);
                }}
                placeholder="například co je v poznámkách o migraci PostgreSQL?"
                type="search"
                value={question}
              />
            </label>
            <label className="mt-3 flex items-start gap-2 text-sm text-stone-700">
              <input
                checked={confirmed}
                className="mt-1"
                data-testid="ask-confirm"
                disabled={loading}
                onChange={(event) => {
                  setConfirmed(event.target.checked);
                  setError(null);
                }}
                type="checkbox"
              />
              <span>
                Potvrzuji placenou odpověď z poznámek. Odesílá se otázka a
                omezené texty aktuálních chunků do OpenRouteru; strop ceny je
                uvedený výše.
              </span>
            </label>
            <div className="mt-3">
              <button
                className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
                data-testid="ask-submit"
                disabled={!canSubmit}
                type="submit"
              >
                {loading ? "Odpovídám…" : "Odpovědět z poznámek"}
              </button>
            </div>
          </form>

          {error ? (
            <div
              className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
              data-testid="ask-error"
              role="alert"
            >
              <p>{error}</p>
              <button
                className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-900 hover:bg-red-100"
                onClick={() => window.location.reload()}
                type="button"
              >
                Obnovit odhad
              </button>
            </div>
          ) : null}

          {result?.status === "insufficient_evidence" ? (
            <div
              className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
              data-testid="ask-insufficient"
            >
              <p className="font-semibold">
                Nedostatek podkladů
                {answeredQuestion ? ` pro „${answeredQuestion}“` : ""}
              </p>
              <p className="mt-1">{result.answer}</p>
              <p className="mt-1 text-xs leading-5">
                {result.retrieval === "text_only"
                  ? "Použito bylo pouze fulltextové hledání."
                  : "Použito bylo kombinované hledání."}{" "}
                Odpověď nebyla vymyšlena.
              </p>
            </div>
          ) : null}

          {result?.status === "answered" && invalidCitations ? (
            <p
              className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
              data-testid="ask-error"
              role="alert"
            >
              Odpověď obsahuje citaci, kterou nelze bezpečně otevřít. Odkaz
              nebyl zobrazen.
            </p>
          ) : null}

          {result?.status === "answered" && !invalidCitations ? (
            <div className="mt-4" data-testid="ask-results">
              <p className="text-sm font-semibold text-stone-900">
                Odpověď z poznámek
                {answeredQuestion ? ` na „${answeredQuestion}“` : ""}
              </p>
              <ol className="mt-2 space-y-3">
                {result.claims.map((claim, claimIndex) => (
                  <li
                    className="rounded-xl border border-stone-200 bg-stone-50 p-4"
                    data-testid={`ask-claim-${claimIndex}`}
                    key={`${claimIndex}-${claim.text}`}
                  >
                    <p className="text-sm leading-6 text-stone-900">
                      {claim.text}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-600">
                      <span className="font-medium text-stone-700">
                        Zdroje:
                      </span>
                      {claim.citations.map((citation) => (
                        <span
                          className="inline-flex flex-wrap items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-950"
                          key={`${citation.noteId}:${citation.chunkId}`}
                        >
                          <Link
                            aria-label={`${citation.noteTitle}, chunk ${citation.chunkId}`}
                            className="font-semibold underline decoration-emerald-300 underline-offset-2"
                            data-testid={`ask-citation-${citation.chunkId}`}
                            href={`/notes/${citation.noteId}`}
                          >
                            {citation.noteTitle}
                          </Link>
                          <span
                            className="text-[0.7rem] text-emerald-800"
                            title={citation.chunkId}
                          >
                            chunk {citation.chunkId.slice(0, 8)}…
                          </span>
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-xs leading-5 text-stone-500">
                Odhad: dotazový embedding{" "}
                {formatUsdAmount(String(result.cost.queryEmbeddingUsd))}, LLM{" "}
                {formatUsdAmount(String(result.cost.llmUsd))}, celkem{" "}
                {formatUsdAmount(String(result.cost.totalEstimatedUsd))}; strop{" "}
                {formatUsdAmount(String(result.approvalCeilingUsd))}. Cena LLM
                může být v evidenci Neznámá. Věcnou správnost je nutné ověřit
                ručně.
              </p>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
