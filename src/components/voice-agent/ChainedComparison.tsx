"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useScribeDictation } from "@/components/voice/useScribeDictation";
import {
  proposalOperationLabel,
  proposalTargetLabel,
} from "@/lib/notes/proposal-client";
import { fetchRevisions, restoreRevision } from "@/lib/notes/revision-client";
import { formatUsdAmount } from "@/lib/ai/usage-format";
import {
  tryAcquirePlaybackLease,
} from "@/lib/tts/playback-lease";
import {
  getTtsVoicePreferenceServerSnapshot,
  getTtsVoicePreferenceSnapshot,
  subscribeTtsVoicePreference,
} from "@/lib/tts/voice-preference";
import type { MicrophoneLease } from "@/lib/voice/microphone";
import { voiceMetrics } from "@/lib/voice-agent/metrics";
import {
  CHAINED_NOTE_PREVIEW_MAX_GRAPHEMES,
  CHAINED_SESSION_MAX_MS,
  appendTranscriptSegment,
} from "@/lib/voice/chained-intent";
import type {
  ChainedOutcome,
  ChainedSummaryResult,
} from "@/lib/voice/chained-controller";

interface ChainedVoiceOption {
  readonly id: string;
  readonly label: string;
  readonly availability: "available" | "live_unverified" | "unavailable";
}

export interface ChainedComparisonProps {
  readonly ttsConfigured: boolean;
  readonly ttsVoices: readonly ChainedVoiceOption[];
  readonly defaultTtsVoice: string;
}

interface SelectedNote {
  readonly noteId: string;
  readonly title: string;
  readonly version?: number;
  readonly preview?: string;
}

function readErrorMessage(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return "Požadavek se nepodařilo dokončit.";
  }

  const error = (value as { error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return "Požadavek se nepodařilo dokončit.";
  }

  const message = (error as { message?: unknown }).message;

  if (typeof message !== "string" || message.trim() === "") {
    return "Požadavek se nepodařilo dokončit.";
  }

  const provider = (error as { provider?: unknown }).provider;

  return typeof provider === "string" && provider !== ""
    ? `${provider}: ${message}`
    : message;
}

function isOutcome(value: unknown): value is ChainedOutcome {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

export function ChainedComparison({
  defaultTtsVoice,
  ttsConfigured,
  ttsVoices,
}: ChainedComparisonProps) {
  const [draft, setDraft] = useState("");
  const [outcome, setOutcome] = useState<ChainedOutcome | null>(null);
  const [selectedNote, setSelectedNote] = useState<SelectedNote | null>(null);
  const [selection, setSelection] = useState<{
    readonly start: number;
    readonly end: number;
  } | null>(null);
  const [summary, setSummary] = useState<ChainedSummaryResult | null>(null);
  const [lastApplied, setLastApplied] = useState<{
    readonly noteId: string;
    readonly version: number;
  } | null>(null);
  const storedTtsVoice = useSyncExternalStore(
    subscribeTtsVoicePreference,
    getTtsVoicePreferenceSnapshot,
    getTtsVoicePreferenceServerSnapshot,
  );
  const [selectedTtsVoice, setSelectedTtsVoice] = useState<string | null>(null);
  const ttsVoice =
    selectedTtsVoice !== null &&
    ttsVoices.some(
      (voice) =>
        voice.id === selectedTtsVoice && voice.availability !== "unavailable",
    )
      ? selectedTtsVoice
      : storedTtsVoice !== null &&
          ttsVoices.some(
            (voice) =>
              voice.id === storedTtsVoice &&
              voice.availability !== "unavailable",
          )
        ? storedTtsVoice
        : defaultTtsVoice;
  const [busy, setBusy] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [incompleteNotice, setIncompleteNotice] = useState<string | null>(
    null,
  );
  const [held, setHeld] = useState(false);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const committedRef = useRef("");
  const partialRef = useRef("");
  const incompleteRef = useRef<string | null>(null);
  const turnInFlightRef = useRef(false);
  const turnTokenRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const playbackLeaseRef = useRef<MicrophoneLease | null>(null);
  const sessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewRef = useRef<HTMLTextAreaElement | null>(null);
  const metricsSessionRef = useRef<number | null>(null);
  const metricsTurnRef = useRef<number | null>(null);
  const lastMetricsTurnRef = useRef<number | null>(null);
  const sessionGenerationRef = useRef(0);
  const outcomeRef = useRef<ChainedOutcome | null>(null);

  const dictation = useScribeDictation({
    activityKind: "dictation",
    flushOnStop: true,
    onIncompleteNotice: (notice) => {
      incompleteRef.current = notice;
    },
    onCommit: (segment) => {
      committedRef.current = appendTranscriptSegment(
        committedRef.current,
        segment.text,
      );
    },
    stopAfterFirstCommit: false,
  });

  useEffect(() => {
    partialRef.current = dictation.partialTranscript;
  }, [dictation.partialTranscript]);
  useEffect(() => {
    return voiceMetrics.onReset(() => {
      metricsSessionRef.current = null;
      metricsTurnRef.current = null;
      lastMetricsTurnRef.current = null;
    });
  }, []);


  useEffect(() => {
    incompleteRef.current = dictation.incompleteNotice;
  }, [dictation.incompleteNotice]);

  useEffect(() => {
    outcomeRef.current = outcome;
  }, [outcome]);

  useEffect(() => {
    return () => {
      sessionGenerationRef.current += 1;

      if (sessionTimerRef.current !== null) {
        clearTimeout(sessionTimerRef.current);
      }

      stopAudio();
      endMetricsSession("unmount");
    };
  }, []);

  function stopAudio(): void {
    const audio = audioRef.current;
    audioRef.current = null;

    if (audio !== null) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = "";
    }

    if (audioUrlRef.current !== null) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }

    const lease = playbackLeaseRef.current;
    playbackLeaseRef.current = null;
    void lease?.release().catch(() => undefined);
  }

  function endMetricsSession(reason: string): void {
    if (metricsTurnRef.current !== null) {
      voiceMetrics.finishTurn(metricsTurnRef.current);
      metricsTurnRef.current = null;
    }

    if (metricsSessionRef.current !== null) {
      voiceMetrics.endSession(metricsSessionRef.current, reason);
      metricsSessionRef.current = null;
    }

    lastMetricsTurnRef.current = null;
  }

  async function speak(text: string, turnId: number | null): Promise<void> {
    const trimmed = text.trim();

    if (trimmed === "") {
      return;
    }

    const generation = sessionGenerationRef.current;
    const isStale = () => generation !== sessionGenerationRef.current;
    stopAudio();

    let lease: MicrophoneLease | null = null;
    let audio: HTMLAudioElement | null = null;
    let url: string | null = null;

    const cleanupStale = () => {
      if (audio !== null) {
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.src = "";

        if (audioRef.current === audio) {
          audioRef.current = null;
        }
      }

      if (url !== null) {
        URL.revokeObjectURL(url);

        if (audioUrlRef.current === url) {
          audioUrlRef.current = null;
        }
      }

      if (playbackLeaseRef.current === lease) {
        playbackLeaseRef.current = null;
      }

      void lease?.release().catch(() => undefined);
    };

    try {
      lease = await tryAcquirePlaybackLease();

      if (isStale()) {
        cleanupStale();
        return;
      }

      playbackLeaseRef.current = lease;
      const response = await fetch("/api/tts", {
        body: JSON.stringify({ text: trimmed, voice: ttsVoice }),
        headers: {
          accept: "audio/mpeg",
          "content-type": "application/json",
        },
        method: "POST",
      });

      if (isStale()) {
        cleanupStale();
        return;
      }

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        throw new Error(
          readErrorMessage(payload) || "Čtení nahlas se nepodařilo.",
        );
      }

      const blob = await response.blob();

      if (isStale()) {
        cleanupStale();
        return;
      }

      url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        stopAudio();
      };
      audio.onerror = () => {
        stopAudio();
        setError("Zvuk z ElevenLabs se nepodařilo přehrát.");
      };
      if (turnId !== null) {
        voiceMetrics.recordUsage(turnId, {
          kind: "unknown",
          provider: "elevenlabs_tts",
        });
      }

      if (isStale()) {
        cleanupStale();
        return;
      }

      await audio.play();

      if (isStale()) {
        cleanupStale();
        return;
      }

      if (turnId !== null) {
        voiceMetrics.markFirstAudio(turnId);
      }
    } catch (caught) {
      if (isStale()) {
        cleanupStale();
        return;
      }

      stopAudio();
      setError(
        caught instanceof Error
          ? `Čtení nahlas selhalo: ${caught.message}`
          : "Čtení nahlas se nepodařilo.",
      );
    }
  }

  function markSessionStart(): void {
    if (sessionStartedAt !== null) {
      return;
    }

    const startedAt = Date.now();
    setSessionStartedAt(startedAt);
    sessionTimerRef.current = setTimeout(() => {
      sessionGenerationRef.current += 1;
      turnTokenRef.current += 1;
      setSummaryBusy(false);
      turnInFlightRef.current = false;
      setBusy(false);
      void dictation.stop({ flush: false });
      stopAudio();
      setSessionStartedAt(null);
      setHeld(false);
      endMetricsSession("timeout");
      setError(
        `Řetězená relace vypršela po ${CHAINED_SESSION_MAX_MS / 60_000} minutách. Spusťte novou relaci.`,
      );
    }, CHAINED_SESSION_MAX_MS);
  }

  function resetSession(): void {
    sessionGenerationRef.current += 1;

    if (sessionTimerRef.current !== null) {
      clearTimeout(sessionTimerRef.current);
      sessionTimerRef.current = null;
    }

    void dictation.stop({ flush: false });
    stopAudio();
    endMetricsSession("reset");
    committedRef.current = "";
    partialRef.current = "";
    setSessionStartedAt(null);
    setHeld(false);
    setDraft("");
    setOutcome(null);
    setSelectedNote(null);
    setSelection(null);
    setSummary(null);
    setIncompleteNotice(null);
    setLastApplied(null);
    setSummaryBusy(false);
    turnTokenRef.current += 1;
    turnInFlightRef.current = false;
    setBusy(false);
    setError(null);
    setNotice("Relace byla ukončena. Můžete začít novou.");
  }

  async function runTurn(text: string): Promise<void> {
    const trimmed = text.trim();

    if (trimmed === "" || turnInFlightRef.current) {
      return;
    }

    if (
      sessionStartedAt !== null &&
      Date.now() - sessionStartedAt > CHAINED_SESSION_MAX_MS
    ) {
      setError("Řetězená relace vypršela. Spusťte novou relaci.");
      return;
    }

    sessionGenerationRef.current += 1;
    const generation = sessionGenerationRef.current;
    const turnToken = ++turnTokenRef.current;
    stopAudio();

    turnInFlightRef.current = true;
    setSummaryBusy(false);
    setBusy(true);
    setError(null);
    setNotice(null);
    setSummary(null);
    setDraft(trimmed);
    markSessionStart();

    if (metricsSessionRef.current === null) {
      metricsSessionRef.current = voiceMetrics.startSession("chained");
    }

    metricsTurnRef.current = voiceMetrics.startTurn("chained");
    lastMetricsTurnRef.current = metricsTurnRef.current;
    voiceMetrics.markTurnEnd(metricsTurnRef.current);
    voiceMetrics.recordUsage(metricsTurnRef.current, {
      kind: "unknown",
      provider: "openrouter",
    });
    voiceMetrics.recordUsage(metricsTurnRef.current, {
      kind: "unknown",
      provider: "elevenlabs_scribe",
    });

    const metricsTurn = metricsTurnRef.current;
    const requestStartedAt = Date.now();
    let recordedError = false;

    try {
      const response = await fetch("/api/voice-agent/chained", {
        body: JSON.stringify({
          kind: "turn",
          selectedNoteId: selectedNote?.noteId,
          selectedNoteVersion: selectedNote?.version,
          selection,
          transcript: trimmed,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload: unknown = await response.json().catch(() => null);

      if (generation !== sessionGenerationRef.current) {
        return;
      }

      voiceMetrics.recordToolRoundTrip(
        metricsTurn,
        Date.now() - requestStartedAt,
      );

      if (!response.ok) {
        voiceMetrics.recordError(
          metricsTurn,
          typeof payload === "object" && payload !== null
            ? ((payload as { error?: { code?: unknown } }).error?.code as
                | string
                | undefined) ?? null
            : null,
        );
        recordedError = true;
        throw new Error(readErrorMessage(payload));
      }

      const candidate =
        typeof payload === "object" && payload !== null
          ? (payload as { outcome?: unknown }).outcome
          : null;

      if (!isOutcome(candidate)) {
        throw new Error("Server vrátil neplatný výsledek řetězeného režimu.");
      }

      if (candidate.kind === "search") {
        setSelectedNote(null);
        setSelection(null);
        setLastApplied(null);
        setOutcome(candidate);
        setNotice(
          candidate.empty
            ? "Hledání nenašlo žádnou poznámku."
            : "Vyberte jednu poznámku z výsledků.",
        );
        return;
      }

      if (candidate.kind === "note") {
        setSelectedNote({
          noteId: candidate.note.noteId,
          preview: candidate.note.text,
          title: candidate.note.title,
          version: candidate.note.version,
        });
        setSelection(null);
      }

      if (candidate.kind === "section") {
        setSelectedNote((current) =>
          current !== null && current.noteId === candidate.section.noteId
            ? {
                ...current,
                title: candidate.section.title,
                version: candidate.section.version,
              }
            : current,
        );
      }

      if (candidate.kind === "summary_offer") {
        setSelectedNote((current) =>
          current !== null && current.noteId === candidate.noteId
            ? { ...current, version: candidate.noteVersion }
            : current,
        );
      }

      if (candidate.kind === "proposal") {
        setSelectedNote((current) =>
          current !== null && current.noteId === candidate.proposal.noteId
            ? { ...current, version: candidate.proposal.expectedVersion }
            : current,
        );
      }

      if (candidate.kind === "proposal" && lastMetricsTurnRef.current !== null) {
        voiceMetrics.recordProposal(lastMetricsTurnRef.current, "pending");
      }

      setOutcome(candidate);

      if (candidate.speechText !== null) {
        void speak(candidate.speechText, metricsTurn);
      }
    } catch (caught) {
      if (generation !== sessionGenerationRef.current) {
        return;
      }

      if (!recordedError) {
        voiceMetrics.recordError(metricsTurn, "chained_request_failed");
      }

      setError(
        caught instanceof Error
          ? caught.message
          : "Řetězený příkaz se nepodařilo provést.",
      );
    } finally {
      voiceMetrics.finishTurn(metricsTurn);

      if (turnToken === turnTokenRef.current) {
        metricsTurnRef.current = null;
        turnInFlightRef.current = false;
        setBusy(false);
      }
    }
  }

  async function startListening(): Promise<void> {
    if (held || busy || dictation.isStopping) {
      return;
    }

    const interrupting = audioRef.current !== null;
    const bargeTurn = metricsTurnRef.current ?? lastMetricsTurnRef.current;

    if (interrupting && bargeTurn !== null) {
      voiceMetrics.markBargeIn(bargeTurn);
    }

    sessionGenerationRef.current += 1;
    setSummaryBusy(false);
    stopAudio();

    if (interrupting && bargeTurn !== null) {
      voiceMetrics.markOutputSilenced(bargeTurn);
    }

    committedRef.current = "";
    setDraft("");
    setError(null);
    setNotice(null);
    setIncompleteNotice(null);
    setHeld(true);

    try {
      dictation.start();
    } catch {
      setHeld(false);
      setError("Mikrofon se nepodařilo spustit. Zkuste to znovu.");
    }
  }

  async function stopListening(): Promise<void> {
    setHeld(false);
    const text = committedRef.current || partialRef.current;

    try {
      await dictation.stop();
    } catch {
      setError("Přepis se nepodařilo dokončit. Zkuste to znovu.");
      return;
    }

    const incomplete = incompleteRef.current;
    const finalText = incomplete
      ? appendTranscriptSegment(committedRef.current, partialRef.current)
      : committedRef.current || text;

    if (incomplete !== null) {
      setIncompleteNotice(incomplete);
    }

    if (finalText.trim() !== "") {
      setDraft(finalText);

      if (!turnInFlightRef.current) {
        await runTurn(finalText);
      }
    }
  }

  function markSelection(): void {
    const area = previewRef.current;

    if (!area) {
      return;
    }

    const start = area.selectionStart;
    const end = area.selectionEnd;

    if (end <= start) {
      setNotice("Nejdřív označte pasáž v náhledu poznámky.");
      return;
    }

    sessionGenerationRef.current += 1;
    setSummaryBusy(false);
    stopAudio();
    setSelection({ end, start });
    setNotice(`Označená pasáž: ${end - start} znaků.`);
  }

  function selectResult(noteId: string, title: string, version?: number): void {
    voiceMetrics.recordSelection("chained", null);
    sessionGenerationRef.current += 1;
    setSummaryBusy(false);
    stopAudio();
    setSelectedNote({ noteId, title, version });
    setSelection(null);
    setLastApplied(null);
    setNotice(`Vybraná poznámka: ${title}.`);
  }

  async function approveSummary(): Promise<void> {
    if (outcome?.kind !== "summary_offer" || summaryBusy) {
      return;
    }

    const offer = outcome;
    const generation = sessionGenerationRef.current;
    setSummaryBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/voice-agent/chained", {
        body: JSON.stringify({
          kind: "summary",
          noteId: offer.noteId,
          expectedVersion: offer.noteVersion,
          selection,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(readErrorMessage(payload));
      }

      const result =
        typeof payload === "object" && payload !== null
          ? (payload as { summary?: unknown }).summary
          : null;

      if (
        typeof result !== "object" ||
        result === null ||
        typeof (result as { summaryText?: unknown }).summaryText !== "string"
      ) {
        throw new Error("Server nevrátil platné shrnutí.");
      }

      const next = result as ChainedSummaryResult;

      if (
        generation !== sessionGenerationRef.current ||
        outcomeRef.current?.kind !== "summary_offer" ||
        outcomeRef.current.noteId !== offer.noteId ||
        outcomeRef.current.noteVersion !== offer.noteVersion ||
        next.noteId !== offer.noteId ||
        next.noteVersion !== offer.noteVersion
      ) {
        return;
      }

      setSummary(next);

      if (metricsSessionRef.current === null) {
        metricsSessionRef.current = voiceMetrics.startSession("chained");
      }

      const summaryUsageTurn =
        lastMetricsTurnRef.current ?? metricsTurnRef.current;

      if (summaryUsageTurn !== null) {
        voiceMetrics.recordUsage(summaryUsageTurn, {
          kind: "unknown",
          provider: "openrouter",
        });
        voiceMetrics.recordUsage(summaryUsageTurn, {
          kind: "unknown",
          provider: "elevenlabs_tts",
        });
      }

      void speak(next.summaryText, null);
    } catch (caught) {
      if (generation === sessionGenerationRef.current) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Shrnutí se nepodařilo vytvořit.",
        );
      }
    } finally {
      if (generation === sessionGenerationRef.current) {
        setSummaryBusy(false);
      }
    }
  }

  async function confirmProposal(): Promise<void> {
    if (outcome?.kind !== "proposal" || proposalBusy) {
      return;
    }

    const proposal = outcome.proposal;
    setProposalBusy(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/notes/${encodeURIComponent(proposal.noteId)}/proposals/${encodeURIComponent(proposal.id)}/confirm`,
        {
          body: JSON.stringify({
            confirmationNonce: proposal.confirmationNonce,
            expectedVersion: proposal.expectedVersion,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(readErrorMessage(payload));
      }

      const note =
        typeof payload === "object" && payload !== null
          ? (payload as { note?: { version?: unknown } }).note
          : null;

      const appliedVersion = note?.version;

      if (typeof appliedVersion !== "number") {
        throw new Error("Server nevrátil verzi aplikované poznámky.");
      }

      setSelectedNote((current) =>
        current === null ? current : { ...current, version: appliedVersion },
      );
      setLastApplied({ noteId: proposal.noteId, version: appliedVersion });

      if (lastMetricsTurnRef.current !== null) {
        voiceMetrics.recordProposal(lastMetricsTurnRef.current, "applied");
      }

      setOutcome(null);
      setNotice(
        `Návrh byl aplikován. Poznámka má nyní verzi ${appliedVersion}. Změnu lze vrátit v historii.`,
      );
      void speak(`Změna byla aplikována. Poznámka má verzi ${appliedVersion}.`, lastMetricsTurnRef.current);
    } catch (caught) {
      if (lastMetricsTurnRef.current !== null) {
        voiceMetrics.recordProposal(lastMetricsTurnRef.current, "failed");
        voiceMetrics.recordError(lastMetricsTurnRef.current, "proposal_failed");
      }

      setError(
        caught instanceof Error
          ? caught.message
          : "Návrh se nepodařilo potvrdit.",
      );
    } finally {
      setProposalBusy(false);
    }
  }

  async function rejectProposal(): Promise<void> {
    if (outcome?.kind !== "proposal" || proposalBusy) {
      return;
    }

    const proposal = outcome.proposal;
    setProposalBusy(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/notes/${encodeURIComponent(proposal.noteId)}/proposals/${encodeURIComponent(proposal.id)}/reject`,
        {
          body: "{}",
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(readErrorMessage(payload));
      }

      if (lastMetricsTurnRef.current !== null) {
        voiceMetrics.recordProposal(lastMetricsTurnRef.current, "rejected");
      }

      setOutcome(null);
      setNotice("Návrh byl zamítnut. Poznámka zůstala beze změny.");
    } catch (caught) {
      if (lastMetricsTurnRef.current !== null) {
        voiceMetrics.recordProposal(lastMetricsTurnRef.current, "failed");
        voiceMetrics.recordError(lastMetricsTurnRef.current, "proposal_failed");
      }

      setError(
        caught instanceof Error
          ? caught.message
          : "Návrh se nepodařilo zamítnout.",
      );
    } finally {
      setProposalBusy(false);
    }
  }

  async function undoLastChange(): Promise<void> {
    const applied = lastApplied;

    if (applied === null) {
      return;
    }

    setProposalBusy(true);
    setError(null);

    try {
      const history = await fetchRevisions(applied.noteId);

      if (history.currentVersion !== applied.version) {
        throw new Error(
          "Poznámka se mezitím změnila. Vrácení by mohlo zrušit cizí novější změnu; načtěte historii znovu.",
        );
      }

      if (!history.canUndo || history.undoRevisionId === null) {
        throw new Error("Poslední změna už není k dispozici pro vrácení.");
      }

      const updated = await restoreRevision(
        applied.noteId,
        history.undoRevisionId,
        { expectedVersion: history.currentVersion, mode: "undo" },
      );
      setSelectedNote((current) =>
        current !== null && current.noteId === applied.noteId
          ? { ...current, version: updated.version }
          : current,
      );
      setLastApplied(null);

      if (lastMetricsTurnRef.current !== null) {
        voiceMetrics.recordProposal(lastMetricsTurnRef.current, "undo");
      }

      setNotice(`Změna byla vrácena. Poznámka má verzi ${updated.version}.`);
      void speak(`Změna byla vrácena. Poznámka má verzi ${updated.version}.`, lastMetricsTurnRef.current);
    } catch (caught) {
      if (lastMetricsTurnRef.current !== null) {
        voiceMetrics.recordProposal(lastMetricsTurnRef.current, "failed");
        voiceMetrics.recordError(lastMetricsTurnRef.current, "undo_failed");
      }

      setError(
        caught instanceof Error
          ? caught.message
          : "Změnu se nepodařilo vrátit.",
      );
    } finally {
      setProposalBusy(false);
    }
  }

  const isHolding = held && dictation.session.status !== "error";

  const unavailable = ttsVoices.filter(
    (voice) => voice.availability === "unavailable",
  );
  const availableVoices = ttsVoices.filter(
    (voice) => voice.availability !== "unavailable",
  );

  return (
    <section
      aria-labelledby="chained-mode-title"
      className="mt-8 rounded-2xl border border-stone-300 bg-white p-6"
      data-testid="chained-mode"
    >
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-sky-800">
        Porovnání
      </p>
      <h2
        className="mt-2 text-xl font-semibold text-stone-950"
        id="chained-mode-title"
      >
        Řetězený režim
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">
        Jeden stisk a mluvení: přepis dělá ElevenLabs Scribe, záměr a shrnutí
        OpenRouter a čtení odpovědi ElevenLabs TTS. Jde o samostatnou placenou
        cestu bez Gemini relace. Mikrofon je výhradní a nesmí běžet
        současně s Gemini relací ani jiným čtením nahlas. Edity se nikdy
        neaplikují z přepisu; čekají na kliknutí u návrhu.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="block text-sm font-medium text-stone-800">
          Hlas čtení
          <select
            className="mt-1 block rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm"
            disabled={availableVoices.length === 0}
            onChange={(event) => {
              setSelectedTtsVoice(event.target.value);
            }}
            value={ttsVoice}
          >
            {availableVoices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="rounded-lg bg-sky-800 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600"
          disabled={
            isHolding ||
            busy ||
            dictation.isStopping ||
            dictation.webLocksSupported === false
          }
          data-testid="chained-push-to-talk"
          onBlur={() => {
            if (held) {
              void stopListening();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === " " || event.key === "Enter") {
              event.preventDefault();
              void startListening();
            }
          }}
          onKeyUp={(event) => {
            if (event.key === " " || event.key === "Enter") {
              event.preventDefault();
              void stopListening();
            }
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            void startListening();
          }}
          onPointerUp={() => {
            if (held) {
              void stopListening();
            }
          }}
          type="button"
        >
          {isHolding ? "Mluvte… pusťte pro odeslání" : "Držet a mluvit"}
        </button>
        <button
          className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-700 disabled:cursor-not-allowed disabled:text-stone-400"
          disabled={
            busy ||
            dictation.isStopping ||
            draft.trim() === "" ||
            isHolding
          }
          onClick={() => {
            void runTurn(draft);
          }}
          type="button"
        >
          Odeslat příkaz
        </button>
        <button
          className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-700"
          onClick={resetSession}
          type="button"
        >
          Nová relace
        </button>
      </div>

      <p className="mt-2 text-xs leading-5 text-stone-500">
        {dictation.webLocksSupported === false
          ? "Prohlížeč nepodporuje Web Locks; řetězený režim nelze bezpečně spustit."
          : dictation.session.status === "error"
            ? dictation.session.error
            : dictation.session.status === "active"
              ? `Mikrofon je aktivní${dictation.partialTranscript ? `: ${dictation.partialTranscript}` : "…"}`
              : "Mikrofon je vypnutý. Podržte tlačítko a mluvte jeden příkaz."}
      </p>
      {(incompleteNotice ?? dictation.incompleteNotice) !== null ? (
        <p className="mt-1 text-xs leading-5 text-amber-800">
          {incompleteNotice ?? dictation.incompleteNotice}
        </p>
      ) : null}
      <p className="mt-1 text-xs leading-5 text-stone-500">
        Relace je omezená na {CHAINED_SESSION_MAX_MS / 60_000} minut. Cena
        ElevenLabs Scribe, OpenRouter a ElevenLabs TTS je neznámá a aplikace ji
        v tomto režimu neměří; pevný dolarový strop není. TTS{" "}
        {ttsConfigured ? "je nakonfigurované" : "není nakonfigurované"}.
      </p>
      {unavailable.length > 0 ? (
        <p className="mt-1 text-xs leading-5 text-amber-800">
          Nedostupné TTS hlasy: {unavailable.map((voice) => voice.label).join(", ")}.
        </p>
      ) : null}

      <label className="mt-4 block text-sm font-medium text-stone-800">
        Přepis příkazu
        <textarea
          className="mt-1 h-20 w-full resize-y rounded-lg border border-stone-300 p-2 text-sm"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          value={draft}
        />
      </label>

      {selectedNote !== null ? (
        <p className="mt-2 text-sm text-stone-700">
          Vybraná poznámka: <strong>{selectedNote.title}</strong>
          {selectedNote.version === undefined
            ? ""
            : ` · verze ${selectedNote.version}`}
        </p>
      ) : null}

      {error !== null ? (
        <p
          className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-950"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {notice !== null ? (
        <p className="mt-3 text-sm leading-6 text-stone-700">{notice}</p>
      ) : null}

      {outcome?.kind === "search" ? (
        <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-4">
          <p className="text-sm font-semibold text-stone-800">
            {outcome.empty ? "Nic nenalezeno." : "Výsledky hledání"}
          </p>
          <ul className="mt-2 space-y-2">
            {outcome.results.map((result) => (
              <li
                className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-white p-3"
                key={result.noteId}
              >
                <div>
                  <p className="text-sm font-semibold text-stone-900">
                    {result.title}
                  </p>
                  <p className="text-xs leading-5 text-stone-600">
                    {result.preview}
                  </p>
                </div>
                <button
                  className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-semibold text-stone-800 hover:bg-stone-100"
                  onClick={() => {
                    selectResult(result.noteId, result.title, result.version);
                  }}
                  type="button"
                >
                  Vybrat
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {outcome?.kind === "note" ? (
        <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-4">
          <p className="text-sm font-semibold text-stone-800">
            {outcome.note.title} · verze {outcome.note.version}
          </p>
          <textarea
            className="mt-2 h-40 w-full resize-y rounded-lg border border-stone-300 bg-white p-2 font-mono text-xs"
            data-testid="chained-note-preview"
            readOnly
            ref={previewRef}
            value={outcome.note.text}
          />
          {outcome.note.truncated ? (
            <p className="mt-2 text-xs leading-5 text-amber-800">
              Poznámka je delší; zobrazeno a přečteno je jen prvních
              {CHAINED_NOTE_PREVIEW_MAX_GRAPHEMES.toLocaleString("cs-CZ")} znaků.
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-semibold text-stone-800 hover:bg-stone-100"
              onClick={markSelection}
              type="button"
            >
              Označit pasáž
            </button>
            {selection !== null ? (
              <span className="self-center text-xs text-stone-600">
                Označeno {selection.end - selection.start} znaků
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {outcome?.kind === "section" ? (
        <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-4">
          <p className="text-sm font-semibold text-stone-800">
            {outcome.section.title} · {outcome.section.section}
          </p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-stone-800">
            {outcome.section.status === "ok"
              ? outcome.section.text
              : (outcome.section.message ?? "Část je prázdná nebo nejednoznačná.")}
          </p>
        </div>
      ) : null}

      {outcome?.kind === "unclear" ? (
        <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
          {outcome.clarification}
        </p>
      ) : null}
      {outcome?.kind === "needs_selection" ? (
        <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
          {outcome.message}
        </p>
      ) : null}

      {outcome?.kind === "summary_offer" ? (
        <section className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
          <h3 className="font-semibold">Povolit placené shrnutí?</h3>
          <p className="mt-1">
            Poznámka „{outcome.noteTitle}“ ({outcome.sourceGraphemes} znaků
            zdroje) se odešle do OpenRouteru (model {outcome.model}); odhad ceny
            nejvýše {formatUsdAmount(String(outcome.estimatedMaxCostUsd))}. Jde
            o samostatný placený požadavek; do poznámky se nic neukládá.
          </p>
          {!outcome.configured && outcome.blockedReason !== null ? (
            <p className="mt-2 font-semibold">{outcome.blockedReason}</p>
          ) : null}
          <button
            className="mt-3 rounded-lg bg-amber-800 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600"
            disabled={summaryBusy || !outcome.configured}
            onClick={() => {
              void approveSummary();
            }}
            type="button"
          >
            {summaryBusy ? "Připravuji…" : "Povolit shrnutí"}
          </button>
        </section>
      ) : null}

      {summary !== null ? (
        <section className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-4">
          <h3 className="text-sm font-semibold text-stone-800">
            Shrnutí „{summary.noteTitle}“ · verze {summary.noteVersion}
          </h3>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
            {summary.summaryText}
          </p>
        </section>
      ) : null}

      {outcome?.kind === "proposal" ? (
        <section
          className="mt-4 rounded-xl border border-stone-300 bg-white p-4"
          data-testid="chained-proposal"
        >
          <h3 className="text-sm font-semibold text-stone-900">
            Návrh: {proposalOperationLabel(outcome.proposal.operation.type)} ·{" "}
            {outcome.proposal.noteTitle} · verze{" "}
            {outcome.proposal.expectedVersion}
          </h3>
          <p className="mt-1 text-xs leading-5 text-stone-600">
            Cíl: {proposalTargetLabel(outcome.proposal)}. Návrh nic nemění;
            potvrzení zapíše nejvýše jednu revizi ai, kterou lze vrátit.
          </p>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-stone-200 bg-stone-50 p-3 font-mono text-xs leading-6">
            {outcome.proposal.diff.prefix}
            <del className="bg-red-100 text-red-900">
              {outcome.proposal.diff.removed}
            </del>
            <ins className="bg-emerald-100 text-emerald-950 no-underline">
              {outcome.proposal.diff.inserted}
            </ins>
            {outcome.proposal.diff.suffix}
          </pre>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600"
              disabled={proposalBusy}
              onClick={() => {
                void confirmProposal();
              }}
              type="button"
            >
              {proposalBusy ? "Potvrzuji…" : "Potvrdit"}
            </button>
            <button
              className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-semibold text-red-800 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-stone-400"
              disabled={proposalBusy}
              onClick={() => {
                void rejectProposal();
              }}
              type="button"
            >
              Zamítnout
            </button>
          </div>
        </section>
      ) : null}

      {lastApplied !== null ? (
        <button
          className="mt-3 rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-semibold text-stone-800 hover:bg-stone-100"
          disabled={proposalBusy}
          onClick={() => {
            void undoLastChange();
          }}
          type="button"
        >
          Vrátit poslední změnu
        </button>
      ) : null}
    </section>
  );
}
