"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { LlmOperation } from "@/lib/ai/schemas";
import { parseTaskVoiceCommand } from "@/lib/voice/commands";
import {
  getMediaActivityServerSnapshot,
  getMediaActivitySnapshot,
  subscribeMediaActivity,
} from "@/lib/media/activity";
import type { NoteDetail } from "@/lib/notes/client";
import type { OperationCandidate } from "@/lib/notes/operations";
import {
  ProposalApiError,
  confirmEditProposal,
  createEditProposal,
  rejectEditProposal,
  type EditProposal,
} from "@/lib/notes/proposal-client";
import { MICROPHONE_SESSION_MAX_MS } from "@/lib/voice/microphone";

import { ChangePreview } from "../ai/ChangePreview";
import { useScribeDictation } from "../voice/useScribeDictation";

interface AmbiguousTask {
  readonly operation: LlmOperation;
  readonly candidates: readonly OperationCandidate[];
  readonly noteVersion: number | null;
  readonly sourceHash: string | null;
}

interface RecognizedTaskCommand {
  readonly taskText: string;
  readonly checked: boolean;
}

function formatError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Změnu úkolu se nepodařilo připravit.";
}

export interface TaskVoiceControlsProps {
  readonly note: NoteDetail;
  readonly disabled?: boolean;
  readonly onApplied?: (message: string | null) => void;
  readonly onNoteUpdated: (note: NoteDetail) => void;
}

export function TaskVoiceControls({
  note,
  disabled = false,
  onApplied,
  onNoteUpdated,
}: TaskVoiceControlsProps) {
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const [ambiguous, setAmbiguous] = useState<AmbiguousTask | null>(null);
  const [recognized, setRecognized] = useState<RecognizedTaskCommand | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const nonceRef = useRef<string | null>(null);
  const noteRef = useRef(note);
  const media = useSyncExternalStore(
    subscribeMediaActivity,
    getMediaActivitySnapshot,
    getMediaActivityServerSnapshot,
  );

  useEffect(() => {
    noteRef.current = note;
  }, [note]);

  useEffect(() => {
    nonceRef.current = null;
  }, [note.version]);

  async function submitOperation(
    operation: LlmOperation,
    expectedVersion: number,
  ) {
    setBusy(true);
    setError(null);

    try {
      const created = await createEditProposal(noteRef.current.id, {
        operation,
        expectedVersion,
      });
      const { confirmationNonce, ...preview } = created;
      nonceRef.current = confirmationNonce;
      setProposal(preview);
      setAmbiguous(null);
      setStatus("Návrh změny úkolu je připravený. Poznámka se změní až po potvrzení.");
    } catch (submitError) {
      if (
        submitError instanceof ProposalApiError &&
        submitError.code === "proposal_ambiguous" &&
        submitError.candidates.length > 0
      ) {
        setAmbiguous({
          operation,
          candidates: submitError.candidates,
          noteVersion: submitError.noteVersion,
          sourceHash: submitError.sourceHash,
        });
        setProposal(null);
        nonceRef.current = null;
        setStatus(
          "Text úkolu odpovídá více úkolům. Vyberte konkrétní úkol v náhledu.",
        );
        return;
      }

      setError(formatError(submitError));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  const dictation = useScribeDictation({
    stopAfterFirstCommit: true,
    flushOnStop: false,
    onCommit: (segment) => {
      const parsed = parseTaskVoiceCommand(segment.text);

      if (parsed === null) {
        setRecognized(null);
        setProposal(null);
        setAmbiguous(null);
        nonceRef.current = null;
        setStatus(null);
        setError(
          "Příkaz nebyl rozpoznán. Řekněte například „označ úkol koupit mléko jako hotový“ nebo „zruš označení úkolu koupit mléko“.",
        );
        return;
      }

      setRecognized(parsed);
      void submitOperation(
        {
          type: "set_task_checked",
          taskText: parsed.taskText,
          checked: parsed.checked,
        },
        noteRef.current.version,
      );
    },
  });

  const voiceBusy =
    dictation.session.status !== "idle" &&
    dictation.session.status !== "error";
  const startDisabled =
    disabled ||
    busy ||
    dictation.isStopping ||
    dictation.webLocksSupported === false ||
    media.playbackActive ||
    (media.microphoneActive && !voiceBusy);
  const errorMessage = error ?? dictation.session.error;

  function handleStart() {
    if (voiceBusy) {
      void dictation.stop({ flush: false });
      return;
    }

    setProposal(null);
    setAmbiguous(null);
    setRecognized(null);
    nonceRef.current = null;
    setError(null);
    setStatus(null);
    onApplied?.(null);
    dictation.clearTranscripts();
    dictation.start();
  }

  async function selectCandidate(candidate: OperationCandidate) {
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
      const created = await createEditProposal(noteRef.current.id, {
        operation: ambiguous.operation,
        candidateId: candidate.id,
        expectedVersion: ambiguous.noteVersion,
        expectedSourceHash: ambiguous.sourceHash,
      });
      const { confirmationNonce, ...preview } = created;
      nonceRef.current = confirmationNonce;
      setProposal(preview);
      setAmbiguous(null);
      setStatus("Vybraný úkol je připravený k potvrzení.");
    } catch (selectError) {
      setError(formatError(selectError));
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
      const confirmed = await confirmEditProposal(noteRef.current.id, current.id, {
        confirmationNonce: nonce,
        expectedVersion: current.expectedVersion,
      });
      nonceRef.current = null;
      setProposal(confirmed.proposal);
      setStatus("Změna úkolu byla uložena.");
      onNoteUpdated(confirmed.note);
      onApplied?.("Změna úkolu byla uložena.");
    } catch (confirmError) {
      setError(formatError(confirmError));
    } finally {
      setConfirming(false);
    }
  }

  async function reject(current: EditProposal) {
    setRejecting(true);
    setError(null);

    try {
      setProposal(await rejectEditProposal(noteRef.current.id, current.id));
      nonceRef.current = null;
      setStatus("Návrh změny úkolu byl zamítnut. Poznámka zůstala beze změny.");
    } catch (rejectError) {
      setError(formatError(rejectError));
    } finally {
      setRejecting(false);
    }
  }

  const proposalStale =
    proposal !== null && proposal.expectedVersion !== note.version;
  const ambiguousStale =
    ambiguous !== null &&
    ambiguous.noteVersion !== null &&
    ambiguous.noteVersion !== note.version;
  const stale = proposalStale || ambiguousStale;
  const activeProposal = proposalStale ? null : proposal;
  const activeAmbiguous = ambiguousStale ? null : ambiguous;

  return (
    <section
      aria-labelledby="task-voice-heading"
      className="mt-6 rounded-2xl border border-stone-200 bg-white p-6"
    >
      <h2
        className="text-xl font-semibold text-stone-950"
        id="task-voice-heading"
      >
        Stav úkolů hlasem
      </h2>
      <p className="mt-2 text-sm leading-6 text-stone-600">
        Jednorázově nadiktujte český příkaz pro existující úkol. Příkaz se
        vyhodnotí místně bez volání jazykového modelu a poznámku změní až
        potvrzený návrh. Podporované fráze:{" "}
        <code>označ úkol … jako hotový</code> a{" "}
        <code>zruš označení úkolu …</code>. Kód v bloku kódu se za úkol
        nepovažuje.
      </p>
      <p className="mt-2 text-xs leading-5 text-stone-500">
        ElevenLabs Scribe v2 Realtime, relace max.{" "}
        {MICROPHONE_SESSION_MAX_MS / 1000} s. Rezervace až 0,0195 USD;
        skutečná cena může být neznámá. Zvuk se neukládá.
      </p>

      {dictation.webLocksSupported === false ? (
        <p
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
          role="alert"
        >
          Tento prohlížeč nepodporuje Web Locks, proto nelze bezpečně zajistit
          výhradní přístup k mikrofonu. Otevřete aplikaci v Chromiu nebo Edge.
        </p>
      ) : null}

      {disabled ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          Nejprve uložte neuložené změny. Příkaz musí vycházet z uložené verze
          poznámky.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          className="rounded-lg bg-stone-800 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600"
          disabled={voiceBusy ? dictation.isStopping : startDisabled}
          onClick={handleStart}
          type="button"
        >
          {voiceBusy ? "Ukončit příkaz" : "Nadiktovat změnu úkolu"}
        </button>
        <span className="text-xs leading-5 text-stone-500">
          Přepis se zobrazí zde a do poznámky se nezapisuje. Změna stavu
          vyžaduje samostatné potvrzení.
        </span>
      </div>

      {voiceBusy ? (
        <p
          aria-live="polite"
          className="mt-3 rounded-lg bg-stone-100 p-3 text-sm text-stone-800"
          data-testid="task-voice-partial"
        >
          {dictation.partialTranscript || "Čekám na řeč…"}
        </p>
      ) : null}

      {recognized ? (
        <p
          className="mt-3 text-sm text-stone-700"
          data-testid="task-voice-recognized"
        >
          Rozpoznáno: {recognized.checked ? "označit jako hotový" : "zrušit označení"} ·{" "}
          <strong>{recognized.taskText}</strong>
        </p>
      ) : null}

      {activeAmbiguous ? (
        <fieldset className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <legend className="text-sm font-semibold text-amber-950">
            Text úkolu odpovídá více úkolům
          </legend>
          <div className="mt-2 space-y-2">
            {activeAmbiguous.candidates.map((candidate) => (
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
        </fieldset>
      ) : null}

      {errorMessage ? (
        <p
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
          role="alert"
        >
          {errorMessage}
        </p>
      ) : null}

      {status && !stale ? (
        <p aria-live="polite" className="mt-3 text-sm text-stone-700">
          {status}
        </p>
      ) : null}

      {stale ? (
        <p
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"
          data-testid="task-voice-stale"
        >
          Poznámka se mezitím změnila. Připravte návrh úkolu znovu.
        </p>
      ) : null}

      {activeProposal ? (
        <ChangePreview
          confirming={confirming}
          disabled={disabled}
          onConfirm={(current) => void confirm(current)}
          onReject={(current) => void reject(current)}
          proposal={activeProposal}
          rejecting={rejecting}
        />
      ) : null}
    </section>
  );
}
