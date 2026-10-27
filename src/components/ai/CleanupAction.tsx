"use client";

import { useMemo, useRef, useState } from "react";

import type { LlmOperation } from "@/lib/ai/schemas";
import type { LlmProviderStatus } from "@/lib/ai/structured";
import {
  CLEANUP_PARAGRAPH_MAX_GRAPHEMES,
  cleanupParagraphSnippet,
  collectCleanupParagraphs,
  normalizeProperNames,
  validateProperNames,
} from "@/lib/ai/cleanup";
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

interface CleanupResponse {
  readonly kind: "cleanup";
  readonly operation: Extract<
    LlmOperation,
    { readonly type: "replace_paragraph" }
  >;
  readonly originalText: string;
  readonly cleanedText: string;
  readonly noteVersion: number;
  readonly candidateId: string;
  readonly sourceHash: string;
}

function parseNames(value: string): readonly string[] {
  return normalizeProperNames(value.split(/[,;\n]+/u));
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Čištění diktátu se nepodařilo připravit.";
}

export interface CleanupActionProps {
  readonly note: NoteDetail;
  readonly disabled?: boolean;
  readonly llmStatus: LlmProviderStatus | null;
  readonly llmError?: string | null;
  readonly onApplied?: (message: string | null) => void;
  readonly onNoteUpdated: (note: NoteDetail) => void;
}

export function CleanupAction({
  note,
  disabled = false,
  llmStatus,
  llmError = null,
  onApplied,
  onNoteUpdated,
}: CleanupActionProps) {
  const paragraphs = useMemo(
    () => collectCleanupParagraphs(note.contentMd),
    [note.contentMd],
  );
  const [selectedBlockIndex, setSelectedBlockIndex] = useState("");
  const [properNamesInput, setProperNamesInput] = useState("");
  const [suggestion, setSuggestion] = useState<CleanupResponse | null>(null);
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const nonceRef = useRef<string | null>(null);
  const providerBlocked = llmStatus === null || !llmStatus.configured;
  const selectedParagraph = paragraphs.find(
    (paragraph) => String(paragraph.blockIndex) === selectedBlockIndex,
  );
  const names = parseNames(properNamesInput);
  const namesValid =
    names.length <= 20 &&
    names.every((name) => countGraphemes(name) <= 80);
  const canSubmit =
    !busy &&
    !disabled &&
    !providerBlocked &&
    selectedParagraph !== undefined &&
    namesValid;

  async function submit() {
    if (!selectedParagraph) {
      setError("Vyberte jeden podporovaný odstavec.");
      return;
    }

    setError(null);
    setStatus(null);
    setSuggestion(null);
    setProposal(null);
    nonceRef.current = null;
    onApplied?.(null);

    let validatedNames: readonly string[];

    try {
      validatedNames = validateProperNames(names, selectedParagraph.text);
    } catch (nameError) {
      setError(errorMessage(nameError));
      return;
    }

    setBusy(true);

    try {
      const response = await fetch(`/api/notes/${note.id}/ai-suggest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "cleanup",
          blockIndex: selectedParagraph.blockIndex,
          properNames: validatedNames,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;

        throw new Error(
          body?.error?.message ??
            "Čištění diktátu není dostupné. Poznámky lze dál upravovat ručně.",
        );
      }

      const result = (await response.json()) as CleanupResponse;
      setSuggestion(result);

      const created = await createEditProposal(note.id, {
        operation: result.operation,
        candidateId: result.candidateId,
        expectedVersion: result.noteVersion,
        expectedSourceHash: result.sourceHash,
      });
      const { confirmationNonce, ...preview } = created;
      nonceRef.current = confirmationNonce;
      setProposal(preview);
      setStatus(
        "Návrh vyčištění je připravený. Poznámka se změní až po potvrzení.",
      );
    } catch (submitError) {
      if (submitError instanceof ProposalApiError) {
        setError(submitError.message);
      } else {
        setError(errorMessage(submitError));
      }
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
      setStatus("Vyčištění odstavce bylo uloženo.");
      onNoteUpdated(confirmed.note);
      onApplied?.("Vyčištění odstavce bylo uloženo.");
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
      setStatus("Návrh vyčištění byl zamítnut. Poznámka zůstala beze změny.");
    } catch (rejectError) {
      setError(errorMessage(rejectError));
    } finally {
      setRejecting(false);
    }
  }

  return (
    <section
      aria-labelledby="cleanup-heading"
      className="mt-6 rounded-2xl border border-stone-200 bg-white p-6"
    >
      <h2 className="text-xl font-semibold text-stone-950" id="cleanup-heading">
        Vyčistit diktát
      </h2>
      <p className="mt-2 text-sm leading-6 text-stone-600">
        Vyberte jeden prostý odstavec bez odrážek, úkolů, kódu a inline
        Markdownu. Model odstraní opakování a výplňová slova, ale musí zachovat
        význam, čísla, zadaná vlastní jména i značky úkolů. Není to záruka
        stejného významu; před potvrzením zkontrolujte přesný diff. Poznámka se
        změní až potvrzením P23/P24 návrhu.
      </p>

      {llmStatus ? (
        <p className="mt-2 text-xs leading-5 text-stone-500">
          OpenRouter · {llmStatus.model} · max.{" "}
          {llmStatus.maxInputCodeUnits.toLocaleString("cs-CZ")} znaků · odhad až{" "}
          {formatUsdAmount(String(llmStatus.estimatedMaxCostUsd))} na požadavek.
          Odesílá se pouze vybraný odstavec a zadaná jména.
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
            "Čištění diktátu není nakonfigurované. Poznámky lze dál upravovat ručně."}
        </p>
      ) : null}

      {disabled ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          Nejprve uložte neuložené změny. Čištění musí vycházet z uložené verze
          poznámky.
        </p>
      ) : null}

      {paragraphs.length === 0 ? (
        <p className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
          V poznámce není žádný podporovaný prostý odstavec do{" "}
          {CLEANUP_PARAGRAPH_MAX_GRAPHEMES.toLocaleString("cs-CZ")} znaků.
        </p>
      ) : (
        <label className="mt-4 block text-sm font-medium text-stone-700">
          Odstavec k vyčištění
          <select
            aria-label="Vybrat odstavec k vyčištění"
            className="mt-1 w-full rounded-lg border border-stone-300 bg-white p-3 text-sm disabled:bg-stone-100"
            disabled={busy || disabled}
            data-testid="cleanup-paragraph"
            onChange={(event) => {
              setSelectedBlockIndex(event.target.value);
              setSuggestion(null);
              setProposal(null);
              setStatus(null);
              setError(null);
              nonceRef.current = null;
            }}
            value={selectedBlockIndex}
          >
            <option value="">Vyberte odstavec…</option>
            {paragraphs.map((paragraph, index) => (
              <option
                key={paragraph.blockIndex}
                value={String(paragraph.blockIndex)}
              >
                {index + 1}. {cleanupParagraphSnippet(paragraph)}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="mt-3 block text-sm font-medium text-stone-700">
        Vlastní jména k přesnému zachování (nepovinné, oddělená čárkou)
        <input
          className="mt-1 w-full rounded-lg border border-stone-300 p-3 text-sm disabled:bg-stone-100"
          disabled={busy || disabled}
          data-testid="cleanup-names"
          onChange={(event) => setProperNamesInput(event.target.value)}
          placeholder="Např. Jan Novák, Praha"
          type="text"
          value={properNamesInput}
        />
      </label>
      {!namesValid ? (
        <p className="mt-1 text-xs text-red-800">
          Zadejte nejvýše 20 jmen, každé do 80 znaků.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          className="rounded-lg bg-stone-800 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600"
          data-testid="cleanup-submit"
          disabled={!canSubmit}
          onClick={() => void submit()}
          type="button"
        >
          {busy ? "Čistím…" : "Vyčistit diktát"}
        </button>
        <span className="text-xs leading-5 text-stone-500">
          Vyžaduje samostatné potvrzení. Zamítnutí ani selhání poskytovatele
          nevytvoří revizi ani nezmění poznámku.
        </span>
      </div>

      {suggestion ? (
        <p className="mt-3 text-xs leading-5 text-stone-500">
          Původní odstavec: {suggestion.originalText.length} znaků · vyčištěný:{" "}
          {suggestion.cleanedText.length} znaků.
        </p>
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
