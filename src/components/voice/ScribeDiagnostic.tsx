"use client";

import {
  CommitStrategy,
  useScribe,
  type ScribeStatus,
  type TranscriptSegment,
  type UseScribeReturn,
} from "@elevenlabs/react";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

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
  active: "Diktování běží",
  stopping: "Ukončuji diktování…",
  error: "Diktování se nepodařilo",
};

const providerStatusLabels: Record<ScribeStatus, string> = {
  disconnected: "Odpojeno",
  connecting: "Připojuji…",
  connected: "Připojeno",
  transcribing: "Přepisuji…",
  error: "Chyba připojení",
};

const costEstimateUsd = "0,0195";

const subscribeToWebLocks = () => () => undefined;
const getWebLocksSnapshot = () => isWebLocksSupported();
const getWebLocksServerSnapshot = () => null;

export interface ScribeDiagnosticViewProps {
  readonly status: MicrophoneSessionStatus;
  readonly providerStatus: ScribeStatus;
  readonly error: string | null;
  readonly providerError: string | null;
  readonly notice: string | null;
  readonly partialTranscript: string;
  readonly committedTranscripts: readonly Pick<
    TranscriptSegment,
    "id" | "text"
  >[];
  readonly webLocksSupported: boolean | null;
  readonly onStart: () => void;
  readonly onStop: () => void;
}

export function ScribeDiagnosticView({
  status,
  providerStatus,
  error,
  providerError,
  notice,
  partialTranscript,
  committedTranscripts,
  webLocksSupported,
  onStart,
  onStop,
}: ScribeDiagnosticViewProps) {
  const busy = status !== "idle" && status !== "error";
  const startDisabled = webLocksSupported !== true || busy;
  const stopDisabled = !busy || status === "stopping";

  return (
    <div className="mt-8 space-y-6">
      <section
        aria-labelledby="diagnostic-cost-title"
        className="rounded-2xl border border-amber-200 bg-amber-50 p-6"
      >
        <h2
          id="diagnostic-cost-title"
          className="text-lg font-semibold text-amber-950"
        >
          Placená relace a soukromí
        </h2>
        <p className="mt-3 text-sm leading-6 text-amber-950">
          Start odešle zvuk z mikrofonu přímo službě ElevenLabs Scribe v2
          Realtime, model <code className="rounded bg-amber-100 px-1.5 py-0.5">{SCRIBE_MODEL_ID}</code>.
          Maximální délka relace je {MICROPHONE_SESSION_MAX_MS / 1000} s a VAD
          ticho{" "}
          {SCRIBE_VAD_SILENCE_THRESHOLD_SECS.toLocaleString("cs-CZ")} s. Odhad
          ceny je nejvýše {costEstimateUsd} USD za relaci; skutečná cena může
          být neznámá. Diktování se nespouští samo a přepis se v této fázi
          neukládá do poznámek.
        </p>
      </section>

      <section
        aria-labelledby="diagnostic-controls-title"
        className="rounded-2xl border border-stone-200 bg-white p-6"
      >
        <h2
          id="diagnostic-controls-title"
          className="text-lg font-semibold text-stone-950"
        >
          Ovládání mikrofonu
        </h2>

        {webLocksSupported === false ? (
          <p
            className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-900"
            role="alert"
          >
            Tento prohlížeč nepodporuje Web Locks, proto nelze bezpečně
            zajistit výhradní přístup k mikrofonu. Otevřete aplikaci v Chromiu
            nebo Edge.
          </p>
        ) : null}

        {webLocksSupported === null ? (
          <p className="mt-3 text-sm text-stone-600" role="status">
            Zjišťuji podporu výhradního mikrofonu…
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            type="button"
            onClick={onStart}
            disabled={startDisabled}
          >
            Start diktování
          </button>
          <button
            className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            type="button"
            onClick={onStop}
            disabled={stopDisabled}
          >
            Stop
          </button>
        </div>

        <dl className="mt-5 grid gap-2 text-sm text-stone-700">
          <div className="flex gap-2">
            <dt className="font-semibold text-stone-900">Stav:</dt>
            <dd role="status">{statusLabels[status]}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-semibold text-stone-900">Připojení:</dt>
            <dd>{providerStatusLabels[providerStatus]}</dd>
          </div>
        </dl>

        {error ? (
          <p
            className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-900"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        {notice ? (
          <p
            className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm leading-6 text-emerald-900"
            role="status"
          >
            {notice}
          </p>
        ) : null}

        {providerError ? (
          <details className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
            <summary className="cursor-pointer font-semibold text-stone-900">
              Technický detail od poskytovatele
            </summary>
            <p className="mt-2 break-words font-mono text-xs text-stone-700">
              {providerError}
            </p>
          </details>
        ) : null}
      </section>

      <section
        aria-labelledby="diagnostic-transcript-title"
        className="rounded-2xl border border-stone-200 bg-white p-6"
      >
        <h2
          id="diagnostic-transcript-title"
          className="text-lg font-semibold text-stone-950"
        >
          Živý přepis
        </h2>
        <p className="mt-3 text-sm font-medium text-stone-700">
          Částečný přepis (nahrazuje se):
        </p>
        <p
          className="mt-1 min-h-6 rounded-lg bg-stone-100 p-3 text-stone-900"
          data-testid="partial-transcript"
          aria-live="polite"
        >
          {partialTranscript || "Zatím žádný částečný přepis."}
        </p>

        <h3 className="mt-6 text-sm font-semibold text-stone-900">
          Ukončené segmenty
        </h3>
        {committedTranscripts.length === 0 ? (
          <p className="mt-2 text-sm text-stone-600">
            Zatím žádné ukončené segmenty.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {committedTranscripts.map((transcript) => (
              <li
                className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-stone-900"
                data-testid="committed-transcript"
                key={transcript.id}
              >
                {transcript.text}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function ScribeDiagnostic() {
  const [session, setSession] = useState<MicrophoneSessionState>(
    INITIAL_MICROPHONE_SESSION_STATE,
  );
  const sessionIdRef = useRef<number | null>(null);
  const scribeRef = useRef<UseScribeReturn | null>(null);
  const controllerRef = useRef<MicrophoneSessionController | null>(null);

  function notifySessionError(message: string) {
    const sessionId = sessionIdRef.current;

    if (sessionId !== null) {
      void controllerRef.current?.notifyError(sessionId, message);
    }
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
    onError: (error) => {
      const sessionId = sessionIdRef.current;

      if (sessionId !== null) {
        void controllerRef.current?.notifyError(
          sessionId,
          toCzechSessionError(error),
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

  function handleStart() {
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
          currentScribe.clearTranscripts();
          await currentScribe.connect({ token });
        },
        stopSession: () => {
          sessionIdRef.current = null;
          scribeRef.current?.disconnect();
        },
        onStateChange: setSession,
      });
      controllerRef.current = controller;
    }

    void controller.start();
  }

  function handleStop() {
    void controllerRef.current?.stop("user");
  }

  return (
    <ScribeDiagnosticView
      status={session.status}
      providerStatus={scribe.status}
      error={session.error}
      providerError={scribe.error}
      notice={session.notice}
      partialTranscript={scribe.partialTranscript}
      committedTranscripts={scribe.committedTranscripts}
      webLocksSupported={webLocksSupported}
      onStart={handleStart}
      onStop={handleStop}
    />
  );
}
