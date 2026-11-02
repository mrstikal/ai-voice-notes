"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  NoteApiError,
  fetchNote,
  updateNote,
  updateVoiceTitle,
  type NoteDetail,
} from "@/lib/notes/client";
import {
  CONTENT_MAX_GRAPHEMES,
  TITLE_MAX_GRAPHEMES,
  countGraphemes,
} from "@/lib/notes/limits";
import {
  getMediaActivityServerSnapshot,
  getMediaActivitySnapshot,
  subscribeMediaActivity,
} from "@/lib/media/activity";
import {
  getVoiceDiagnosticsServerSnapshot,
  getVoiceDiagnosticsSnapshot,
  subscribeVoiceDiagnostics,
} from "@/lib/voice/diagnostics";
import {
  INITIAL_VOICE_FORMAT_STATE,
  type VoiceFormatState,
} from "@/lib/voice/format-state";
import {
  MICROPHONE_SESSION_MAX_MS,
  type MicrophoneSessionStatus,
} from "@/lib/voice/microphone";
import {
  VAD_SILENCE_OPTIONS,
  formatVadSilence,
  getVadSilencePreferenceServerSnapshot,
  getVadSilencePreferenceSnapshot,
  isVadSilenceSecs,
  subscribeVadSilencePreference,
  writeVadSilencePreference,
} from "@/lib/voice/preferences";
import {
  VoiceFormattingSession,
  type VoiceFormattingBatch,
} from "@/lib/voice/transcript-session";

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
  const [titleInput, setTitleInput] = useState(note.title);
  const [lastDictatedText, setLastDictatedText] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const savingRef = useRef(false);
  const lastSyncedTitleRef = useRef(note.title);

  useEffect(() => {
    setTitleInput((current) =>
      current === lastSyncedTitleRef.current ? note.title : current,
    );
    lastSyncedTitleRef.current = note.title;
  }, [note.title]);

  const vadSilence = useSyncExternalStore(
    subscribeVadSilencePreference,
    getVadSilencePreferenceSnapshot,
    getVadSilencePreferenceServerSnapshot,
  );
  const media = useSyncExternalStore(
    subscribeMediaActivity,
    getMediaActivitySnapshot,
    getMediaActivityServerSnapshot,
  );

  const dictation = useScribeDictation({
    stopAfterFirstCommit: true,
    flushOnStop: false,
    vadSilenceThresholdSecs: vadSilence,
    onCommit: (segment) => {
      const text = segment.text.replace(/\s+/gu, " ").trim();

      if (text === "") {
        return;
      }

      const graphemes = countGraphemes(text);

      if (graphemes > TITLE_MAX_GRAPHEMES) {
        setError(
          `Nadiktovaný název má ${graphemes} znaků; maximum je ${TITLE_MAX_GRAPHEMES}. Zkuste kratší.`,
        );
        setStatus(null);
        return;
      }

      setTitleInput(text);
      setLastDictatedText(text);
      setError(null);
      setStatus("Název je připravený. Zkontrolujte jej a uložte.");
    },
  });

  const { session, partialTranscript, webLocksSupported, isStopping } =
    dictation;
  const busy = session.status !== "idle" && session.status !== "error";
  const trimmedTitle = titleInput.trim();
  const titleGraphemes = countGraphemes(trimmedTitle);
  const titleOverLimit = titleGraphemes > TITLE_MAX_GRAPHEMES;
  const titleUnchanged = trimmedTitle === note.title;
  const startDisabled =
    disabled ||
    media.playbackActive ||
    webLocksSupported !== true ||
    busy ||
    isStopping ||
    isSaving;
  const stopDisabled =
    !busy || session.status === "stopping" || isStopping || isSaving;
  const saveDisabled =
    disabled || isSaving || titleUnchanged || titleOverLimit;
  const errorMessage = error ?? session.error;
  const statusMessage = status ?? session.notice;

  function handleStart() {
    if (startDisabled) {
      return;
    }

    setError(null);
    setStatus(null);
    dictation.clearTranscripts();
    dictation.start();
  }

  function handleStop() {
    setError(null);
    setStatus("Diktování názvu bylo ukončeno.");
    dictation.clearTranscripts();
    void dictation.stop({ flush: false });
  }

  function handleTitleChange(value: string) {
    setTitleInput(value);
    setLastDictatedText(null);
    setError(null);
    setStatus(null);
  }

  async function handleSave() {
    if (saveDisabled || savingRef.current) {
      return;
    }

    const nextTitle = titleInput.trim();

    if (countGraphemes(nextTitle) > TITLE_MAX_GRAPHEMES) {
      setError(
        `Název může mít nejvýše ${TITLE_MAX_GRAPHEMES} viditelných znaků.`,
      );
      return;
    }

    if (nextTitle === note.title) {
      setStatus("Název se nezměnil.");
      return;
    }

    savingRef.current = true;
    setIsSaving(true);
    setError(null);
    setStatus(null);

    try {
      const updated =
        lastDictatedText !== null && nextTitle === lastDictatedText
          ? await updateVoiceTitle(note.id, {
              title: nextTitle,
              expectedVersion: note.version,
            })
          : await updateNote(note.id, {
              title: nextTitle,
              contentMd: note.contentMd,
              expectedVersion: note.version,
            });

      setTitleInput(updated.title);
      setLastDictatedText(null);
      dictation.clearTranscripts();
      setStatus("Název byl uložen.");
      onNoteUpdated?.(updated);
    } catch (saveError) {
      if (saveError instanceof NoteApiError && saveError.status === 409) {
        setError(conflictMessage(saveError));

        try {
          const latest = await fetchNote(note.id);
          onNoteUpdated?.(latest);
          setTitleInput(latest.title);
          setLastDictatedText(null);
        } catch {
          // Keep the local input; the user can retry after the note refreshes.
        }
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
      aria-labelledby="note-title-heading"
      className="mt-6 rounded-2xl border border-stone-200 bg-white p-5"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2
            id="note-title-heading"
            className="text-lg font-semibold text-stone-950"
          >
            Název poznámky
          </h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            Název můžete zadat ručně nebo nadiktovat. Uloží se až po potvrzení.
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
          Nejprve uložte nebo zrušte neuložené změny textu, aby uložení názvu
          nepřepsalo obsah poznámky.
        </p>
      ) : null}

      {media.playbackActive ? (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
          Během přehrávání čtení nahlas nelze diktovat. Nejprve přehrávání
          zastavte.
        </p>
      ) : null}

      {!busy && media.dictationActive ? (
        <p className="mt-4 text-sm leading-6 text-stone-700">
          Mikrofon právě používá jiný režim. Diktování názvu bude dostupné po
          jeho ukončení.
        </p>
      ) : null}

      <div className="mt-4 space-y-2">
        <label
          className="block text-sm font-medium text-stone-800"
          htmlFor="note-title-input"
        >
          Název poznámky
        </label>
        <input
          className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:bg-stone-100"
          disabled={isSaving}
          id="note-title-input"
          onChange={(event) => handleTitleChange(event.target.value)}
          type="text"
          value={titleInput}
        />
        <p
          className={
            titleOverLimit
              ? "text-xs font-medium text-red-800"
              : "text-xs text-stone-500"
          }
        >
          {titleGraphemes} / {TITLE_MAX_GRAPHEMES} viditelných znaků.
        </p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          type="button"
          onClick={handleStart}
          disabled={startDisabled}
        >
          {busy
            ? "Diktování běží…"
            : lastDictatedText !== null
              ? "Nadiktovat znovu"
              : "Nadiktovat název"}
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
        <button
          className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          type="button"
          onClick={() => void handleSave()}
          disabled={saveDisabled}
        >
          {isSaving ? "Ukládám…" : "Uložit název"}
        </button>
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

export interface VoiceApplyResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly notice?: string;
}

export interface BodyDictationControlsProps {
  readonly onApplyBatch: (
    batch: VoiceFormattingBatch,
    mode: BodyInsertMode,
  ) => VoiceApplyResult;
  readonly contentGraphemeCount: number;
  readonly targetMode: "source" | "visual";
  readonly disabled?: boolean;
  readonly disabledReason?: string | null;
  readonly onSessionStart?: () => void;
  readonly onSessionComplete?: () => void | Promise<void>;
}

function formatCount(value: number): string {
  return value.toLocaleString("cs-CZ");
}

function formatLatency(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("cs-CZ")} ms`;
}

function describeFormatState(state: VoiceFormatState): string {
  const parts: string[] = [];

  if (state.marks.includes("strong")) {
    parts.push("tučně");
  }

  if (state.marks.includes("emphasis")) {
    parts.push("kurzívou");
  }

  if (state.listVariant === "task") {
    parts.push(state.listItemOpen ? "úkol" : "seznam úkolů");
  } else if (state.listVariant === "bullet") {
    parts.push(state.listItemOpen ? "položka seznamu" : "seznam");
  }

  return parts.length > 0 ? parts.join(", ") : "bez formátování";
}

export function BodyDictationControls({
  onApplyBatch,
  contentGraphemeCount,
  targetMode,
  disabled = false,
  disabledReason = null,
  onSessionStart,
  onSessionComplete,
}: BodyDictationControlsProps) {
  const [insertAtEnd, setInsertAtEnd] = useState(false);
  const [commandLog, setCommandLog] = useState<readonly string[]>([]);
  const [formatState, setFormatState] = useState<VoiceFormatState>(
    INITIAL_VOICE_FORMAT_STATE,
  );
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyNotice, setApplyNotice] = useState<string | null>(null);
  const formattingSessionRef = useRef(new VoiceFormattingSession());
  const insertAtEndRef = useRef(insertAtEnd);
  const onApplyBatchRef = useRef(onApplyBatch);
  const onSessionStartRef = useRef(onSessionStart);
  const onSessionCompleteRef = useRef(onSessionComplete);
  const applyBatchRef = useRef<(batch: VoiceFormattingBatch) => boolean>(
    () => true,
  );
  const stopDictationRef = useRef<
    (options?: { flush?: boolean }) => Promise<void>
  >(() => Promise.resolve());
  const previousStatusRef = useRef<MicrophoneSessionStatus>("idle");
  const vadSilence = useSyncExternalStore(
    subscribeVadSilencePreference,
    getVadSilencePreferenceSnapshot,
    getVadSilencePreferenceServerSnapshot,
  );
  const diagnostics = useSyncExternalStore(
    subscribeVoiceDiagnostics,
    getVoiceDiagnosticsSnapshot,
    getVoiceDiagnosticsServerSnapshot,
  );
  const media = useSyncExternalStore(
    subscribeMediaActivity,
    getMediaActivitySnapshot,
    getMediaActivityServerSnapshot,
  );

  useEffect(() => {
    insertAtEndRef.current = insertAtEnd;
  }, [insertAtEnd]);

  useEffect(() => {
    onApplyBatchRef.current = onApplyBatch;
  }, [onApplyBatch]);

  useEffect(() => {
    onSessionStartRef.current = onSessionStart;
  }, [onSessionStart]);

  useEffect(() => {
    onSessionCompleteRef.current = onSessionComplete;
  }, [onSessionComplete]);

  const applyBatch = useCallback((batch: VoiceFormattingBatch): boolean => {
    setFormatState(batch.stateAfter);

    if (batch.labels.length > 0) {
      setCommandLog((current) => [...current, ...batch.labels].slice(-12));
    }

    const result = onApplyBatchRef.current(
      batch,
      insertAtEndRef.current ? "end" : "cursor",
    );
    setApplyNotice(result.notice ?? null);

    if (!result.ok) {
      setApplyError(
        result.message ?? "Diktovaný text se nepodařilo vložit.",
      );
      formattingSessionRef.current.reset();
      setFormatState(INITIAL_VOICE_FORMAT_STATE);
      void stopDictationRef.current({ flush: false });
      return false;
    }

    setApplyError(null);
    return true;
  }, []);

  useEffect(() => {
    applyBatchRef.current = applyBatch;
  }, [applyBatch]);

  const dictation = useScribeDictation({
    flushOnStop: true,
    vadSilenceThresholdSecs: vadSilence,
    onBeforeSessionClose: () => {
      const batch = formattingSessionRef.current.flush();
      applyBatchRef.current(batch);
    },
    onCommit: (segment) => {
      const batch = formattingSessionRef.current.accept(segment.text);
      const applied = applyBatchRef.current(batch);

      if (batch.stopped && applied) {
        void stopDictationRef.current({ flush: false }).then(() => {
          void onSessionCompleteRef.current?.();
        });
      }
    },
  });

  const stopDictation = dictation.stop;

  useEffect(() => {
    stopDictationRef.current = stopDictation;
  }, [stopDictation]);

  const {
    session,
    partialTranscript,
    webLocksSupported,
    isStopping,
    incompleteNotice,
  } = dictation;
  const busy = session.status !== "idle" && session.status !== "error";
  const startDisabled =
    disabled ||
    media.playbackActive ||
    webLocksSupported !== true ||
    busy ||
    isStopping;
  const stopDisabled =
    !busy || session.status === "stopping" || isStopping;
  const partialGraphemeCount = useMemo(
    () => countGraphemes(partialTranscript),
    [partialTranscript],
  );
  const approximateCount = contentGraphemeCount + partialGraphemeCount;
  const approximateOverLimit = approximateCount > CONTENT_MAX_GRAPHEMES;

  useEffect(() => {
    if (disabled && busy && !isStopping) {
      void stopDictation({ flush: false });
    }
  }, [busy, disabled, isStopping, stopDictation]);

  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = session.status;

    if (session.status === "error" && previous !== "error") {
      const flushed = formattingSessionRef.current.flush();
      formattingSessionRef.current.reset();

      const applied =
        flushed.parts.length > 0
          ? applyBatchRef.current(flushed)
          : true;

      if (flushed.parts.length === 0) {
        setApplyError(null);
        setApplyNotice(null);
      }

      setFormatState(INITIAL_VOICE_FORMAT_STATE);
      setCommandLog([]);

      if (applied) {
        void onSessionCompleteRef.current?.();
      }
    }
  }, [session.status]);

  function handleStart() {
    if (startDisabled) {
      return;
    }

    formattingSessionRef.current.startNewSession();
    setFormatState(INITIAL_VOICE_FORMAT_STATE);
    setCommandLog([]);
    setApplyError(null);
    setApplyNotice(null);
    onSessionStartRef.current?.();
    dictation.clearTranscripts();
    dictation.start();
  }

  function handleStop() {
    setApplyError(null);
    void dictation.stop().then(() => {
      void onSessionCompleteRef.current?.();
    });
  }

  function handleVadSilenceChange(value: string) {
    const parsed = Number(value);

    if (isVadSilenceSecs(parsed)) {
      writeVadSilencePreference(parsed);
    }
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
            Potvrzené segmenty se vloží do rozpracovaného textu. České
            formátovací příkazy se zpracují až z potvrzeného přepisu; průběžný
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

      {media.playbackActive ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
          Během přehrávání čtení nahlas nelze diktovat. Nejprve přehrávání
          zastavte.
        </p>
      ) : null}

      {!busy && media.dictationActive ? (
        <p className="mt-3 text-sm leading-6 text-stone-700">
          Mikrofon právě používá jiný režim. Diktování textu bude dostupné po
          jeho ukončení.
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
        <label className="flex items-center gap-2 text-sm text-stone-700">
          Prodleva ticha (VAD)
          <select
            className="rounded-lg border border-stone-300 bg-white px-2 py-1 text-sm text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:bg-stone-100"
            data-testid="vad-silence-select"
            disabled={busy || isStopping}
            onChange={(event) => handleVadSilenceChange(event.target.value)}
            value={vadSilence}
          >
            {VAD_SILENCE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {formatVadSilence(option)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="mt-2 text-xs leading-5 text-stone-500">
        VAD se předává ElevenLabs Scribe SDK pro příští relaci; změna během
        běžícího diktování se projeví až po novém Startu.
      </p>

      <p className="mt-3 text-sm text-stone-700" data-testid="voice-insert-mode">
        Režim vkládání:{" "}
        {targetMode === "visual"
          ? "vizuální editor; formátovací příkazy na konec"
          : insertAtEnd
            ? "na konec"
            : "na kurzor"}
      </p>

      <div className="mt-2 space-y-1 text-sm text-stone-700">
        <p data-testid="voice-format-state">
          Formát: {describeFormatState(formatState)}
        </p>
        {commandLog.length > 0 ? (
          <p data-testid="voice-command-feedback">
            Poslední příkazy: {commandLog.join(" · ")}
          </p>
        ) : null}
        {applyNotice !== null ? (
          <p aria-live="polite" className="text-amber-900">
            {applyNotice}
          </p>
        ) : null}
      </div>

      <p className="mt-2 text-sm text-stone-700">
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
          <p
            className={
              approximateOverLimit
                ? "mt-2 text-sm font-semibold text-red-800"
                : "mt-2 text-sm text-stone-600"
            }
            data-testid="voice-approximate-count"
          >
            Přibližně {formatCount(approximateCount)} /{" "}
            {formatCount(CONTENT_MAX_GRAPHEMES)} viditelných znaků včetně
            průběžného přepisu. Přesný počet se ověří při vložení.
          </p>
          {approximateOverLimit ? (
            <p className="mt-1 text-sm text-red-800" role="alert">
              Přibližný počet překračuje limit. Vložení bude odmítnuto a
              stávající obsah zůstane beze změny.
            </p>
          ) : null}
        </div>
      ) : null}

      <p
        className="mt-3 text-xs leading-5 text-stone-500"
        data-testid="voice-diagnostics"
      >
        {`Diagnostika v paměti: potvrzení ${formatLatency(
          diagnostics.lastCommitLatencyMs,
        )}, příkaz ${formatLatency(
          diagnostics.lastCommandLatencyMs,
        )}, ruční reconnecty (všechna diktování) ${diagnostics.manualReconnectCount.toLocaleString(
          "cs-CZ",
        )}. Zvuk ani přepis se nelogují.`}
      </p>

      {incompleteNotice ? (
        <p
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950"
          aria-live="polite"
        >
          {incompleteNotice}
        </p>
      ) : null}

      {applyError ? (
        <p
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-900"
          role="alert"
        >
          {applyError}
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
