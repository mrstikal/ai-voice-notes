"use client";

import {
  CommitStrategy,
  RealtimeEvents,
  useScribe,
  type ScribeStatus,
  type UseScribeReturn,
} from "@elevenlabs/react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  setMicrophoneOwnerActive,
} from "@/lib/media/activity";
import {
  INITIAL_MICROPHONE_SESSION_STATE,
  SCRIBE_LANGUAGE_CODE,
  SCRIBE_MODEL_ID,
  SCRIBE_VAD_SILENCE_THRESHOLD_SECS,
  MicrophoneSessionController,
  isWebLocksSupported,
  requestScribeToken,
  toCzechSessionError,
  type MicrophoneSessionState,
} from "@/lib/voice/microphone";
import {
  recordVoiceCommandLatency,
  recordVoiceCommitLatency,
  recordVoiceManualReconnect,
} from "@/lib/voice/diagnostics";
import {
  TranscriptSession,
  type AcceptedTranscriptSegment,
} from "@/lib/voice/transcript-session";

export const FINAL_COMMIT_TIMEOUT_MS = 1500;
export const FLUSH_SETTLE_MS = 150;

const subscribeToWebLocks = () => () => undefined;
const getWebLocksSnapshot = () => isWebLocksSupported();
const getWebLocksServerSnapshot = () => null;

function isConnectionLostError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  return /websocket (closed unexpectedly|error)|connection (lost|closed)|network (error|failure)/iu.test(
    message,
  );
}

type ScribeConnection = NonNullable<
  ReturnType<UseScribeReturn["getConnection"]>
>;
type CommittedListener = (data: {
  text: string;
  id?: string;
  provider_id?: string;
}) => void;

export interface ScribeCommitMetadata {
  readonly commandLatencyMs: number | null;
}

export interface UseScribeDictationOptions {
  readonly onCommit: (
    segment: AcceptedTranscriptSegment,
    metadata: ScribeCommitMetadata,
  ) => void;
  readonly activityKind?: "dictation" | "stop-monitor";
  readonly lockMode?: "exclusive" | "shared";
  readonly stopAfterFirstCommit?: boolean;
  readonly flushOnStop?: boolean;
  readonly vadSilenceThresholdSecs?: number;
  readonly onBeforeSessionClose?: () => void;
}

export interface UseScribeDictationResult {
  readonly session: MicrophoneSessionState;
  readonly partialTranscript: string;
  readonly providerStatus: ScribeStatus;
  readonly providerError: string | null;
  readonly webLocksSupported: boolean | null;
  readonly isStopping: boolean;
  readonly incompleteNotice: string | null;
  readonly start: () => void;
  readonly stop: (options?: { flush?: boolean }) => Promise<void>;
  readonly commit: () => void;
  readonly clearTranscripts: () => void;
}

function readProviderId(data: {
  id?: unknown;
  provider_id?: unknown;
}): string | null {
  if (typeof data.id === "string" && data.id.trim() !== "") {
    return data.id;
  }

  if (typeof data.provider_id === "string" && data.provider_id.trim() !== "") {
    return data.provider_id;
  }

  return null;
}

export function useScribeDictation(
  options: UseScribeDictationOptions,
): UseScribeDictationResult {
  const [session, setSession] = useState<MicrophoneSessionState>(
    INITIAL_MICROPHONE_SESSION_STATE,
  );
  const [isStopping, setIsStopping] = useState(false);
  const [incompleteNotice, setIncompleteNotice] = useState<string | null>(
    null,
  );
  const mediaOwnerId = useId();
  const sessionIdRef = useRef<number | null>(null);
  const scribeRef = useRef<UseScribeReturn | null>(null);
  const controllerRef = useRef<MicrophoneSessionController | null>(null);
  const committedListenerRef = useRef<{
    connection: ScribeConnection;
    listener: CommittedListener;
  } | null>(null);
  const transcriptSessionRef = useRef<TranscriptSession | null>(null);
  const finalCommitResolverRef = useRef<(() => void) | null>(null);
  const flushQuietTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const stoppingPromiseRef = useRef<Promise<void> | null>(null);
  const onCommitRef = useRef(options.onCommit);
  const stopAfterFirstCommitRef = useRef(
    options.stopAfterFirstCommit ?? false,
  );
  const flushOnStopRef = useRef(options.flushOnStop ?? true);
  const vadSilenceRef = useRef(
    options.vadSilenceThresholdSecs ?? SCRIBE_VAD_SILENCE_THRESHOLD_SECS,
  );
  const onBeforeSessionCloseRef = useRef(options.onBeforeSessionClose);
  const hasStartedRef = useRef(false);
  const lastPartialAtRef = useRef<number | null>(null);
  const microphoneActive =
    session.status !== "idle" && session.status !== "error";

  useEffect(() => {
    setMicrophoneOwnerActive(
      mediaOwnerId,
      microphoneActive,
      options.activityKind ?? "dictation",
    );
  }, [mediaOwnerId, microphoneActive, options.activityKind]);

  useEffect(
    () => () => {
      setMicrophoneOwnerActive(mediaOwnerId, false);
    },
    [mediaOwnerId],
  );

  useEffect(() => {
    onCommitRef.current = options.onCommit;
  }, [options.onCommit]);

  useEffect(() => {
    stopAfterFirstCommitRef.current = options.stopAfterFirstCommit ?? false;
  }, [options.stopAfterFirstCommit]);

  useEffect(() => {
    flushOnStopRef.current = options.flushOnStop ?? true;
  }, [options.flushOnStop]);

  useEffect(() => {
    vadSilenceRef.current =
      options.vadSilenceThresholdSecs ?? SCRIBE_VAD_SILENCE_THRESHOLD_SECS;
  }, [options.vadSilenceThresholdSecs]);

  useEffect(() => {
    onBeforeSessionCloseRef.current = options.onBeforeSessionClose;
  }, [options.onBeforeSessionClose]);

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
    vadSilenceThresholdSecs:
      options.vadSilenceThresholdSecs ?? SCRIBE_VAD_SILENCE_THRESHOLD_SECS,
    microphone: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    onPartialTranscript: (data) => {
      if (data.text.trim() !== "") {
        lastPartialAtRef.current = Date.now();
      }
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

      if (sessionId === null) {
        return;
      }

      if (isConnectionLostError(sessionError)) {
        void controllerRef.current?.notifyDisconnected(sessionId);
        return;
      }

      void controllerRef.current?.notifyError(
        sessionId,
        toCzechSessionError(sessionError),
      );
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
        "ElevenLabs dočasně omezil požadavky. Zkuste to později.",
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

  const closeTranscriptSession = useCallback(() => {
    if (flushQuietTimerRef.current !== null) {
      clearTimeout(flushQuietTimerRef.current);
      flushQuietTimerRef.current = null;
    }

    finalCommitResolverRef.current?.();
    finalCommitResolverRef.current = null;
    transcriptSessionRef.current?.close();
    transcriptSessionRef.current = null;
    const committedListener = committedListenerRef.current;
    committedListenerRef.current = null;
    committedListener?.connection.off(
      RealtimeEvents.COMMITTED_TRANSCRIPT,
      committedListener.listener,
    );
    sessionIdRef.current = null;
  }, []);

  const stopSession = useCallback(() => {
    closeTranscriptSession();
    scribeRef.current?.disconnect();
  }, [closeTranscriptSession]);

  function scheduleFlushResolution() {
    if (finalCommitResolverRef.current === null) {
      return;
    }

    if (flushQuietTimerRef.current !== null) {
      clearTimeout(flushQuietTimerRef.current);
    }

    flushQuietTimerRef.current = setTimeout(() => {
      flushQuietTimerRef.current = null;
      finalCommitResolverRef.current?.();
      finalCommitResolverRef.current = null;
    }, FLUSH_SETTLE_MS);
  }

  const stopInternal = useCallback(
    async (
      stopOptions: {
        flush?: boolean;
        reason?: "user" | "unmount";
      } = {},
    ): Promise<void> => {
      const existing = stoppingPromiseRef.current;

      if (existing !== null) {
        return existing;
      }

      const reason = stopOptions.reason ?? "user";
      const flush = stopOptions.flush ?? flushOnStopRef.current;
      const stopping = (async () => {
        // Let the caller assign stoppingPromiseRef before a stop that can
        // finish synchronously; otherwise a completed stop leaves the ref
        // permanently non-null and blocks the next start (StrictMode cleanup).
        await Promise.resolve();
        setIsStopping(true);

        try {
          const connection = scribeRef.current?.getConnection() ?? null;
          const transcriptSession = transcriptSessionRef.current;

          if (
            flush &&
            connection !== null &&
            transcriptSession !== null &&
            !transcriptSession.isClosed
          ) {
            let commitSent = false;
            let finalResolved = false;
            let resolveFinal!: () => void;
            const finalCommit = new Promise<void>((resolve) => {
              resolveFinal = () => {
                finalResolved = true;
                resolve();
              };
            });
            finalCommitResolverRef.current = resolveFinal;

            try {
              connection.commit();
              commitSent = true;
            } catch {
              commitSent = false;
            }

            if (!commitSent) {
              resolveFinal();
            } else {
              let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
              const timeout = new Promise<void>((resolve) => {
                timeoutHandle = setTimeout(resolve, FINAL_COMMIT_TIMEOUT_MS);
              });

              await Promise.race([finalCommit, timeout]);

              if (timeoutHandle !== undefined) {
                clearTimeout(timeoutHandle);
              }
            }

            if (flushQuietTimerRef.current !== null) {
              clearTimeout(flushQuietTimerRef.current);
              flushQuietTimerRef.current = null;
            }

            finalCommitResolverRef.current = null;

            if (!commitSent || !finalResolved) {
              setIncompleteNotice(
                "Poslední promluva se nemusela dokončit. Zkontrolujte text před uložením.",
              );
            } else {
              setIncompleteNotice(null);
            }
          }

          if (controllerRef.current === null) {
            closeTranscriptSession();
          } else {
            if (reason === "user" && flush) {
              try {
                onBeforeSessionCloseRef.current?.();
              } catch {
                setIncompleteNotice(
                  "Poslední formátovací příkaz se nepodařilo dokončit. Zkontrolujte text před uložením.",
                );
              }
            }

            await controllerRef.current.stop(reason);
          }
        } finally {
          setIsStopping(false);
          stoppingPromiseRef.current = null;
        }
      })();

      stoppingPromiseRef.current = stopping;
      return stopping;
    },
    [closeTranscriptSession],
  );

  const startSession = useCallback(
    async (token: string, sessionId: number): Promise<void> => {
      const currentScribe = scribeRef.current;

      if (currentScribe === null) {
        throw new Error("Scribe není připravený.");
      }

      sessionIdRef.current = sessionId;
      const transcriptSession = new TranscriptSession();
      transcriptSessionRef.current = transcriptSession;
      setIncompleteNotice(null);

      if (flushQuietTimerRef.current !== null) {
        clearTimeout(flushQuietTimerRef.current);
        flushQuietTimerRef.current = null;
      }

      finalCommitResolverRef.current = null;
      currentScribe.clearTranscripts();
      await currentScribe.connect({
        token,
        vadSilenceThresholdSecs: vadSilenceRef.current,
      });

      const connection = currentScribe.getConnection();

      if (connection === null) {
        throw new Error("Scribe spojení není dostupné.");
      }

      const listener: CommittedListener = (data) => {
        if (sessionId !== sessionIdRef.current) {
          return;
        }

        const segment = transcriptSession.accept({
          text: data.text,
          providerId: readProviderId(data),
        });

        scheduleFlushResolution();

        if (segment === null) {
          return;
        }

        const utteranceEndedAt = lastPartialAtRef.current;
        const receivedAt = Date.now();
        lastPartialAtRef.current = null;
        const commandLatencyMs =
          utteranceEndedAt === null ? null : receivedAt - utteranceEndedAt;
        recordVoiceCommitLatency(commandLatencyMs);

        try {
          onCommitRef.current(segment, { commandLatencyMs });
        } finally {
          recordVoiceCommandLatency(
            utteranceEndedAt === null
              ? null
              : Date.now() - utteranceEndedAt,
          );
        }

        if (stopAfterFirstCommitRef.current) {
          void stopInternal({ flush: false });
        }
      };

      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, listener);
      committedListenerRef.current = { connection, listener };
    },
    [stopInternal],
  );

  const getOrCreateController = useCallback(() => {
    let controller = controllerRef.current;

    if (controller === null) {
      controller = new MicrophoneSessionController({
        requestToken: () => requestScribeToken(),
        startSession,
        stopSession,
        onStateChange: setSession,
        lockMode: options.lockMode ?? "exclusive",
      });
      controllerRef.current = controller;
    }

    return controller;
  }, [options.lockMode, startSession, stopSession]);

  const start = useCallback(() => {
    if (stoppingPromiseRef.current !== null) {
      return;
    }

    if (hasStartedRef.current) {
      recordVoiceManualReconnect();
    } else {
      hasStartedRef.current = true;
    }

    setIncompleteNotice(null);
    lastPartialAtRef.current = null;
    scribeRef.current?.clearTranscripts();
    void getOrCreateController().start();
  }, [getOrCreateController]);

  const stop = useCallback(
    (stopOptions?: { flush?: boolean }) =>
      stopInternal({ flush: stopOptions?.flush, reason: "user" }),
    [stopInternal],
  );

  const clearTranscripts = useCallback(() => {
    scribeRef.current?.clearTranscripts();
  }, []);

  useEffect(() => {
    return () => {
      if (stoppingPromiseRef.current !== null) {
        closeTranscriptSession();
        void controllerRef.current?.stop("unmount");
        return;
      }

      void stopInternal({ flush: false, reason: "unmount" });
    };
  }, [closeTranscriptSession, stopInternal]);

  const webLocksSupported = useSyncExternalStore(
    subscribeToWebLocks,
    getWebLocksSnapshot,
    getWebLocksServerSnapshot,
  );

  return {
    session,
    partialTranscript: scribe.partialTranscript,
    providerStatus: scribe.status,
    providerError: scribe.error,
    webLocksSupported,
    isStopping,
    incompleteNotice,
    start,
    stop,
    commit: () => {
      scribeRef.current?.commit();
    },
    clearTranscripts,
  };
}
