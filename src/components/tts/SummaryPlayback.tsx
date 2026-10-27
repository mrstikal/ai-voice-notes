"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { SummaryArtifact } from "@/lib/ai/summary-types";
import { formatUsdAmount } from "@/lib/ai/usage-format";
import {
  getMediaActivityServerSnapshot,
  getMediaActivitySnapshot,
  subscribeMediaActivity,
} from "@/lib/media/activity";
import type { TtsProviderStatus } from "@/lib/tts/provider";
import {
  PlaybackLeaseError,
  tryAcquirePlaybackLease,
} from "@/lib/tts/playback-lease";
import { isAbortError, readTtsErrorMessage } from "@/lib/tts/player";
import type { MicrophoneLease, MicrophoneLockManager } from "@/lib/voice/microphone";

import type { PlaybackAudioFactory, PlaybackAudioHandle } from "./AudioPlayer";

export interface SummaryPlaybackProps {
  readonly artifact: SummaryArtifact;
  readonly voice: string;
  readonly providerStatus: TtsProviderStatus | null;
  readonly disabled?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly audioFactory: PlaybackAudioFactory;
  readonly playbackLocks?: MicrophoneLockManager | null;
}

const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

export function SummaryPlayback({
  artifact,
  voice,
  providerStatus,
  disabled = false,
  fetchImpl = defaultFetch,
  audioFactory,
  playbackLocks,
}: SummaryPlaybackProps) {
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const media = useSyncExternalStore(
    subscribeMediaActivity,
    getMediaActivitySnapshot,
    getMediaActivityServerSnapshot,
  );
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<PlaybackAudioHandle | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const leaseRef = useRef<MicrophoneLease | null>(null);
  const mountedRef = useRef(true);

  const dispose = () => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    const audio = audioRef.current;
    audioRef.current = null;

    if (audio !== null) {
      try {
        audio.dispose();
      } catch {
        // A failed audio element must not affect the note.
      }
    }

    if (objectUrlRef.current !== null) {
      try {
        URL.revokeObjectURL(objectUrlRef.current);
      } catch {
        // Ignore an already released blob URL.
      }

      objectUrlRef.current = null;
    }

    const lease = leaseRef.current;
    leaseRef.current = null;

    if (lease !== null) {
      void lease.release().catch(() => undefined);
    }

    if (mountedRef.current) {
      setLoading(false);
      setPlaying(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;

      if (audioRef.current !== null) {
        try {
          audioRef.current.dispose();
        } catch {
          // Ignore a failed audio element during unmount.
        }

        audioRef.current = null;
      }

      if (objectUrlRef.current !== null) {
        try {
          URL.revokeObjectURL(objectUrlRef.current);
        } catch {
          // Ignore an already released blob URL.
        }

        objectUrlRef.current = null;
      }

      const lease = leaseRef.current;
      leaseRef.current = null;

      if (lease !== null) {
        void lease.release().catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    if (disabled || media.dictationActive) {
      dispose();
    }
  }, [disabled, media.dictationActive]);

  async function playSummary() {
    if (
      !consent ||
      disabled ||
      media.dictationActive ||
      providerStatus === null ||
      !providerStatus.configured
    ) {
      return;
    }

    dispose();
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setPlaying(false);
    setError(null);

    try {
      const lease = await tryAcquirePlaybackLease(playbackLocks, {
        microphoneLockMode: "exclusive",
      });

      if (generation !== generationRef.current || !mountedRef.current) {
        await lease?.release();
        return;
      }

      leaseRef.current = lease;
      const response = await fetchImpl("/api/tts", {
        method: "POST",
        headers: {
          accept: "audio/mpeg",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: artifact.summaryText,
          voice,
          noteId: artifact.noteId,
        }),
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
        const message = await readTtsErrorMessage(
          response,
          response.status === 429
            ? "Příliš mnoho požadavků na čtení shrnutí. Zkuste to za chvíli znovu."
            : "Shrnutí se nepodařilo přečíst nahlas.",
        );
        setError(message);
        dispose();
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
      audio.setOnEnded(() => {
        dispose();
      });
      audio.setOnError(() => {
        setError(
          "Zvuk shrnutí se nepodařilo přehrát. Poznámka zůstala beze změny.",
        );
        dispose();
      });
      await audio.play();

      if (
        generation !== generationRef.current ||
        controller.signal.aborted ||
        !mountedRef.current
      ) {
        return;
      }

      setLoading(false);
      setPlaying(true);
    } catch (playError) {
      if (
        generation !== generationRef.current ||
        isAbortError(playError) ||
        !mountedRef.current
      ) {
        return;
      }

      setError(
        playError instanceof PlaybackLeaseError
          ? playError.message
          : "Shrnutí se nepodařilo načíst nebo přehrát. Zkontrolujte připojení a zkuste to znovu; poznámka zůstala beze změny.",
      );
      dispose();
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }

  const providerUnavailable =
    providerStatus === null || !providerStatus.configured;

  return (
    <div
      className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4"
      data-testid="summary-playback"
    >
      <h3
        className="text-sm font-semibold text-emerald-950"
        id="summary-playback-heading"
      >
        Shrnutí k přečtení
      </h3>
      <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-emerald-950">
        {artifact.summaryText}
      </p>
      {providerStatus ? (
        <p className="mt-2 text-xs leading-5 text-emerald-900">
          OpenRouter · {providerStatus.model} · hlas {voice} · rezervace až{" "}
          {formatUsdAmount(String(providerStatus.estimatedMaxCostUsd))};
          skutečná cena může být neznámá. Odesílá se jen zobrazené shrnutí, ne
          celá poznámka.
        </p>
      ) : null}

      {providerUnavailable ? (
        <p className="mt-2 text-sm text-amber-950">
          Čtení nahlas není nakonfigurované. Shrnutí můžete vložit nebo zkopírovat
          bez přehrání.
        </p>
      ) : null}

      {media.dictationActive ? (
        <p className="mt-2 text-sm text-amber-950">
          Mikrofon je aktivní. Čtení shrnutí lze spustit až po ukončení
          diktování.
        </p>
      ) : null}

      <label className="mt-3 flex items-start gap-2 text-sm text-emerald-950">
        <input
          checked={consent}
          data-testid="summary-consent"
          disabled={disabled || providerUnavailable}
          onChange={(event) => setConsent(event.target.checked)}
          type="checkbox"
        />
        <span>
          Souhlasím s odesláním tohoto shrnutí poskytovateli a s rezervací
          odhadované ceny. Jde o nové placené rozhodnutí.
        </span>
      </label>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className="rounded-lg bg-emerald-800 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
          data-testid="summary-play"
          disabled={
            !consent ||
            disabled ||
            loading ||
            playing ||
            media.dictationActive ||
            providerUnavailable
          }
          onClick={() => void playSummary()}
          type="button"
        >
          {loading ? "Načítám…" : "Přehrát shrnutí"}
        </button>
        <button
          className="rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:text-stone-400"
          disabled={!loading && !playing}
          onClick={() => {
            dispose();
            setError(null);
          }}
          type="button"
        >
          Zastavit
        </button>
      </div>

      {error ? (
        <p className="mt-2 text-sm text-red-900" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
