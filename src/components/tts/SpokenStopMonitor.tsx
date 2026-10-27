"use client";

import { useEffect, useRef, useState } from "react";

import { useScribeDictation } from "@/components/voice/useScribeDictation";
import {
  isStandaloneStopCommand,
  recordStopMonitorAttempt,
  recordStopMonitorSuccess,
} from "@/lib/voice/stop-monitor";

const PARTIAL_STOP_GRACE_MS = 400;

export interface SpokenStopMonitorProps {
  readonly active: boolean;
  readonly onStop: () => void;
}

export function SpokenStopMonitor({
  active,
  onStop,
}: SpokenStopMonitorProps) {
  const onStopRef = useRef(onStop);
  const stopRef = useRef<() => Promise<void>>(async () => undefined);
  const finishStopRef = useRef<(latencyMs: number | null) => void>(
    () => undefined,
  );
  const commitRef = useRef<() => void>(() => undefined);
  const partialStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const sessionStartedRef = useRef(false);
  const stopHandledRef = useRef(false);
  const attemptRecordedRef = useRef(false);
  const [committedCount, setCommittedCount] = useState(0);

  const dictation = useScribeDictation({
    activityKind: "stop-monitor",
    lockMode: "shared",
    flushOnStop: false,
    onCommit: (segment, metadata) => {
      setCommittedCount((current) => current + 1);

      if (isStandaloneStopCommand(segment.text)) {
        finishStopRef.current(metadata.commandLatencyMs);
      }
    },
  });

  const {
    session,
    isStopping,
    start,
    stop,
    commit,
    partialTranscript,
  } = dictation;
  const busy = session.status !== "idle" && session.status !== "error";

  useEffect(() => {
    onStopRef.current = onStop;
  }, [onStop]);

  function clearPartialStopTimer() {
    if (partialStopTimerRef.current !== null) {
      clearTimeout(partialStopTimerRef.current);
      partialStopTimerRef.current = null;
    }
  }

  function finishStop(latencyMs: number | null) {
    if (stopHandledRef.current) {
      return;
    }

    stopHandledRef.current = true;
    clearPartialStopTimer();

    if (!attemptRecordedRef.current) {
      attemptRecordedRef.current = true;
      recordStopMonitorAttempt();
    }

    recordStopMonitorSuccess(latencyMs);
    void stopRef.current();
    onStopRef.current();
  }

  useEffect(() => {
    stopRef.current = () => stop({ flush: false });
  }, [stop]);

  useEffect(() => {
    finishStopRef.current = finishStop;
  });

  useEffect(() => {
    commitRef.current = commit;
  }, [commit]);

  useEffect(() => {
    if (!active || stopHandledRef.current || session.status !== "active") {
      clearPartialStopTimer();
      return;
    }

    if (isStandaloneStopCommand(partialTranscript)) {
      if (partialStopTimerRef.current === null) {
        partialStopTimerRef.current = setTimeout(() => {
          partialStopTimerRef.current = null;
          // A short standalone word may never reach the VAD commit. Ask
          // Scribe to commit it; the normal committed-stop path remains the
          // only thing that stops audio and records latency.
          try {
            commitRef.current();
          } catch {
            // The session may have closed between the partial and this timer.
          }
        }, PARTIAL_STOP_GRACE_MS);
      }

      return;
    }

    clearPartialStopTimer();
  }, [active, partialTranscript, session.status]);

  useEffect(() => clearPartialStopTimer, []);

  useEffect(() => {
    if (!active) {
      sessionStartedRef.current = false;
      stopHandledRef.current = false;
      clearPartialStopTimer();

      if (busy) {
        void stop({ flush: false });
      }

      return;
    }

    if (!sessionStartedRef.current && !busy && !isStopping) {
      sessionStartedRef.current = true;
      stopHandledRef.current = false;
      clearPartialStopTimer();
      start();
    }
  }, [active, busy, isStopping, start, stop]);

  useEffect(() => {
    if (session.status === "active" && !attemptRecordedRef.current) {
      attemptRecordedRef.current = true;
      recordStopMonitorAttempt();
    }

    if (session.status === "idle" || session.status === "error") {
      attemptRecordedRef.current = false;
    }
  }, [session.status]);

  const message =
    session.status === "active"
      ? "Poslouchám jen samostatný příkaz „stop“. Použijte sluchátka, aby zvuk z reproduktorů nerušil mikrofon."
      : session.status === "error"
        ? `Hlasový Stop není dostupný: ${session.error ?? "mikrofon nelze použít."} Tlačítko Stop funguje vždy.`
        : busy || isStopping
          ? "Spouštím experimentální hlasový Stop…"
          : active
            ? "Experimentální hlasový Stop se spouští."
            : "Experimentální hlasový Stop se spustí s přehráváním.";

  return (
    <div
      aria-live="polite"
      className={
        session.status === "error"
          ? "mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950"
          : "mt-3 text-xs leading-5 text-stone-600"
      }
      data-testid="spoken-stop-monitor"
    >
      {message}
      {session.status === "active" ? (
        <>
          {" "}
          Zachyceno celkem {committedCount} dokončených segmentů.
        </>
      ) : null}
      {session.status === "error" ? (
        <>
          {" "}
          <a
            className="font-semibold underline"
            href="/settings"
          >
            Otevřít nastavení
          </a>
        </>
      ) : null}
    </div>
  );
}
