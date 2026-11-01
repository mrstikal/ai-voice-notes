"use client";

import { useRef, useState, useSyncExternalStore } from "react";

import {
  AI_SNIPPET_MAX_GRAPHEMES,
  isUndoCommand,
} from "@/lib/ai/edit-prompts";
import type { LlmOperation } from "@/lib/ai/schemas";
import type { LlmProviderStatus } from "@/lib/ai/structured";
import { formatUsdAmount } from "@/lib/ai/usage-format";
import { NoteApiError, type NoteDetail } from "@/lib/notes/client";
import {
  ProposalApiError,
  confirmEditProposal,
  createEditProposal,
  rejectEditProposal,
  type CreatedEditProposal,
  type EditProposal,
} from "@/lib/notes/proposal-client";
import {
  changedSnapshotFields,
  computeRevisionDiff,
  fetchRevisions,
  restoreRevision,
  type NoteRevision,
} from "@/lib/notes/revision-client";
import { countGraphemes } from "@/lib/notes/limits";
import {
  getMediaActivityServerSnapshot,
  getMediaActivitySnapshot,
  subscribeMediaActivity,
} from "@/lib/media/activity";
import { useScribeDictation } from "@/components/voice/useScribeDictation";

import { ChangePreview } from "./ChangePreview";

interface InterpretResponse {
  readonly kind: "operation" | "unclear" | "undo";
  readonly operation?: LlmOperation;
  readonly clarification?: string;
}

interface AmbiguousOperation {
  readonly operation: LlmOperation;
  readonly candidates: readonly {
    readonly id: string;
    readonly ordinal: number;
    readonly snippet: string;
  }[];
  readonly noteVersion: number | null;
  readonly sourceHash: string | null;
}

interface UndoPreview {
  readonly revision: NoteRevision;
  readonly currentSnapshot: NonNullable<
    Awaited<ReturnType<typeof fetchRevisions>>["currentSnapshot"]
  >;
  readonly currentVersion: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "AI příkaz se nepodařilo interpretovat.";
}

async function interpret(
  noteId: string,
  command: string,
  snippet: string,
): Promise<InterpretResponse> {
  const response = await fetch("/api/voice/interpret", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ noteId, command, snippet }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;

    throw new Error(
      body?.error?.message ??
        "AI úprava není dostupná. Poznámky lze dál upravovat ručně.",
    );
  }

  return (await response.json()) as InterpretResponse;
}

export interface AiEditControlsProps {
  readonly note: NoteDetail;
  readonly disabled?: boolean;
  readonly llmStatus: LlmProviderStatus | null;
  readonly llmError?: string | null;
  readonly onNoteUpdated: (note: NoteDetail) => void;
}

export function AiEditControls({
  note,
  disabled = false,
  llmStatus,
  llmError = null,
  onNoteUpdated,
}: AiEditControlsProps) {
  const [command, setCommand] = useState("");
  const [snippet, setSnippet] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [clarification, setClarification] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const [ambiguous, setAmbiguous] = useState<AmbiguousOperation | null>(null);
  const [undoPreview, setUndoPreview] = useState<UndoPreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const nonceRef = useRef<string | null>(null);
  const media = useSyncExternalStore(
    subscribeMediaActivity,
    getMediaActivitySnapshot,
    getMediaActivityServerSnapshot,
  );

  const dictation = useScribeDictation({
    stopAfterFirstCommit: true,
    flushOnStop: false,
    onCommit: (segment) => {
      // The committed request becomes visible command text only. It does not
      // call OpenRouter; the user must explicitly request interpretation.
      setCommand(segment.text);
    },
  });
  const voiceBusy =
    dictation.session.status !== "idle" &&
    dictation.session.status !== "error";

  async function loadUndoPreview() {
    const history = await fetchRevisions(note.id);

    if (!history.undoRevisionId) {
      setClarification("Není co vrátit; poslední změna není dostupná.");
      return;
    }

    const revision = history.revisions.find(
      (item) => item.id === history.undoRevisionId,
    );

    if (!revision) {
      setClarification("Poslední změnu se nepodařilo načíst.");
      return;
    }

    setUndoPreview({
      revision,
      currentSnapshot: history.currentSnapshot,
      currentVersion: history.currentVersion,
    });
  }

  async function submit() {
    setError(null);
    setClarification(null);
    setProposal(null);
    setAmbiguous(null);
    setUndoPreview(null);

    if (command.trim() === "") {
      setError("Zadejte příkaz nebo jej nadiktujte.");
      return;
    }

    if (
      snippet.length > 0 &&
      countGraphemes(snippet) > AI_SNIPPET_MAX_GRAPHEMES
    ) {
      setError(
        `Vybraný text může mít nejvýše ${AI_SNIPPET_MAX_GRAPHEMES} znaků.`,
      );
      return;
    }

    setBusy(true);
    let interpretedOperation: LlmOperation | undefined;

    try {
      const response = await interpret(note.id, command, snippet);

      if (response.kind === "undo") {
        await loadUndoPreview();
        return;
      }

      if (response.kind === "unclear") {
        setClarification(
          response.clarification ??
            "Příkaz je nejasný. Upřesněte, co má AI změnit.",
        );
        return;
      }

      if (!response.operation) {
        setError("Server nevrátil validní operaci.");
        return;
      }

      interpretedOperation = response.operation;
      const created = await createEditProposal(note.id, {
        operation: response.operation,
        expectedVersion: note.version,
      });
      const { confirmationNonce, ...preview } = created;
      nonceRef.current = confirmationNonce;
      setProposal(preview);
    } catch (submitError) {
      if (
        submitError instanceof ProposalApiError &&
        submitError.code === "proposal_ambiguous" &&
        submitError.candidates.length > 0
      ) {
        if (interpretedOperation) {
          setAmbiguous({
            operation: interpretedOperation,
            candidates: submitError.candidates,
            noteVersion: submitError.noteVersion,
            sourceHash: submitError.sourceHash,
          });
          setError(null);
          return;
        }
      }

      setError(errorMessage(submitError));
    } finally {
      setBusy(false);
    }
  }

  async function selectCandidate(candidate: AmbiguousOperation["candidates"][number]) {
    if (
      ambiguous === null ||
      ambiguous.noteVersion === null ||
      ambiguous.sourceHash === null
    ) {
      setError("Kandidát není svázán s verzí a hashem poznámky.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const created: CreatedEditProposal = await createEditProposal(note.id, {
        operation: ambiguous.operation,
        candidateId: candidate.id,
        expectedVersion: ambiguous.noteVersion,
        expectedSourceHash: ambiguous.sourceHash,
      });
      const { confirmationNonce, ...preview } = created;
      nonceRef.current = confirmationNonce;
      setProposal(preview);
      setAmbiguous(null);
    } catch (selectError) {
      setError(errorMessage(selectError));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(current: EditProposal) {
    const nonce = nonceRef.current;

    if (!nonce) {
      setError("Potvrzovací údaj není k dispozici. Vytvořte návrh znovu.");
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
    } catch (rejectError) {
      setError(errorMessage(rejectError));
    } finally {
      setRejecting(false);
    }
  }

  async function confirmUndo() {
    if (!undoPreview) {
      return;
    }

    setConfirming(true);
    setError(null);

    try {
      const updated = await restoreRevision(
        note.id,
        undoPreview.revision.id,
        {
          mode: "undo",
          expectedVersion: undoPreview.currentVersion,
        },
      );
      setUndoPreview(null);
      onNoteUpdated(updated);
    } catch (undoError) {
      setError(errorMessage(undoError));

      if (undoError instanceof NoteApiError && undoError.status === 409) {
        setUndoPreview(null);
      }
    } finally {
      setConfirming(false);
    }
  }

  const undoDiff =
    undoPreview === null
      ? null
      : computeRevisionDiff(
          undoPreview.currentSnapshot.contentMd,
          undoPreview.revision.beforeSnapshot.contentMd,
        );
  const providerBlocked = llmStatus === null || !llmStatus.configured;
  const undoCommand = isUndoCommand(command);
  const interpretAvailable =
    !busy && !disabled && (!providerBlocked || undoCommand);
  const voiceUnavailable =
    disabled ||
    providerBlocked ||
    media.playbackActive ||
    (media.microphoneActive && !voiceBusy);

  return (
    <section
      aria-labelledby="ai-edit-heading"
      className="mt-6 rounded-2xl border border-stone-200 bg-white p-6"
    >
      <h2
        className="text-xl font-semibold text-stone-950"
        id="ai-edit-heading"
      >
        AI úprava
      </h2>
      <p className="mt-2 text-sm leading-6 text-stone-600">
        Explicitně zadaný nebo jednorázově nadiktovaný český příkaz. Do
        OpenRouteru se odešle pouze příkaz, titulek a vybraný text do 1 200
        znaků; nikdy celá databáze ani klíč. Výsledek se nejprve zobrazí jako
        P23 diff a zapíše se až po potvrzení. Vybraný text je kontext; server
        operaci přesto ověří proti celé uložené poznámce a ukáže přesný diff.
      </p>

      {llmStatus ? (
        <p className="mt-2 text-xs leading-5 text-stone-500">
          OpenRouter · {llmStatus.model} · max.{" "}
          {llmStatus.maxInputCodeUnits.toLocaleString("cs-CZ")} znaků · odhad
          až {formatUsdAmount(String(llmStatus.estimatedMaxCostUsd))} na
          požadavek · rezervace se řídí P12.
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
            "AI úprava není nakonfigurovaná. Poznámky lze dál upravovat ručně."}
        </p>
      ) : null}

      {disabled ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          Nejprve uložte neuložené změny. AI příkaz musí vycházet z uložené
          poznámky.
        </p>
      ) : null}

      <label className="mt-4 block text-sm font-medium text-stone-700">
        Český příkaz
        <textarea
          className="mt-1 min-h-20 w-full rounded-lg border border-stone-300 p-3 text-sm disabled:bg-stone-100"
          disabled={busy || disabled}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="Např. Nahraď druhou větu textem…"
          value={command}
        />
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400"
          disabled={voiceBusy ? false : voiceUnavailable || busy}
          onClick={() => {
            if (voiceBusy) {
              void dictation.stop({ flush: false });
            } else {
              dictation.start();
            }
          }}
          type="button"
        >
          {voiceBusy ? "Ukončit příkaz" : "Nadiktovat příkaz"}
        </button>
        <span className="text-xs leading-5 text-stone-500">
          Jedna relace Scribe se rezervuje v P12; příkaz se do poznámky
          neukládá. Odeslání do AI je samostatné tlačítko.
        </span>
      </div>
      {dictation.session.error ? (
        <p className="mt-2 text-sm text-red-800">
          {dictation.session.error}
        </p>
      ) : null}

      <label className="mt-4 block text-sm font-medium text-stone-700">
        Náhled poznámky pro výběr
        <textarea
          className="mt-1 h-32 w-full resize-y rounded-lg border border-stone-300 bg-stone-50 p-2 font-mono text-xs leading-5 text-stone-800"
          onSelect={(event) => {
            const target = event.currentTarget;
            setSnippet(
              note.contentMd.slice(
                target.selectionStart,
                target.selectionEnd,
              ),
            );
          }}
          readOnly
          value={note.contentMd}
        />
      </label>

      <label className="mt-3 block text-sm font-medium text-stone-700">
        Vybraný text pro AI ({countGraphemes(snippet)} /{" "}
        {AI_SNIPPET_MAX_GRAPHEMES})
        <textarea
          className="mt-1 min-h-24 w-full rounded-lg border border-stone-300 p-3 font-mono text-sm disabled:bg-stone-100"
          disabled={busy || disabled}
          onChange={(event) => setSnippet(event.target.value)}
          value={snippet}
        />
      </label>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          className="rounded-lg bg-stone-800 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600"
          disabled={!interpretAvailable}
          onClick={() => void submit()}
          type="button"
        >
          {busy ? "Interpretuji…" : "Interpretovat příkaz"}
        </button>
        <span className="text-xs leading-5 text-stone-500">
          Příkaz ani vybraný text se neukládá do historie; historii vytvoří až
          potvrzený P24 apply.
        </span>
      </div>

      {clarification ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          {clarification}
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

      {ambiguous ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-950">
            Cíl odpovídá více místům
          </p>
          <div className="mt-2 space-y-2">
            {ambiguous.candidates.map((candidate) => (
              <button
                className="block w-full rounded-lg border border-amber-300 bg-white p-3 text-left text-sm hover:bg-amber-100 disabled:opacity-50"
                disabled={busy || disabled}
                key={candidate.id}
                onClick={() => void selectCandidate(candidate)}
                type="button"
              >
                <strong>{candidate.ordinal}.</strong> {candidate.snippet}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {undoPreview && undoDiff ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-950">
            Vrátit poslední změnu?
          </p>
          <p className="mt-1 text-xs text-amber-950">
            Vrátí se snapshot z verze {undoPreview.revision.noteVersion}.
            Aplikuje se nová revize undo.
          </p>
          {changedSnapshotFields(
            undoPreview.currentSnapshot,
            undoPreview.revision.beforeSnapshot,
          ).map((field) => (
            <p className="mt-1 text-sm text-amber-950" key={field}>
              {field}
            </p>
          ))}
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-stone-200 bg-white p-3 font-mono text-xs">
            {undoDiff.prefix}
            <del className="bg-red-100 text-red-900">{undoDiff.removed}</del>
            <ins className="bg-emerald-100 text-emerald-950 no-underline">
              {undoDiff.inserted}
            </ins>
            {undoDiff.suffix}
          </pre>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="rounded-lg bg-emerald-800 px-3 py-2 text-sm font-semibold text-white disabled:bg-stone-300"
              disabled={disabled || confirming}
              onClick={() => void confirmUndo()}
              type="button"
            >
              {confirming ? "Vracím…" : "Potvrdit vrácení"}
            </button>
            <button
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold"
              disabled={disabled || confirming}
              onClick={() => setUndoPreview(null)}
              type="button"
            >
              Zrušit
            </button>
          </div>
        </div>
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
