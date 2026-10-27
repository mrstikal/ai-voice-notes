"use client";

import { useRef, useState } from "react";

import {
  SUMMARY_MAX_SOURCE_GRAPHEMES,
  type SummaryArtifact,
} from "@/lib/ai/summary-types";
import type { LlmProviderStatus } from "@/lib/ai/structured";
import { formatUsdAmount } from "@/lib/ai/usage-format";
import type { NoteDetail } from "@/lib/notes/client";
import { countGraphemes } from "@/lib/notes/limits";
import {
  ProposalApiError,
  confirmEditProposal,
  createEditProposal,
  rejectEditProposal,
  type EditProposal,
} from "@/lib/notes/proposal-client";

import { ChangePreview } from "./ChangePreview";

interface SummaryResponse {
  readonly kind: "summary";
  readonly noteId: string;
  readonly noteVersion: number;
  readonly summaryText: string;
  readonly sourceGraphemes: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Shrnutí se nepodařilo připravit.";
}

export interface SummaryActionProps {
  readonly note: NoteDetail;
  readonly disabled?: boolean;
  readonly llmStatus: LlmProviderStatus | null;
  readonly llmError?: string | null;
  readonly onNoteUpdated: (note: NoteDetail) => void;
  readonly onReadSummary?: (artifact: SummaryArtifact | null) => void;
}

export function SummaryAction({
  note,
  disabled = false,
  llmStatus,
  llmError = null,
  onNoteUpdated,
  onReadSummary,
}: SummaryActionProps) {
  const [scope, setScope] = useState<"full" | "range">("full");
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [artifact, setArtifact] = useState<SummaryArtifact | null>(null);
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const nonceRef = useRef<string | null>(null);
  const providerBlocked = llmStatus === null || !llmStatus.configured;
  const fullGraphemes = countGraphemes(note.contentPlain);
  const selectedText = note.contentPlain.slice(
    selection.start,
    selection.end,
  );
  const selectedGraphemes = countGraphemes(selectedText);
  const rangeValid =
    scope === "full"
      ? fullGraphemes <= SUMMARY_MAX_SOURCE_GRAPHEMES
      : selection.end > selection.start &&
        selectedGraphemes <= SUMMARY_MAX_SOURCE_GRAPHEMES;
  const canGenerate =
    !busy && !disabled && !providerBlocked && rangeValid;
  const stale = artifact !== null && artifact.noteVersion !== note.version;

  async function generate() {
    if (!canGenerate) {
      return;
    }

    setError(null);
    setStatus(null);
    setProposal(null);
    nonceRef.current = null;
    onReadSummary?.(null);
    setBusy(true);

    try {
      const response = await fetch(`/api/notes/${note.id}/ai-suggest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          scope === "full"
            ? { kind: "summary", scope: "full" }
            : {
                kind: "summary",
                scope: "range",
                start: selection.start,
                end: selection.end,
              },
        ),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;

        throw new Error(
          body?.error?.message ??
            "Shrnutí není dostupné. Poznámky lze dál upravovat ručně.",
        );
      }

      const result = (await response.json()) as SummaryResponse;
      setArtifact({
        noteId: result.noteId,
        noteVersion: result.noteVersion,
        summaryText: result.summaryText,
        sourceGraphemes: result.sourceGraphemes,
      });
      setStatus(
        "Shrnutí je odvozený, neuložený náhled. Poznámka se nezměnila; vložit ho lze až přes potvrzený P23 diff.",
      );
    } catch (generateError) {
      setArtifact(null);
      setError(errorMessage(generateError));
    } finally {
      setBusy(false);
    }
  }

  async function insert() {
    if (artifact === null || stale) {
      setError("Shrnutí je zastaralé. Vytvořte ho znovu z aktuální verze.");
      return;
    }

    setError(null);
    setStatus(null);
    setProposal(null);
    nonceRef.current = null;
    setBusy(true);

    try {
      const created = await createEditProposal(note.id, {
        operation: {
          type: "append_bounded_section",
          text: artifact.summaryText,
        },
        expectedVersion: artifact.noteVersion,
      });
      const { confirmationNonce, ...preview } = created;
      nonceRef.current = confirmationNonce;
      setProposal(preview);
      setStatus(
        "Návrh vložení shrnutí je připravený. Poznámka se změní až po potvrzení.",
      );
    } catch (insertError) {
      setError(
        insertError instanceof ProposalApiError
          ? insertError.message
          : errorMessage(insertError),
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirm(current: EditProposal) {
    const nonce = nonceRef.current;

    if (nonce === null) {
      setError("Potvrzovací údaj není k dispozici. Připravte návrh znovu.");
      return;
    }

    setConfirming(true);
    setError(null);

    try {
      const confirmed = await confirmEditProposal(note.id, current.id, {
        confirmationNonce: nonce,
        expectedVersion: current.expectedVersion,
      });
      nonceRef.current = null;
      setProposal(confirmed.proposal);
      setStatus("Shrnutí bylo vloženo jako nová revize.");
      onNoteUpdated(confirmed.note);
    } catch (confirmError) {
      setError(errorMessage(confirmError));
    } finally {
      setConfirming(false);
    }
  }

  async function reject(current: EditProposal) {
    setRejecting(true);
    setError(null);

    try {
      setProposal(await rejectEditProposal(note.id, current.id));
      nonceRef.current = null;
      setStatus("Vložení shrnutí bylo zamítnuto. Poznámka zůstala beze změny.");
    } catch (rejectError) {
      setError(errorMessage(rejectError));
    } finally {
      setRejecting(false);
    }
  }

  function readSummary() {
    if (artifact === null || stale) {
      return;
    }

    onReadSummary?.(artifact);
    document
      .getElementById("tts-player-heading")
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <section
      aria-labelledby="summary-heading"
      className="mt-6 rounded-2xl border border-stone-200 bg-white p-6"
    >
      <h2 className="text-xl font-semibold text-stone-950" id="summary-heading">
        Shrnutí poznámky
      </h2>
      <p className="mt-2 text-sm leading-6 text-stone-600">
        Shrnutí vzniká jen na výslovný požadavek a je odvozený, neuložený
        artefakt. Do OpenRouteru se odešle nejvýše{" "}
        {SUMMARY_MAX_SOURCE_GRAPHEMES.toLocaleString("cs-CZ")} znaků; delší
        poznámku je nutné zkrátit výběrem, nikdy se automaticky neořezává.
        Vložení vyžaduje P22/P23 diff a samostatné potvrzení.
      </p>

      {llmStatus ? (
        <p className="mt-2 text-xs leading-5 text-stone-500">
          OpenRouter · {llmStatus.model} · max.{" "}
          {llmStatus.maxInputCodeUnits.toLocaleString("cs-CZ")} znaků · odhad až{" "}
          {formatUsdAmount(String(llmStatus.estimatedMaxCostUsd))} na požadavek.
        </p>
      ) : null}

      {llmError ? (
        <p className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          {llmError}
        </p>
      ) : null}

      {providerBlocked ? (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          {llmStatus?.blockedReason ??
            "Shrnutí není nakonfigurované. Poznámky lze dál upravovat ručně."}
        </p>
      ) : null}

      {disabled ? (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          Nejprve uložte neuložené změny. Shrnutí musí vycházet z uložené verze
          poznámky.
        </p>
      ) : null}

      <label className="mt-4 block text-sm font-medium text-stone-700">
        Rozsah shrnutí
        <select
          className="mt-1 w-full rounded-lg border border-stone-300 bg-white p-3 text-sm disabled:bg-stone-100"
          data-testid="summary-scope"
          disabled={busy || disabled}
          onChange={(event) => {
            setScope(event.target.value as "full" | "range");
            setArtifact(null);
            setProposal(null);
            setStatus(null);
            setError(null);
            nonceRef.current = null;
            onReadSummary?.(null);
          }}
          value={scope}
        >
          <option value="full">Celá poznámka</option>
          <option value="range">Vybraný text</option>
        </select>
      </label>

      <label className="mt-3 block text-sm font-medium text-stone-700">
        Text poznámky pro výběr pasáže
        <textarea
          aria-label="Text poznámky pro výběr shrnutí"
          className="mt-1 h-32 w-full resize-y rounded-lg border border-stone-300 bg-stone-50 p-3 font-mono text-xs leading-5 text-stone-800"
          data-testid="summary-source"
          onSelect={(event) => {
            const target = event.currentTarget;
            setSelection({
              start: target.selectionStart,
              end: target.selectionEnd,
            });
          }}
          readOnly
          value={note.contentPlain}
        />
      </label>

      <p className="mt-1 text-xs leading-5 text-stone-500">
        {scope === "full"
          ? `Celá poznámka: ${fullGraphemes.toLocaleString("cs-CZ")} znaků.`
          : `Vybraná pasáž: ${selectedGraphemes.toLocaleString("cs-CZ")} znaků.`}{" "}
        Limit je {SUMMARY_MAX_SOURCE_GRAPHEMES.toLocaleString("cs-CZ")} znaků.
      </p>

      {!rangeValid ? (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          {scope === "full"
            ? "Poznámka je delší než limit. Vyberte prosím kratší pasáž."
            : "Vyberte neprázdnou pasáž do 8 000 znaků."}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          className="rounded-lg bg-stone-800 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600"
          data-testid="summary-generate"
          disabled={!canGenerate}
          onClick={() => void generate()}
          type="button"
        >
          {busy ? "Shrnuji…" : "Vytvořit shrnutí"}
        </button>
      </div>

      {artifact ? (
        <div
          className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4"
          data-testid="summary-artifact"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-900">
            Odvozené shrnutí · neuloženo · verze {artifact.noteVersion}
          </p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-emerald-950">
            {artifact.summaryText}
          </p>
          <p className="mt-2 text-xs leading-5 text-emerald-900">
            Zdroj: {artifact.sourceGraphemes.toLocaleString("cs-CZ")} znaků.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="rounded-lg bg-emerald-800 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
              disabled={disabled || stale}
              onClick={readSummary}
              type="button"
            >
              Přečíst shrnutí
            </button>
            <button
              className="rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:text-stone-400"
              disabled={disabled || busy || stale}
              onClick={() => void insert()}
              type="button"
            >
              Vložit shrnutí
            </button>
            <button
              className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100"
              onClick={() => {
                setArtifact(null);
                setProposal(null);
                setStatus(null);
                setError(null);
                onReadSummary?.(null);
                nonceRef.current = null;
              }}
              type="button"
            >
              Zahodit shrnutí
            </button>
          </div>
          {stale ? (
            <p className="mt-2 text-sm text-amber-950">
              Poznámka se mezitím změnila. Vytvořte shrnutí znovu; vložení ani
              čtení zastaralého shrnutí není povolené.
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {status ? (
        <p aria-live="polite" className="mt-3 text-sm text-stone-700">
          {status}
        </p>
      ) : null}

      {proposal ? (
        <ChangePreview
          confirming={confirming}
          disabled={disabled}
          onConfirm={(current) => void confirm(current)}
          onReject={(current) => void reject(current)}
          proposal={proposal}
          rejecting={rejecting}
        />
      ) : null}
    </section>
  );
}
