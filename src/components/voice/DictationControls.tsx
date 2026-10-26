"use client";

import { useEffect, useRef, useState } from "react";

import {
  NoteApiError,
  updateVoiceTitle,
  type NoteDetail,
} from "@/lib/notes/client";
import {
  TITLE_MAX_GRAPHEMES,
  countGraphemes,
} from "@/lib/notes/limits";
import {
  MICROPHONE_SESSION_MAX_MS,
  type MicrophoneSessionStatus,
} from "@/lib/voice/microphone";

import { useScribeDictation } from "./useScribeDictation";

const statusLabels: Record<MicrophoneSessionStatus, string> = {
  idle: "Připraveno",
  "acquiring-lease": "Získávám výhradní přístup k mikrofonu…",
  "requesting-token": "Připravuji token pro diktování…",
  connecting: "Připojuji k ElevenLabs…",
  active: "Poslouchám…",
  stopping: "Ukončuji diktování…",
  error: "Diktování se nepodařilo",
};

export interface DictationControlsProps {
  readonly note: NoteDetail;
  readonly onNoteUpdated?: (note: NoteDetail) => void;
  readonly disabled?: boolean;
}

interface TitleProposal {
  readonly text: string;
  readonly baseVersion: number;
}

function conflictMessage(error: NoteApiError): string {
  if (error.latestVersion === undefined) {
    return error.message;
  }

  return `${error.message} Aktuální verze: ${error.latestVersion}.`;
}

export function DictationControls({
  note,
  onNoteUpdated,
  disabled = false,
}: DictationControlsProps) {
  const [proposal, setProposal] = useState<TitleProposal | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const savingRef = useRef(false);
  const noteRef = useRef(note);

  useEffect(() => {
    noteRef.current = note;
  }, [note]);

  const dictation = useScribeDictation({
    stopAfterFirstCommit: true,
    flushOnStop: false,
    onCommit: (segment) => {
      const text = segment.text.replace(/\s+/gu, " ").trim();

      if (text === "") {
        return;
      }

      const graphemes = countGraphemes(text);

      if (graphemes > TITLE_MAX_GRAPHEMES) {
        setProposal(null);
        setError(
          `Nadiktovaný název má ${graphemes} znaků; maximum je ${TITLE_MAX_GRAPHEMES}. Zkuste kratší.`,
        );
        setStatus(null);
        return;
      }

      setProposal({
        text,
        baseVersion: noteRef.current.version,
      });
      setError(null);
      setStatus("Název je připravený. Zkontrolujte jej a použijte.");
    },
  });

  const { session, partialTranscript, webLocksSupported, isStopping } =
    dictation;
  const proposalStale =
    proposal !== null && note.version !== proposal.baseVersion;
  const busy = session.status !== "idle" && session.status !== "error";
  const startDisabled =
    disabled || webLocksSupported !== true || busy || isStopping || isSaving;
  const stopDisabled =
    !busy || session.status === "stopping" || isStopping || isSaving;
  const useDisabled =
    proposal === null || isSaving || disabled || proposalStale;
  const errorMessage = error ?? session.error;
  const statusMessage = status ?? session.notice;

  function handleStart() {
    if (startDisabled) {
      return;
    }

    setProposal(null);
    setError(null);
    setStatus(null);
    dictation.clearTranscripts();
    dictation.start();
  }

  function handleStop() {
    setProposal(null);
    setError(null);
    setStatus("Diktování názvu bylo zrušeno.");
    dictation.clearTranscripts();
    void dictation.stop({ flush: false });
  }

  function handleCancel() {
    setProposal(null);
    setError(null);
    setStatus("Návrh názvu byl zrušen.");
    dictation.clearTranscripts();
    void dictation.stop({ flush: false });
  }

  async function handleUse() {
    if (proposal === null || useDisabled || savingRef.current) {
      return;
    }

    const currentNote = noteRef.current;

    if (currentNote.version !== proposal.baseVersion) {
      setProposal(null);
      setError("Poznámka se mezitím změnila. Nadiktujte název znovu.");
      return;
    }

    if (proposal.text === currentNote.title) {
      setProposal(null);
      setStatus("Název se nezměnil.");
      return;
    }

    savingRef.current = true;
    setIsSaving(true);
    setError(null);
    setStatus(null);

    try {
      const updated = await updateVoiceTitle(currentNote.id, {
        title: proposal.text,
        expectedVersion: proposal.baseVersion,
      });

      setProposal(null);
      dictation.clearTranscripts();
      setStatus("Název byl uložen.");
      onNoteUpdated?.(updated);
    } catch (saveError) {
      if (saveError instanceof NoteApiError && saveError.status === 409) {
        setProposal(null);
        setError(conflictMessage(saveError));
      } else {
        setError(
          saveError instanceof NoteApiError
            ? saveError.message
            : "Název se nepodařilo uložit.",
        );
      }
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }

  return (
    <section
      aria-labelledby="title-dictation-title"
      className="mt-6 rounded-2xl border border-stone-200 bg-white p-5"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2
            id="title-dictation-title"
            className="text-lg font-semibold text-stone-950"
          >
            Diktování názvu
          </h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            Nadiktujte jednu krátkou větu. Přepis se zobrazí jako návrh a do
            názvu se zapíše až po potvrzení.
          </p>
        </div>
        <p className="text-xs leading-5 text-stone-500 sm:max-w-xs sm:text-right">
          ElevenLabs Scribe v2 Realtime, relace max.{" "}
          {MICROPHONE_SESSION_MAX_MS / 1000} s. Rezervace až 0,0195 USD;
          skutečná cena může být neznámá. Zvuk se neukládá.
        </p>
      </div>

      {webLocksSupported === false ? (
        <p
          className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-900"
          role="alert"
        >
          Tento prohlížeč nepodporuje Web Locks, proto nelze bezpečně zajistit
          výhradní přístup k mikrofonu. Otevřete aplikaci v Chromiu nebo Edge.
        </p>
      ) : null}

      {webLocksSupported === null ? (
        <p className="mt-4 text-sm text-stone-600">
          Zjišťuji podporu výhradního mikrofonu…
        </p>
      ) : null}

      {disabled ? (
        <p className="mt-4 text-sm leading-6 text-stone-600">
          Nejprve uložte nebo zrušte neuložené změny textu, aby diktování
          názvu nepřepsalo obsah poznámky.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          type="button"
          onClick={handleStart}
          disabled={startDisabled}
        >
          {proposal === null ? "Nadiktovat název" : "Nadiktovat znovu"}
        </button>
        {busy ? (
          <button
            className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            type="button"
            onClick={handleStop}
            disabled={stopDisabled}
          >
            {isStopping ? "Ukončuji…" : "Stop"}
          </button>
        ) : null}
        {proposal !== null ? (
          <>
            <button
              className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
              type="button"
              onClick={() => void handleUse()}
              disabled={useDisabled}
            >
              {isSaving ? "Ukládám…" : "Použít název"}
            </button>
            <button
              className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
              type="button"
              onClick={handleCancel}
              disabled={isSaving}
            >
              Zrušit
            </button>
          </>
        ) : null}
      </div>

      <dl className="mt-4 grid gap-2 text-sm text-stone-700">
        <div className="flex gap-2">
          <dt className="font-semibold text-stone-900">Stav:</dt>
          <dd>
            {isStopping ? "Ukončuji…" : statusLabels[session.status]}
          </dd>
        </div>
      </dl>

      {busy ? (
        <div className="mt-4">
          <p className="text-sm font-medium text-stone-700">
            Průběžný přepis (nahrazuje se):
          </p>
          <p
            className="mt-1 min-h-6 rounded-lg bg-stone-100 p-3 text-stone-900"
            data-testid="title-partial"
            aria-live="polite"
          >
            {partialTranscript || "Čekám na řeč…"}
          </p>
        </div>
      ) : null}

      {proposal !== null ? (
        <div className="mt-4" data-testid="title-proposal">
          <p className="text-sm font-medium text-stone-700">Navržený název:</p>
          <p className="mt-1 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-lg font-semibold text-emerald-950">
            {proposal.text}
          </p>
        </div>
      ) : null}

      {proposalStale ? (
        <p
          className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950"
          role="alert"
        >
          Poznámka se mezitím změnila. Nadiktujte název znovu.
        </p>
      ) : null}

      {errorMessage ? (
        <p
          className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-900"
          role="alert"
        >
          {errorMessage}
        </p>
      ) : null}

      {statusMessage ? (
        <p
          className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm leading-6 text-emerald-900"
          aria-live="polite"
        >
          {statusMessage}
        </p>
      ) : null}
    </section>
  );
}

export type BodyInsertMode = "cursor" | "end";

export interface BodyDictationControlsProps {
  readonly onCommit: (text: string, mode: BodyInsertMode) => void;
  readonly disabled?: boolean;
  readonly disabledReason?: string | null;
}

export function BodyDictationControls({
  onCommit,
  disabled = false,
  disabledReason = null,
}: BodyDictationControlsProps) {
  const [insertAtEnd, setInsertAtEnd] = useState(false);
  const dictation = useScribeDictation({
    flushOnStop: true,
    onCommit: (segment) => {
      onCommit(segment.text, insertAtEnd ? "end" : "cursor");
    },
  });

  const {
    session,
    partialTranscript,
    webLocksSupported,
    isStopping,
    incompleteNotice,
  } = dictation;
  const busy = session.status !== "idle" && session.status !== "error";
  const startDisabled =
    disabled || webLocksSupported !== true || busy || isStopping;
  const stopDisabled =
    !busy || session.status === "stopping" || isStopping;

  function handleStart() {
    if (startDisabled) {
      return;
    }

    dictation.clearTranscripts();
    dictation.start();
  }

  function handleStop() {
    void dictation.stop();
  }

  return (
    <section
      aria-labelledby="body-dictation-title"
      className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-4"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3
            id="body-dictation-title"
            className="text-base font-semibold text-stone-950"
          >
            Diktování textu
          </h3>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            Potvrzené segmenty se vloží do rozpracovaného textu. Průběžný
            přepis zůstává jen v overlayi a do poznámky se nezapisuje.
          </p>
        </div>
        <p className="text-xs leading-5 text-stone-500 sm:max-w-xs sm:text-right">
          ElevenLabs Scribe v2 Realtime, relace max.{" "}
          {MICROPHONE_SESSION_MAX_MS / 1000} s. Rezervace až 0,0195 USD;
          skutečná cena může být neznámá. Zvuk se neukládá.
        </p>
      </div>

      {webLocksSupported === false ? (
        <p className="mt-3 text-sm leading-6 text-stone-700">
          Tento prohlížeč nepodporuje Web Locks, proto nelze bezpečně zajistit
          výhradní přístup k mikrofonu. Otevřete aplikaci v Chromiu nebo Edge.
        </p>
      ) : null}

      {webLocksSupported === null ? (
        <p className="mt-3 text-sm text-stone-600">
          Zjišťuji podporu výhradního mikrofonu…
        </p>
      ) : null}

      {disabled ? (
        <p className="mt-3 text-sm leading-6 text-stone-600">
          {disabledReason ??
            "Diktování textu je dostupné po vyřešení neuložených změn nebo limitu."}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          type="button"
          onClick={handleStart}
          disabled={startDisabled}
        >
          {busy ? "Diktování běží…" : "Diktovat text"}
        </button>
        {busy ? (
          <button
            className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            type="button"
            onClick={handleStop}
            disabled={stopDisabled}
          >
            {isStopping ? "Ukončuji…" : "Stop"}
          </button>
        ) : null}
        <label className="flex items-center gap-2 text-sm text-stone-700">
          <input
            type="checkbox"
            checked={insertAtEnd}
            onChange={(event) => setInsertAtEnd(event.target.checked)}
            disabled={busy || isStopping}
          />
          Vložit na konec
        </label>
      </div>

      <p className="mt-3 text-sm text-stone-700">
        Stav: {isStopping ? "Ukončuji…" : statusLabels[session.status]}
      </p>

      {busy ? (
        <div className="mt-3">
          <p className="text-sm font-medium text-stone-700">
            Průběžný přepis (nepíše se do poznámky):
          </p>
          <p
            className="mt-1 min-h-6 rounded-lg bg-white p-3 text-stone-900"
            data-testid="body-partial"
            aria-live="polite"
          >
            {partialTranscript || "Čekám na řeč…"}
          </p>
        </div>
      ) : null}

      {incompleteNotice ? (
        <p
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950"
          aria-live="polite"
        >
          {incompleteNotice}
        </p>
      ) : null}

      {session.error ? (
        <p
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-900"
          role="alert"
        >
          {session.error}
        </p>
      ) : null}
    </section>
  );
}
