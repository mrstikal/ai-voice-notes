"use client";

import {
  CommitStrategy,
  RealtimeEvents,
  useScribe,
  type UseScribeReturn,
} from "@elevenlabs/react";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

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
  INITIAL_MICROPHONE_SESSION_STATE,
  MICROPHONE_SESSION_MAX_MS,
  SCRIBE_LANGUAGE_CODE,
  SCRIBE_MODEL_ID,
  SCRIBE_VAD_SILENCE_THRESHOLD_SECS,
  MicrophoneSessionController,
  isWebLocksSupported,
  requestScribeToken,
  toCzechSessionError,
  type MicrophoneSessionState,
  type MicrophoneSessionStatus,
} from "@/lib/voice/microphone";

const statusLabels: Record<MicrophoneSessionStatus, string> = {
  idle: "Připraveno",
  "acquiring-lease": "Získávám výhradní přístup k mikrofonu…",
  "requesting-token": "Připravuji token pro diktování…",
  connecting: "Připojuji k ElevenLabs…",
  active: "Poslouchám…",
  stopping: "Ukončuji diktování…",
  error: "Diktování se nepodařilo",
};

const subscribeToWebLocks = () => () => undefined;
const getWebLocksSnapshot = () => isWebLocksSupported();
const getWebLocksServerSnapshot = () => null;

type ScribeConnection = NonNullable<
  ReturnType<UseScribeReturn["getConnection"]>
>;
type CommittedTranscriptListener = (data: { text: string }) => void;

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
  const [session, setSession] = useState<MicrophoneSessionState>(
    INITIAL_MICROPHONE_SESSION_STATE,
  );
  const [proposal, setProposal] = useState<TitleProposal | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const sessionIdRef = useRef<number | null>(null);
  const scribeRef = useRef<UseScribeReturn | null>(null);
  const controllerRef = useRef<MicrophoneSessionController | null>(null);
  const capturedSessionRef = useRef<number | null>(null);
  const committedListenerRef = useRef<{
    connection: ScribeConnection;
    listener: CommittedTranscriptListener;
  } | null>(null);
  const savingRef = useRef(false);
  const noteRef = useRef(note);

  useEffect(() => {
    noteRef.current = note;
  }, [note]);

  function notifySessionError(message: string) {
    const sessionId = sessionIdRef.current;

    if (sessionId !== null) {
      void controllerRef.current?.notifyError(sessionId, message);
    }
  }

  function handleCommittedTranscript(rawText: string, sessionId: number) {
    if (
      sessionId !== sessionIdRef.current ||
      capturedSessionRef.current === sessionId
    ) {
      return;
    }

    const text = rawText.replace(/\s+/gu, " ").trim();

    if (!text) {
      return;
    }

    capturedSessionRef.current = sessionId;
    const graphemes = countGraphemes(text);

    if (graphemes > TITLE_MAX_GRAPHEMES) {
      setProposal(null);
      setError(
        `Nadiktovaný název má ${graphemes} znaků; maximum je ${TITLE_MAX_GRAPHEMES}. Zkuste kratší.`,
      );
      setStatus(null);
      void controllerRef.current?.stop("user");
      return;
    }

    setProposal({
      text,
      baseVersion: noteRef.current.version,
    });
    setError(null);
    setStatus("Název je připravený. Zkontrolujte jej a použijte.");
    void controllerRef.current?.stop("user");
  }

  const scribe = useScribe({
    modelId: SCRIBE_MODEL_ID,
    languageCode: SCRIBE_LANGUAGE_CODE,
    commitStrategy: CommitStrategy.VAD,
    vadSilenceThresholdSecs: SCRIBE_VAD_SILENCE_THRESHOLD_SECS,
    microphone: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    onSessionStarted: () => {
      const sessionId = sessionIdRef.current;

      if (sessionId !== null) {
        controllerRef.current?.notifyConnected(sessionId);
      }
    },
    onDisconnect: () => {
      const sessionId = sessionIdRef.current;

      if (sessionId !== null) {
        void controllerRef.current?.notifyDisconnected(sessionId);
      }
    },
    onError: (sessionError) => {
      const sessionId = sessionIdRef.current;

      if (sessionId !== null) {
        void controllerRef.current?.notifyError(
          sessionId,
          toCzechSessionError(sessionError),
        );
      }
    },
    onAuthError: () => {
      notifySessionError(
        "Token pro diktování byl odmítnut. Zkuste to znovu.",
      );
    },
    onQuotaExceededError: () => {
      notifySessionError(
        "Byl vyčerpán limit ElevenLabs. Zkontrolujte nastavení účtu.",
      );
    },
    onRateLimitedError: () => {
      notifySessionError(
        "ElevenLabs dočasně omezil požadavky. Zkuste to znovu později.",
      );
    },
    onSessionTimeLimitExceededError: () => {
      notifySessionError(
        "Poskytovatel ukončil relaci z důvodu časového limitu.",
      );
    },
    onTranscriberError: () => {
      notifySessionError(
        "Přepisovač ElevenLabs hlásí chybu. Zkuste to znovu.",
      );
    },
    onUnacceptedTermsError: () => {
      notifySessionError(
        "Účet ElevenLabs nemá přijaté podmínky. Přijměte je v nastavení účtu.",
      );
    },
    onInputError: () => {
      notifySessionError(
        "Zvukový vstup byl odmítnut. Zkontrolujte mikrofon.",
      );
    },
    onQueueOverflowError: () => {
      notifySessionError(
        "Fronta ElevenLabs je plná. Zkuste to znovu později.",
      );
    },
    onResourceExhaustedError: () => {
      notifySessionError(
        "Prostředky ElevenLabs jsou vyčerpané. Zkuste to znovu později.",
      );
    },
    onChunkSizeExceededError: () => {
      notifySessionError(
        "Zvuková data byla příliš velká. Zkuste to znovu.",
      );
    },
    onInsufficientAudioActivityError: () => {
      notifySessionError(
        "Nebyl zachycen dostatek zvuku. Zkontrolujte mikrofon.",
      );
    },
    onCommitThrottledError: () => {
      notifySessionError(
        "ElevenLabs dočasně omezil ukončování segmentů. Zkuste to znovu.",
      );
    },
  });

  useEffect(() => {
    scribeRef.current = scribe;
  }, [scribe]);

  useEffect(() => {
    return () => {
      void controllerRef.current?.stop("unmount");
    };
  }, []);

  const webLocksSupported = useSyncExternalStore(
    subscribeToWebLocks,
    getWebLocksSnapshot,
    getWebLocksServerSnapshot,
  );

  function getOrCreateController(): MicrophoneSessionController {
    let controller = controllerRef.current;

    if (controller === null) {
      controller = new MicrophoneSessionController({
        requestToken: () => requestScribeToken(),
        startSession: async (token, sessionId) => {
          const currentScribe = scribeRef.current;

          if (currentScribe === null) {
            throw new Error("Scribe není připravený.");
          }

          sessionIdRef.current = sessionId;
          capturedSessionRef.current = null;
          currentScribe.clearTranscripts();
          await currentScribe.connect({ token });

          const connection = currentScribe.getConnection();

          if (connection === null) {
            throw new Error("Scribe spojení není dostupné.");
          }

          const listener: CommittedTranscriptListener = (data) => {
            handleCommittedTranscript(data.text, sessionId);
          };

          connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, listener);
          committedListenerRef.current = { connection, listener };
        },
        stopSession: () => {
          const committedListener = committedListenerRef.current;
          committedListenerRef.current = null;
          committedListener?.connection.off(
            RealtimeEvents.COMMITTED_TRANSCRIPT,
            committedListener.listener,
          );
          sessionIdRef.current = null;
          scribeRef.current?.disconnect();
        },
        onStateChange: setSession,
      });
      controllerRef.current = controller;
    }

    return controller;
  }

  const proposalStale =
    proposal !== null && note.version !== proposal.baseVersion;
  const busy = session.status !== "idle" && session.status !== "error";
  const startDisabled =
    disabled || webLocksSupported !== true || busy || isSaving;
  const stopDisabled =
    !busy || session.status === "stopping" || isSaving;
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
    capturedSessionRef.current = null;
    scribeRef.current?.clearTranscripts();
    void getOrCreateController().start();
  }

  function handleStop() {
    setProposal(null);
    setError(null);
    setStatus("Diktování názvu bylo zrušeno.");
    scribeRef.current?.clearTranscripts();
    void controllerRef.current?.stop("user");
  }

  function handleCancel() {
    setProposal(null);
    setError(null);
    setStatus("Návrh názvu byl zrušen.");
    scribeRef.current?.clearTranscripts();
    void controllerRef.current?.stop("user");
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
      scribeRef.current?.clearTranscripts();
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
            Stop
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
          <dd>{statusLabels[session.status]}</dd>
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
            {scribe.partialTranscript || "Čekám na řeč…"}
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
