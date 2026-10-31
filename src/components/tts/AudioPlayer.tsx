"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type SyntheticEvent,
} from "react";

import type { SummaryArtifact } from "@/lib/ai/summary";
import type { ReadSelectionResult } from "@/lib/notes/read-selection";
import type { NoteDetail } from "@/lib/notes/client";
import {
  getMediaActivityServerSnapshot,
  getMediaActivitySnapshot,
  setPlaybackOwnerActive,
  subscribeMediaActivity,
} from "@/lib/media/activity";
import type { TtsProviderStatus } from "@/lib/tts/provider";
import {
  PlaybackLeaseError,
  tryAcquirePlaybackLease,
} from "@/lib/tts/playback-lease";
import {
  buildManifestBody,
  buildSectionBody,
  formatTtsEstimatedCost,
  formatTtsSectionText,
  isAbortError,
  purgeTtsVoiceCacheBestEffort,
  readTtsErrorMessage,
  ttsManifestSchema,
  type TtsManifest,
  type TtsSelectionPayload,
} from "@/lib/tts/player";
import { TTS_SCOPE_LABELS, type TtsScope } from "@/lib/tts/scopes";
import { getTtsSourceOptions } from "@/lib/tts/source-options";
import {
  getStopMonitorPreferenceServerSnapshot,
  getStopMonitorPreferenceSnapshot,
  subscribeStopMonitorPreference,
} from "@/lib/voice/stop-monitor";
import {
  getTtsVoicePreferenceServerSnapshot,
  getTtsVoicePreferenceSnapshot,
  subscribeTtsVoicePreference,
  writeTtsVoicePreference,
} from "@/lib/tts/voice-preference";
import {
  MICROPHONE_SESSION_MAX_MS,
  type MicrophoneLease,
  type MicrophoneLockManager,
} from "@/lib/voice/microphone";

import { SpokenStopMonitor } from "./SpokenStopMonitor";
import { SummaryPlayback } from "./SummaryPlayback";
import { VoiceSelector } from "./VoiceSelector";
import { useScribeDictation } from "../voice/useScribeDictation";

type PlaybackPhase = "idle" | "loading" | "playing" | "paused";

export interface PlaybackAudioHandle {
  play(): Promise<void> | void;
  pause(): void;
  dispose(): void;
  setOnEnded(handler: (() => void) | null): void;
  setOnError(handler: (() => void) | null): void;
}

export type PlaybackAudioFactory = (src: string) => PlaybackAudioHandle;

export interface AudioPlayerProps {
  readonly note: NoteDetail;
  readonly providerStatus: TtsProviderStatus | null;
  readonly providerError?: string | null;
  readonly disabled?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly audioFactory?: PlaybackAudioFactory;
  readonly playbackLocks?: MicrophoneLockManager | null;
  readonly summary?: SummaryArtifact | null;
  readonly summaryArtifact?: SummaryArtifact | null;
  readonly onVoiceSummary?: (artifact: SummaryArtifact) => void;
}

function createBrowserAudio(src: string): PlaybackAudioHandle {
  const element = new Audio(src);
  element.preload = "auto";

  return {
    play: () => element.play(),
    pause: () => {
      element.pause();
    },
    dispose: () => {
      element.onended = null;
      element.onerror = null;
      element.pause();

      try {
        element.removeAttribute("src");
        element.load();
      } catch {
        return;
      }
    },
    setOnEnded: (handler) => {
      element.onended = handler === null ? null : () => handler();
    },
    setOnError: (handler) => {
      element.onerror = handler === null ? null : () => handler();
    },
  };
}

function availableVoices(status: TtsProviderStatus | null): string[] {
  return (
    status?.voices
      .filter((voice) => voice.availability !== "unavailable")
      .map((voice) => voice.id) ?? []
  );
}

const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

export function AudioPlayer({
  note,
  providerStatus,
  providerError = null,
  disabled = false,
  fetchImpl = defaultFetch,
  audioFactory = createBrowserAudio,
  playbackLocks,
  summary = null,
  summaryArtifact = null,
  onVoiceSummary,
}: AudioPlayerProps) {
  const ownerId = useId();
  const media = useSyncExternalStore(
    subscribeMediaActivity,
    getMediaActivitySnapshot,
    getMediaActivityServerSnapshot,
  );
  const stopMonitorEnabled = useSyncExternalStore(
    subscribeStopMonitorPreference,
    getStopMonitorPreferenceSnapshot,
    getStopMonitorPreferenceServerSnapshot,
  );
  const storedVoice = useSyncExternalStore(
    subscribeTtsVoicePreference,
    getTtsVoicePreferenceSnapshot,
    getTtsVoicePreferenceServerSnapshot,
  );
  const [scope, setScope] = useState<TtsScope>("full");
  const sourceOptions = useMemo(
    () =>
      scope === "full" ? null : getTtsSourceOptions(note.contentMd),
    [note.contentMd, scope],
  );
  const plainText = sourceOptions?.plainText ?? note.contentPlain;
  const paragraphs = sourceOptions?.paragraphs ?? [];
  const taskLists = sourceOptions?.taskLists ?? [];
  const [paragraphIndex, setParagraphIndex] = useState(0);
  const [paragraphCount, setParagraphCount] = useState(2);
  const [taskListSelection, setTaskListSelection] = useState("all");
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(
    () => plainText.length,
  );
  const [rangeTouched, setRangeTouched] = useState(false);
  const [manifest, setManifest] = useState<TtsManifest | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<PlaybackPhase>("idle");
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [monitorActive, setMonitorActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [voiceCommandOpen, setVoiceCommandOpen] = useState(false);
  const [voiceCommandError, setVoiceCommandError] = useState<string | null>(
    null,
  );
  const [voiceCommandStatus, setVoiceCommandStatus] = useState<string | null>(
    null,
  );

  async function applyVoiceReadResult(result: ReadSelectionResult) {
    if (result.action === "summary") {
      if (summaryArtifact === null) {
        setVoiceCommandError(
          "Shrnutí není k dispozici. Nejprve ho vytvořte v části Shrnutí poznámky.",
        );
        return;
      }

      onVoiceSummary?.(summaryArtifact);
      setVoiceCommandStatus(
        "Shrnutí je připravené k přečtení v části Shrnutí k přečtení.",
      );
      return;
    }

    if (result.action !== "read") {
      setVoiceCommandError(result.message);
      return;
    }

    setVoiceCommandError(null);
    setScope(result.selection.scope);
    if (result.selection.scope === "range") {
      setRangeStart(result.selection.start ?? 0);
      setRangeEnd(result.selection.end ?? plainText.length);
    }
    if (result.selection.scope === "paragraph") {
      setParagraphIndex(result.selection.paragraphIndex ?? 0);
    }
    if (result.selection.scope === "tasks") {
      setTaskListSelection("all");
    }
    if (result.selection.scope === "last_paragraphs") {
      setParagraphCount(result.selection.count ?? 2);
    }
    clearManifest();
    setVoiceCommandStatus(
      `Připraveno: ${result.text.slice(0, 120)}${result.text.length > 120 ? "…" : ""}`,
    );
    await loadManifest({
      scope: result.selection.scope,
      ...(result.selection.start === undefined
        ? {}
        : { start: result.selection.start }),
      ...(result.selection.end === undefined
        ? {}
        : { end: result.selection.end }),
      ...(result.selection.paragraphIndex === undefined
        ? {}
        : { paragraphIndex: result.selection.paragraphIndex }),
      ...(result.selection.count === undefined
        ? {}
        : { paragraphCount: result.selection.count }),
    });
  }

  const voices = availableVoices(providerStatus);
  const effectiveVoice =
    storedVoice !== null && voices.includes(storedVoice)
      ? storedVoice
      : (voices[0] ?? "sarah");
  const rangeLength = plainText.length;
  const effectiveRangeStart = Math.min(rangeStart, rangeLength);
  const effectiveRangeEnd =
    rangeEnd === 0 ? rangeLength : Math.min(rangeEnd, rangeLength);

  const manifestRef = useRef<TtsManifest | null>(null);
  const audioRef = useRef<PlaybackAudioHandle | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const manifestAbortRef = useRef<AbortController | null>(null);
  const playbackLeaseRef = useRef<MicrophoneLease | null>(null);
  const playbackLeaseReleaseRef = useRef<Promise<void> | null>(null);
  const playFromRef = useRef<(index: number) => Promise<void>>(
    async () => undefined,
  );
  const mountedRef = useRef(true);
  const previousNoteVersionRef = useRef(note.version);
  const previousEffectiveVoiceRef = useRef(effectiveVoice);
  const previousStopMonitorEnabledRef = useRef(stopMonitorEnabled);
  const phaseRef = useRef(phase);

  const disposeAudio = useCallback(() => {
    const audio = audioRef.current;
    audioRef.current = null;

    if (audio !== null) {
      try {
        audio.dispose();
      } catch {
        // Disposing a failed audio element must not affect the note.
      }
    }

    if (objectUrlRef.current !== null) {
      try {
        URL.revokeObjectURL(objectUrlRef.current);
      } catch {
        // Ignore a browser that already released the blob URL.
      }

      objectUrlRef.current = null;
    }
  }, []);

  const releasePlaybackLease = useCallback(() => {
    const lease = playbackLeaseRef.current;
    playbackLeaseRef.current = null;

    if (lease !== null) {
      playbackLeaseReleaseRef.current = lease
        .release()
        .catch(() => undefined);
    }
  }, []);

  const stopPlayback = useCallback(() => {
    generationRef.current += 1;
    fetchAbortRef.current?.abort();
    fetchAbortRef.current = null;
    manifestAbortRef.current?.abort();
    manifestAbortRef.current = null;
    releasePlaybackLease();
    disposeAudio();

    if (mountedRef.current) {
      setCurrentIndex(null);
      setSelectedIndex(0);
      setMonitorActive(false);
      setPhase("idle");
      setManifestLoading(false);
    }
  }, [disposeAudio, releasePlaybackLease]);

  const stopPlaybackWithNotice = useCallback(
    (message: string) => {
      stopPlayback();
      setNotice(message);
    },
    [stopPlayback],
  );

  const clearManifest = useCallback(
    (message: string | null = null) => {
      stopPlayback();
      manifestRef.current = null;

      if (mountedRef.current) {
        setManifest(null);
        setSelectedIndex(0);
        setConsent(false);
        setNotice(null);
        setError(message);
      }
    },
    [setConsent, stopPlayback],
  );

  const failPlayback = useCallback(
    (message: string) => {
      stopPlayback();
      setError(message);
    },
    [stopPlayback],
  );

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      fetchAbortRef.current?.abort();
      fetchAbortRef.current = null;
      manifestAbortRef.current?.abort();
      manifestAbortRef.current = null;
      releasePlaybackLease();
      disposeAudio();
    };
  }, [disposeAudio, releasePlaybackLease]);

  useEffect(() => {
    const active = phase !== "idle";
    setPlaybackOwnerActive(ownerId, active);
  }, [ownerId, phase]);

  useEffect(
    () => () => {
      setPlaybackOwnerActive(ownerId, false);
    },
    [ownerId],
  );

  useEffect(() => {
    if (previousNoteVersionRef.current === note.version) {
      return;
    }

    previousNoteVersionRef.current = note.version;
    clearManifest(
      manifestRef.current === null
        ? null
        : "Poznámka byla uložena. Načtěte rozsah a cenu znovu.",
    );
  }, [clearManifest, note.version]);

  useEffect(() => {
    if (previousEffectiveVoiceRef.current === effectiveVoice) {
      return;
    }

    previousEffectiveVoiceRef.current = effectiveVoice;
    clearManifest(
      manifestRef.current === null
        ? null
        : "Hlas se změnil. Načtěte rozsah a cenu znovu.",
    );
  }, [clearManifest, effectiveVoice]);

  useEffect(() => {
    if (disabled) {
      stopPlayback();
    }
  }, [disabled, stopPlayback]);

  useEffect(() => {
    if (media.dictationActive) {
      stopPlayback();
    }
  }, [media.dictationActive, stopPlayback]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    previousStopMonitorEnabledRef.current = stopMonitorEnabled;
  }, [stopMonitorEnabled]);

  useEffect(
    () =>
      subscribeStopMonitorPreference(() => {
        const enabled = getStopMonitorPreferenceSnapshot();

        if (enabled === previousStopMonitorEnabledRef.current) {
          return;
        }

        previousStopMonitorEnabledRef.current = enabled;

        if (phaseRef.current !== "idle") {
          stopPlaybackWithNotice(
            "Změna experimentálního hlasového Stopu ukončila přehrávání. Spusťte ho znovu.",
          );
        }
      }),
    [stopPlaybackWithNotice],
  );

  function buildSelection(): TtsSelectionPayload | null {
    if (scope === "range") {
      if (
        !Number.isSafeInteger(effectiveRangeStart) ||
        !Number.isSafeInteger(effectiveRangeEnd) ||
        effectiveRangeStart < 0 ||
        effectiveRangeEnd > rangeLength ||
        effectiveRangeStart >= effectiveRangeEnd
      ) {
        setError(
          `Vybraný rozsah je neplatný. Zadejte začátek a konec v rozmezí 0 až ${rangeLength}.`,
        );
        return null;
      }

      return {
        scope,
        start: effectiveRangeStart,
        end: effectiveRangeEnd,
      };
    }

    if (scope === "paragraph") {
      if (!paragraphs[paragraphIndex]) {
        setError("V poznámce není žádný odstavec k přečtení.");
        return null;
      }

      return { scope, paragraphIndex };
    }

    if (scope === "last_paragraphs") {
      return { scope, paragraphCount };
    }

    if (scope === "tasks") {
      if (taskLists.length === 0) {
        setError("V poznámce není žádný úkol k přečtení.");
        return null;
      }

      if (taskListSelection === "all") {
        return { scope };
      }

      const listIndex = Number(taskListSelection);

      if (!taskLists[listIndex]) {
        setError("Vybraný seznam úkolů neexistuje.");
        return null;
      }

      return { scope, listIndex };
    }

    return { scope };
  }

  async function loadManifest(selectionOverride?: TtsSelectionPayload) {
    const selection = selectionOverride ?? buildSelection();

    if (selection === null) {
      return;
    }

    stopPlayback();
    const controller = new AbortController();
    manifestAbortRef.current = controller;
    manifestRef.current = null;
    setManifest(null);
    setConsent(false);
    setManifestLoading(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetchImpl("/api/tts", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(
          buildManifestBody(note.id, effectiveVoice, selection),
        ),
        signal: controller.signal,
      });

      if (controller.signal.aborted || !mountedRef.current) {
        return;
      }

      if (!response.ok) {
        const message = await readTtsErrorMessage(
          response,
          "Rozsah a cenu čtení nahlas se nepodařilo načíst.",
        );

        if (!controller.signal.aborted && mountedRef.current) {
          setError(message);
        }

        return;
      }

      const parsed = ttsManifestSchema.safeParse(await response.json());

      if (!parsed.success) {
        setError(
          "Server vrátil neplatný rozsah čtení nahlas. Zkuste to znovu.",
        );
        return;
      }

      if (controller.signal.aborted || !mountedRef.current) {
        return;
      }

      manifestRef.current = parsed.data;
      setManifest(parsed.data);
      setSelectedIndex(0);
      setNotice(
        parsed.data.cacheHit
          ? "Celý rozsah je v cache. Přehrání nevytvoří nový požadavek na poskytovatele."
          : `Rozsah je připravený v ${parsed.data.sections.length} ${parsed.data.sections.length === 1 ? "sekci" : "sekcích"}.`,
      );
    } catch (loadError) {
      if (
        controller.signal.aborted ||
        isAbortError(loadError) ||
        !mountedRef.current
      ) {
        return;
      }

      setError(
        "Rozsah a cenu čtení nahlas se nepodařilo načíst. Zkontrolujte připojení a zkuste to znovu.",
      );
    } finally {
      if (manifestAbortRef.current === controller) {
        manifestAbortRef.current = null;

        if (mountedRef.current) {
          setManifestLoading(false);
        }
      }
    }
  }

  const playFrom = useCallback(
    async (index: number) => {
      const currentManifest = manifestRef.current;

      if (currentManifest === null) {
        return;
      }

      const section = currentManifest.sections[index];

      if (!section) {
        return;
      }

      const generation = generationRef.current + 1;
      generationRef.current = generation;
      fetchAbortRef.current?.abort();
      const controller = new AbortController();
      fetchAbortRef.current = controller;
      disposeAudio();
      setCurrentIndex(index);
      setSelectedIndex(index);
      setPhase("loading");
      setError(null);
      setNotice(null);

      try {
        const pendingRelease = playbackLeaseReleaseRef.current;

        if (pendingRelease !== null) {
          await pendingRelease;

          if (generation !== generationRef.current || !mountedRef.current) {
            return;
          }

          playbackLeaseReleaseRef.current = null;
        }

        if (playbackLeaseRef.current === null) {
          const lease = await tryAcquirePlaybackLease(playbackLocks, {
            microphoneLockMode: stopMonitorEnabled
              ? "shared"
              : "exclusive",
          });

          if (generation !== generationRef.current || !mountedRef.current) {
            await lease?.release();
            return;
          }

          playbackLeaseRef.current = lease;
        }

        const response = await fetchImpl("/api/tts", {
          method: "POST",
          headers: {
            accept: "audio/mpeg",
            "content-type": "application/json",
          },
          body: JSON.stringify(buildSectionBody(currentManifest, index)),
          signal: controller.signal,
        });

        if (
          generation !== generationRef.current ||
          controller.signal.aborted ||
          !mountedRef.current
        ) {
          return;
        }

        if (!response.ok) {
          const cacheChanged = response.status === 409;
          const message = await readTtsErrorMessage(
            response,
            response.status === 429
              ? "Příliš mnoho požadavků na čtení nahlas. Zkuste to za chvíli znovu."
              : cacheChanged
                ? "Sekce už není v cache. Načtěte znovu rozsah a cenu a potvrďte novou cenu."
                : "Tuto sekci se nepodařilo přečíst nahlas.",
          );

          if (generation === generationRef.current && mountedRef.current) {
            if (cacheChanged) {
              manifestRef.current = null;
              setManifest(null);
              setConsent(false);
              setSelectedIndex(0);
            }

            failPlayback(message);
          }

          return;
        }

        const blob = await response.blob();

        if (
          generation !== generationRef.current ||
          controller.signal.aborted ||
          !mountedRef.current
        ) {
          return;
        }

        const objectUrl = URL.createObjectURL(blob);
        objectUrlRef.current = objectUrl;
        const audio = audioFactory(objectUrl);
        audioRef.current = audio;
        const disposeOwnAudio = () => {
          try {
            audio.dispose();
          } catch {
            // Ignore a failed audio element during a superseded request.
          }

          if (audioRef.current === audio) {
            audioRef.current = null;
          }

          if (objectUrlRef.current === objectUrl) {
            try {
              URL.revokeObjectURL(objectUrl);
            } catch {
              // Ignore a browser that already released the blob URL.
            }

            objectUrlRef.current = null;
          }
        };

        audio.setOnEnded(() => {
          if (generation !== generationRef.current) {
            return;
          }

          disposeAudio();
          const nextIndex = index + 1;

          if (nextIndex < currentManifest.sections.length) {
            void playFromRef.current(nextIndex);
            return;
          }

          releasePlaybackLease();
          setCurrentIndex(null);
          setSelectedIndex(0);
          setMonitorActive(false);
          setPhase("idle");
          setNotice("Přehrávání je dokončené.");
        });
        audio.setOnError(() => {
          if (generation === generationRef.current) {
            failPlayback(
              "Zvuk se nepodařilo přehrát. Zkuste to znovu; poznámka zůstala beze změny.",
            );
          }
        });

        if (
          generation !== generationRef.current ||
          controller.signal.aborted ||
          !mountedRef.current
        ) {
          disposeOwnAudio();
          return;
        }

        // Start command-only listening as soon as audible playback is
        // requested. Waiting for audio.play() to resolve made the monitor
        // dependent on browser-specific media-promise timing.
        setMonitorActive(true);
        await audio.play();

        if (
          generation !== generationRef.current ||
          controller.signal.aborted ||
          !mountedRef.current
        ) {
          disposeOwnAudio();
          return;
        }

        setPhase("playing");
      } catch (playbackError) {
        if (
          generation !== generationRef.current ||
          isAbortError(playbackError) ||
          !mountedRef.current
        ) {
          return;
        }

        failPlayback(
          playbackError instanceof PlaybackLeaseError
            ? playbackError.message
            : "Sekci se nepodařilo načíst nebo přehrát. Zkontrolujte připojení a zkuste to znovu; poznámka zůstala beze změny.",
        );
      } finally {
        if (fetchAbortRef.current === controller) {
          fetchAbortRef.current = null;
        }
      }
    },
    [
      audioFactory,
      disposeAudio,
      failPlayback,
      fetchImpl,
      playbackLocks,
      releasePlaybackLease,
      stopMonitorEnabled,
    ],
  );

  useEffect(() => {
    playFromRef.current = playFrom;
  }, [playFrom]);

  function handlePause() {
    const audio = audioRef.current;

    if (audio === null) {
      return;
    }

    audio.pause();
    setPhase("paused");
    setNotice("Přehrávání je pozastavené.");
  }

  async function handleResume() {
    const audio = audioRef.current;

    if (audio === null) {
      return;
    }

    try {
      await audio.play();
      setPhase("playing");
      setNotice(null);
    } catch {
      failPlayback(
        "Přehrávání se nepodařilo obnovit. Zkuste to znovu; poznámka zůstala beze změny.",
      );
    }
  }

  function handleStop() {
    stopPlayback();
    setNotice("Přehrávání bylo zastaveno.");
  }

  function handleSpokenStop() {
    stopPlayback();
    setNotice("Hlasový Stop zastavil přehrávání.");
  }

  function handlePrevious() {
    const currentManifest = manifestRef.current;
    const activeIndex = currentIndex ?? selectedIndex;

    if (currentManifest === null || activeIndex <= 0) {
      return;
    }

    const targetIndex = activeIndex - 1;
    setSelectedIndex(targetIndex);

    if (phase !== "idle") {
      void playFromRef.current(targetIndex);
    }
  }

  function handleNext() {
    const currentManifest = manifestRef.current;
    const activeIndex = currentIndex ?? selectedIndex;

    if (
      currentManifest === null ||
      activeIndex + 1 >= currentManifest.sections.length
    ) {
      return;
    }

    const targetIndex = activeIndex + 1;
    setSelectedIndex(targetIndex);

    if (phase !== "idle") {
      void playFromRef.current(targetIndex);
    }
  }

  function handleScopeChange(nextScope: TtsScope) {
    setScope(nextScope);
    clearManifest();
  }

  function handleVoiceChange(nextVoice: string) {
    if (nextVoice === effectiveVoice) {
      if (storedVoice !== nextVoice) {
        writeTtsVoicePreference(nextVoice);
      }

      return;
    }

    const previousVoice = effectiveVoice;
    writeTtsVoicePreference(nextVoice);
    clearManifest();
    void purgeTtsVoiceCacheBestEffort(fetchImpl, previousVoice);
  }

  function handleParagraphChange(value: string) {
    setParagraphIndex(Number(value));
    clearManifest();
  }

  function handleTaskListChange(value: string) {
    setTaskListSelection(value);
    clearManifest();
  }

  function handleRangeStartChange(value: string) {
    setRangeStart(Number(value));
    setRangeTouched(true);
    clearManifest();
  }

  function handleRangeEndChange(value: string) {
    setRangeEnd(Number(value));
    setRangeTouched(true);
    clearManifest();
  }

  function handleRangeFromSelection(
    event: SyntheticEvent<HTMLTextAreaElement>,
  ) {
    const target = event.currentTarget;
    const start = target.selectionStart;
    const end = target.selectionEnd;

    if (end > start) {
      setRangeStart(start);
      setRangeEnd(end);
      setRangeTouched(true);
      clearManifest();
    }
  }

  const providerUnavailable =
    providerStatus === null ||
    !providerStatus.configured ||
    availableVoices(providerStatus).length === 0;
  const microphoneBusy = media.dictationActive;
  const manifestDisabled =
    disabled || providerUnavailable || microphoneBusy || manifestLoading;
  const playDisabled =
    manifest === null || !consent || disabled || microphoneBusy;
  const voiceLabel =
    providerStatus?.voices.find((item) => item.id === effectiveVoice)?.label ??
    effectiveVoice;
  const activeIndex = currentIndex ?? selectedIndex;
  const highlightedIndex =
    manifest === null ? null : (currentIndex ?? selectedIndex);
  const canGoPrevious = manifest !== null && activeIndex > 0;
  const canGoNext =
    manifest !== null && activeIndex + 1 < manifest.sections.length;
  const multiSection = (manifest?.sections.length ?? 0) > 1;
  const voiceCommandDisabled =
    disabled ||
    providerUnavailable ||
    media.playbackActive ||
    media.microphoneActive;

  return (
    <section
      aria-labelledby="tts-player-heading"
      className="mt-6 rounded-2xl border border-stone-200 bg-stone-50 p-6"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2
            className="text-xl font-semibold text-stone-950"
            id="tts-player-heading"
          >
            Čtení nahlas
          </h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            Sekce se načítají a přehrávají postupně. Cena se odhaduje před
            odesláním textu a rezervuje ji server; nejde o limit poskytovatele.
            Při neuložených změnách v editoru je čtení vypnuté, aby odpovídalo
            uložené poznámce.
          </p>
        </div>
        {providerStatus ? (
          <p className="text-xs leading-5 text-stone-500 sm:max-w-xs sm:text-right">
            OpenRouter · {providerStatus.model} · hlas {voiceLabel} · max.{" "}
            {providerStatus.maxInputCodeUnits.toLocaleString("cs-CZ")} znaků
            na sekci
          </p>
        ) : null}
      </div>

      {microphoneBusy ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
          Mikrofon je právě aktivní. Čtení nahlas lze spustit až po ukončení
          diktování, aby se zvuk a mikrofon nepřekrývaly.
        </p>
      ) : null}

      {providerError ? (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-900">
          {providerError}
        </p>
      ) : null}

      {summary !== null && summary.noteVersion === note.version ? (
        <SummaryPlayback
          artifact={summary}
          audioFactory={audioFactory}
          disabled={disabled}
          fetchImpl={fetchImpl}
          key={`${summary.noteId}:${summary.noteVersion}:${summary.summaryText}`}
          playbackLocks={playbackLocks}
          providerStatus={providerStatus}
          voice={effectiveVoice}
        />
      ) : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <VoiceSelector
          disabled={disabled || manifestLoading || phase !== "idle"}
          error={providerError}
          onChange={handleVoiceChange}
          status={providerStatus}
          value={effectiveVoice}
        />

        <div className="rounded-xl border border-stone-200 bg-white p-4">
          <label
            className="text-sm font-medium text-stone-700"
            htmlFor="tts-scope"
          >
            Co číst
          </label>
          <select
            className="mt-2 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:bg-stone-100"
            data-testid="tts-scope"
            disabled={manifestLoading || phase !== "idle"}
            id="tts-scope"
            onChange={(event) =>
              handleScopeChange(event.target.value as TtsScope)
            }
            value={scope}
          >
            {(Object.keys(TTS_SCOPE_LABELS) as TtsScope[]).map((value) => (
              <option key={value} value={value}>
                {TTS_SCOPE_LABELS[value]}
              </option>
            ))}
          </select>

          <div className="mt-3 rounded-xl border border-stone-200 bg-white p-3">
            {voiceCommandOpen ? (
              <VoiceReadCommand
                disabled={voiceCommandDisabled}
                fetchImpl={fetchImpl}
                noteId={note.id}
                paragraphIndex={scope === "paragraph" ? paragraphIndex : undefined}
                selection={
                  rangeTouched
                    ? {
                        start: effectiveRangeStart,
                        end: effectiveRangeEnd,
                      }
                    : undefined
                }
                summaryArtifact={summaryArtifact}
                onClose={() => setVoiceCommandOpen(false)}
                onError={(message) => {
                  setVoiceCommandError(message);
                  setVoiceCommandOpen(false);
                }}
                onResult={(result) => {
                  setVoiceCommandOpen(false);
                  void applyVoiceReadResult(result);
                }}
              />
            ) : (
              <>
                <button
                  className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400"
                  data-testid="tts-voice-command"
                  disabled={voiceCommandDisabled}
                  onClick={() => {
                    setVoiceCommandError(null);
                    setVoiceCommandStatus(null);
                    setVoiceCommandOpen(true);
                  }}
                  type="button"
                >
                  Zadat hlasový příkaz
                </button>
                <span className="ml-2 text-xs leading-5 text-stone-500">
                  Jednorázový Scribe příkaz, max.{" "}
                  {MICROPHONE_SESSION_MAX_MS / 1000} s. Nic se nezapisuje do
                  poznámky.
                </span>
              </>
            )}
            {voiceCommandError ? (
              <p className="mt-2 text-sm text-red-900" role="alert">
                {voiceCommandError}
              </p>
            ) : null}
            {voiceCommandStatus ? (
              <p aria-live="polite" className="mt-2 text-sm text-stone-700">
                {voiceCommandStatus}
              </p>
            ) : null}
          </div>

          {scope === "paragraph" ? (
            <div className="mt-3">
              <label
                className="text-sm font-medium text-stone-700"
                htmlFor="tts-paragraph"
              >
                Odstavec
              </label>
              <select
                className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 disabled:cursor-not-allowed disabled:bg-stone-100"
                data-testid="tts-paragraph"
                disabled={
                  manifestLoading ||
                  phase !== "idle" ||
                  paragraphs.length === 0
                }
                id="tts-paragraph"
                onChange={(event) =>
                  handleParagraphChange(event.target.value)
                }
                value={paragraphIndex}
              >
                {paragraphs.map((paragraph) => (
                  <option key={paragraph.index} value={paragraph.index}>
                    {paragraph.index + 1}. {paragraph.text.slice(0, 60)}
                  </option>
                ))}
              </select>
              {paragraphs.length === 0 ? (
                <p className="mt-1 text-sm text-amber-900">
                  Poznámka neobsahuje žádný odstavec.
                </p>
              ) : null}
            </div>
          ) : null}

          {scope === "last_paragraphs" ? (
            <div className="mt-3">
              <label
                className="text-sm font-medium text-stone-700"
                htmlFor="tts-paragraph-count"
              >
                Počet posledních odstavců
              </label>
              <select
                className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 disabled:cursor-not-allowed disabled:bg-stone-100"
                data-testid="tts-paragraph-count"
                disabled={manifestLoading || phase !== "idle"}
                id="tts-paragraph-count"
                onChange={(event) => {
                  setParagraphCount(Number(event.target.value));
                  clearManifest();
                }}
                value={paragraphCount}
              >
                {[1, 2, 3, 4, 5].map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {scope === "tasks" ? (
            <div className="mt-3">
              <label
                className="text-sm font-medium text-stone-700"
                htmlFor="tts-task-list"
              >
                Seznam úkolů
              </label>
              <select
                className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 disabled:cursor-not-allowed disabled:bg-stone-100"
                data-testid="tts-task-list"
                disabled={
                  manifestLoading ||
                  phase !== "idle" ||
                  taskLists.length === 0
                }
                id="tts-task-list"
                onChange={(event) =>
                  handleTaskListChange(event.target.value)
                }
                value={taskListSelection}
              >
                <option value="all">Všechny seznamy úkolů</option>
                {taskLists.map((list) => (
                  <option key={list.index} value={list.index}>
                    {list.index + 1}. {list.itemCount} úkolů:{" "}
                    {list.text.slice(0, 40)}
                  </option>
                ))}
              </select>
              {taskLists.length === 0 ? (
                <p className="mt-1 text-sm text-amber-900">
                  Poznámka neobsahuje žádný seznam úkolů.
                </p>
              ) : null}
            </div>
          ) : null}

          {scope === "range" ? (
            <div className="mt-3 space-y-2">
              <label
                className="text-sm font-medium text-stone-700"
                htmlFor="tts-source-text"
              >
                Text poznámky pro výběr
              </label>
              <textarea
                className="h-28 w-full resize-y rounded-lg border border-stone-300 bg-white p-2 font-mono text-xs leading-5 text-stone-900 disabled:cursor-not-allowed disabled:bg-stone-100"
                data-testid="tts-source-text"
                disabled={manifestLoading || phase !== "idle"}
                id="tts-source-text"
                onSelect={handleRangeFromSelection}
                readOnly
                value={plainText}
              />
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-sm text-stone-700">
                  Začátek
                  <input
                    className="mt-1 block w-24 rounded-lg border border-stone-300 px-2 py-1 text-sm disabled:cursor-not-allowed disabled:bg-stone-100"
                    data-testid="tts-range-start"
                    disabled={manifestLoading || phase !== "idle"}
                    min={0}
                    onChange={(event) =>
                      handleRangeStartChange(event.target.value)
                    }
                    type="number"
                    value={effectiveRangeStart}
                  />
                </label>
                <label className="text-sm text-stone-700">
                  Konec
                  <input
                    className="mt-1 block w-24 rounded-lg border border-stone-300 px-2 py-1 text-sm disabled:cursor-not-allowed disabled:bg-stone-100"
                    data-testid="tts-range-end"
                    disabled={manifestLoading || phase !== "idle"}
                    min={0}
                    onChange={(event) =>
                      handleRangeEndChange(event.target.value)
                    }
                    type="number"
                    value={effectiveRangeEnd}
                  />
                </label>
              </div>
              <p className="text-xs leading-5 text-stone-500">
                Vyberte text v náhledu, nebo zadejte pozice ve viditelném textu.
                Rozsah se nesmí rozdělit znak.
              </p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          className="rounded-lg bg-stone-800 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          disabled={manifestDisabled}
          onClick={() => void loadManifest()}
          type="button"
        >
          {manifestLoading
            ? "Načítám rozsah…"
            : "Zjistit rozsah a cenu"}
        </button>
        <span className="text-xs leading-5 text-stone-500">
          Tento krok neodesílá text poskytovateli.
        </span>
      </div>

      {error ? (
        <p
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-900"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {notice ? (
        <p
          aria-live="polite"
          className="mt-3 text-sm leading-6 text-stone-700"
        >
          {notice}
        </p>
      ) : null}

      {manifest ? (
        <div className="mt-4 rounded-xl border border-stone-200 bg-white p-4">
          <p className="text-sm leading-6 text-stone-700">
            Sekcí:{" "}
            <strong>{manifest.sections.length.toLocaleString("cs-CZ")}</strong>{" "}
            · model{" "}
            <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">
              {manifest.model}
            </code>{" "}
            · hlas{" "}
            <strong>
              {providerStatus?.voices.find(
                (item) => item.id === manifest.voice,
              )?.label ?? manifest.voice}
            </strong>{" "}
            · odhad nákladů{" "}
            <strong>
              {manifest.cacheHit
                ? "0 USD (vše z cache)"
                : `až ${formatTtsEstimatedCost(manifest.estimatedMaxCostUsd)}`}
            </strong>
          </p>
          <p className="mt-1 text-xs leading-5 text-stone-500">
            Text se odesílá do OpenRouteru jen po potvrzení níže. Neúspěch
            přehrávání nemění obsah poznámky. Cena je odhad, ne limit
            poskytovatele.
          </p>

          <label className="mt-3 flex items-start gap-2 text-sm leading-6 text-stone-700">
            <input
              checked={consent}
              className="mt-1"
              data-testid="tts-consent"
              disabled={manifestDisabled || phase !== "idle"}
              onChange={(event) => setConsent(event.target.checked)}
              type="checkbox"
            />
            <span>
              Souhlasím s odesláním vybraného textu do OpenRouteru
              (model {manifest.model}, hlas{" "}
              {providerStatus?.voices.find(
                (item) => item.id === manifest.voice,
              )?.label ?? manifest.voice}
              ) a s přehráním. Server před požadavkem rezervuje odhad ceny.
            </span>
          </label>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            {phase === "idle" ? (
              <button
                className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
                disabled={playDisabled}
                onClick={() => void playFromRef.current(selectedIndex)}
                type="button"
              >
                Přehrát
              </button>
            ) : null}
            {phase === "loading" ? (
              <span className="text-sm font-medium text-stone-700">
                Načítám sekci…
              </span>
            ) : null}
            {phase === "playing" ? (
              <button
                className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
                onClick={handlePause}
                type="button"
              >
                Pozastavit
              </button>
            ) : null}
            {phase === "paused" ? (
              <button
                className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
                onClick={() => void handleResume()}
                type="button"
              >
                Pokračovat
              </button>
            ) : null}
            {multiSection ? (
              <>
                <button
                  className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
                  disabled={!canGoPrevious || phase === "loading"}
                  onClick={handlePrevious}
                  type="button"
                >
                  Předchozí
                </button>
                <button
                  className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
                  disabled={!canGoNext || phase === "loading"}
                  onClick={handleNext}
                  type="button"
                >
                  Další
                </button>
              </>
            ) : null}
            {phase !== "idle" ? (
              <button
                className="rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-800 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-stone-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
                onClick={handleStop}
                type="button"
              >
                Stop
              </button>
            ) : null}
          </div>

          <p className="mt-2 text-xs leading-5 text-stone-500">
            {manifest.sections.length === 1
              ? "Poznámka se vejde do jedné sekce, proto není co přeskakovat."
              : `Sekce ${(highlightedIndex ?? 0) + 1} z ${manifest.sections.length}. Předchozí a Další vybírají sekci i před spuštěním přehrávání.`}
            {!consent
              ? " Přehrát se aktivuje po zaškrtnutí souhlasu výše."
              : ""}
          </p>

          {stopMonitorEnabled ? (
            <SpokenStopMonitor
              active={monitorActive}
              onStop={handleSpokenStop}
            />
          ) : null}

          <ol
            className="mt-4 space-y-2"
            data-testid="tts-section-list"
          >
            {manifest.sections.map((section) => (
              <li
                aria-current={
                  highlightedIndex === section.index ? "true" : undefined
                }
                className={
                  highlightedIndex === section.index
                    ? "rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm leading-6 text-emerald-950"
                    : "rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm leading-6 text-stone-700"
                }
                data-section-index={section.index}
                key={section.index}
              >
                <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
                  Sekce {section.index + 1}
                  {section.cached ? " · cache" : ""}
                </span>
                <span className="whitespace-pre-line">
                  {formatTtsSectionText(section.text)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

interface VoiceReadCommandProps {
  readonly noteId: string;
  readonly disabled: boolean;
  readonly selection?: { readonly start: number; readonly end: number };
  readonly paragraphIndex?: number;
  readonly summaryArtifact: SummaryArtifact | null;
  readonly fetchImpl: typeof fetch;
  readonly onResult: (result: ReadSelectionResult) => void;
  readonly onError: (message: string) => void;
  readonly onClose: () => void;
}

function VoiceReadCommand({
  noteId,
  disabled,
  selection,
  paragraphIndex,
  summaryArtifact,
  fetchImpl,
  onResult,
  onError,
  onClose,
}: VoiceReadCommandProps) {
  const [submitting, setSubmitting] = useState(false);
  const dictation = useScribeDictation({
    stopAfterFirstCommit: true,
    flushOnStop: false,
    onCommit: (segment) => {
      void submit(segment.text);
    },
  });
  const busy =
    dictation.session.status !== "idle" &&
    dictation.session.status !== "error";

  async function submit(transcript: string) {
    setSubmitting(true);

    try {
      const response = await fetchImpl("/api/voice/read-selection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          noteId,
          transcript,
          ...(selection === undefined ? {} : { selection }),
          ...(paragraphIndex === undefined ? {} : { paragraphIndex }),
          summary:
            summaryArtifact === null
              ? null
              : {
                  noteVersion: summaryArtifact.noteVersion,
                  text: summaryArtifact.summaryText,
                },
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;

        throw new Error(
          body?.error?.message ??
            "Hlasový příkaz pro čtení se nepodařilo vyhodnotit.",
        );
      }

      onResult((await response.json()) as ReadSelectionResult);
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Hlasový příkaz pro čtení se nepodařilo vyhodnotit.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div data-testid="tts-voice-command-panel">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400"
          data-testid="tts-voice-start"
          disabled={
            (!busy && disabled) ||
            submitting ||
            dictation.isStopping ||
            dictation.webLocksSupported === false
          }
          onClick={() => {
            if (busy) {
              void dictation.stop({ flush: false });
              return;
            }

            dictation.clearTranscripts();
            dictation.start();
          }}
          type="button"
        >
          {busy ? "Ukončit příkaz" : "Spustit hlasový příkaz"}
        </button>
        <button
          className="rounded-lg border border-stone-300 px-2 py-2 text-xs font-semibold text-stone-600 hover:bg-stone-100"
          onClick={onClose}
          type="button"
        >
          Zavřít
        </button>
        <span className="text-xs leading-5 text-stone-500">
          Max. {MICROPHONE_SESSION_MAX_MS / 1000} s. Přepis se do poznámky
          nezapisuje.
        </span>
      </div>
      {busy ? (
        <p aria-live="polite" className="mt-2 text-sm text-stone-700">
          {dictation.partialTranscript || "Čekám na příkaz…"}
        </p>
      ) : null}
      {dictation.webLocksSupported === false ? (
        <p className="mt-2 text-sm text-red-900" role="alert">
          Tento prohlížeč nepodporuje Web Locks, proto nelze bezpečně zajistit
          výhradní přístup k mikrofonu. Otevřete aplikaci v Chromiu nebo Edge.
        </p>
      ) : null}
      {dictation.session.error ? (
        <p className="mt-2 text-sm text-red-900" role="alert">
          {dictation.session.error}
        </p>
      ) : null}
    </div>
  );
}
