"use client";

import { useSyncExternalStore } from "react";

import {
  formatMetricsMs,
  formatMetricsRange,
  voiceMetrics,
  type MetricsSnapshot,
  type ModeSummary,
  type VoiceMode,
} from "@/lib/voice-agent/metrics";

const EMPTY_SNAPSHOT: MetricsSnapshot = {
  generatedAt: 0,
  modes: [],
  sessions: [],
};

function getServerSnapshot(): MetricsSnapshot {
  return EMPTY_SNAPSHOT;
}

const modeLabels: Record<VoiceMode, string> = {
  chained: "Řetězený režim",
  gemini: "Gemini Live",
};

function ModeCard({ mode }: { readonly mode: ModeSummary }) {
  const usage = mode.usage;
  const usageParts: string[] = [];

  if (usage.reported > 0) {
    usageParts.push(
      `reported ${usage.reported} (${usage.reportedUsd.toFixed(6)} USD)`,
    );
  }

  if (usage.estimated > 0) {
    usageParts.push(
      `estimated ${usage.estimated} (${usage.estimatedUsd.toFixed(6)} USD)`,
    );
  }

  if (usage.unknown > 0) {
    usageParts.push(`unknown ${usage.unknown}`);
  }

  return (
    <div className="rounded-xl border border-stone-200 bg-stone-50 p-4">
      <h3 className="text-sm font-semibold text-stone-900">
        {modeLabels[mode.mode]}
      </h3>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs leading-5 text-stone-700">
        <dt>Relace</dt>
        <dd>
          {mode.sessions} (chyby relace {mode.sessionErrors})
        </dd>
        <dt>Turny / dokončené</dt>
        <dd>
          {mode.turns} / {mode.finishedTurns}
        </dd>
        <dt>Chyby</dt>
        <dd>{mode.errors}</dd>
        <dt>První audio chunk (proxy)</dt>
        <dd>
          {formatMetricsMs(mode.firstAudioMedianMs)} (medián, n=
          {mode.firstAudioMs.length})
        </dd>
        <dt>Rozsah prvního zvuku</dt>
        <dd>{formatMetricsRange(mode.firstAudioRangeMs)}</dd>
        <dt>Barge-in → zastavení fronty</dt>
        <dd>
          {formatMetricsMs(mode.bargeInSilenceMedianMs)} (n=
          {mode.bargeInSilenceMs.length}), rozsah{" "}
          {formatMetricsRange(mode.bargeInSilenceRangeMs)}
        </dd>
        <dt>
          {mode.mode === "gemini"
            ? "Tool dispatch (Gemini)"
            : "Chained turn (LLM + tools)"}
        </dt>
        <dd>
          {formatMetricsMs(mode.toolRoundTripMedianMs)} (n=
          {mode.toolRoundTripMs.length}), rozsah{" "}
          {formatMetricsRange(mode.toolRoundTripRangeMs)}
        </dd>
        <dt>Výběr poznámky</dt>
        <dd>
          {mode.selections}
          {mode.noteMatches + mode.noteMismatches === 0
            ? " (shoda nevyhodnocena)"
            : ` (shoda ${mode.noteMatches}, neshoda ${mode.noteMismatches})`}
        </dd>
        <dt>Návrhy</dt>
        <dd>
          pending {mode.proposals.pending}, rejected {mode.proposals.rejected},
          applied {mode.proposals.applied}, undo {mode.proposals.undo}, failed{" "}
          {mode.proposals.failed}
        </dd>
        <dt>Usage</dt>
        <dd>{usageParts.length === 0 ? "neznámé" : usageParts.join("; ")}</dd>
      </dl>
    </div>
  );
}

export function AgentStatus() {
  const snapshot = useSyncExternalStore(
    voiceMetrics.subscribe,
    voiceMetrics.getSnapshot,
    getServerSnapshot,
  );
  const gemini = snapshot.modes.find((mode) => mode.mode === "gemini");
  const chained = snapshot.modes.find((mode) => mode.mode === "chained");

  return (
    <section
      aria-labelledby="voice-agent-metrics-title"
      className="mt-8 rounded-2xl border border-stone-300 bg-white p-6"
      data-testid="voice-agent-metrics"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-stone-600">
            Instrumentace
          </p>
          <h2
            className="mt-2 text-xl font-semibold text-stone-950"
            id="voice-agent-metrics-title"
          >
            Metriky relace
          </h2>
        </div>
        <button
          className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-semibold text-stone-700 hover:bg-stone-100"
          onClick={() => {
            voiceMetrics.reset();
          }}
          type="button"
        >
          Vymazat metriky
        </button>
      </div>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">
        Ukládají se jen souhrnná čísla a kódy v paměti stránky: žádný přepis,
        zvuk, klíč, ID poznámky ani text poznámky. První audio je proxy od
        poslední aktivity přepisu řeči, respektive od konce Scribe turnu; není
        to měření akustického ticha na výstupu. Barge-in měří jen synchronní
        zastavení fronty, ne skutečné ticho reproduktoru. Ceny jsou uvedené jen
        tehdy, když je provider skutečně reportuje nebo je aplikace odhadne;
        jinak zůstávají neznámé.
      </p>

      <p className="mt-2 text-xs font-medium text-amber-800">
        Live srovnání je neověřené: tato tabulka je offline instrumentace, ne
        benchmark latence ani kvality češtiny.
      </p>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <ModeCard
          mode={
            gemini ?? {
              bargeInSilenceMs: [],
              bargeInSilenceMedianMs: null,
              bargeInSilenceRangeMs: null,
              errors: 0,
              finishedTurns: 0,
              firstAudioMedianMs: null,
              firstAudioMs: [],
              firstAudioRangeMs: null,
              mode: "gemini",
              noteMatches: 0,
              noteMismatches: 0,
              proposals: {
                applied: 0,
                failed: 0,
                pending: 0,
                rejected: 0,
                undo: 0,
              },
              selections: 0,
              sessionErrors: 0,
              sessions: 0,
              toolRoundTripMedianMs: null,
              toolRoundTripMs: [],
              toolRoundTripRangeMs: null,
              turns: 0,
              usage: {
                estimated: 0,
                estimatedUsd: 0,
                reported: 0,
                reportedUsd: 0,
                unknown: 0,
              },
            }
          }
        />
        <ModeCard
          mode={
            chained ?? {
              bargeInSilenceMs: [],
              bargeInSilenceMedianMs: null,
              bargeInSilenceRangeMs: null,
              errors: 0,
              finishedTurns: 0,
              firstAudioMedianMs: null,
              firstAudioMs: [],
              firstAudioRangeMs: null,
              mode: "chained",
              noteMatches: 0,
              noteMismatches: 0,
              proposals: {
                applied: 0,
                failed: 0,
                pending: 0,
                rejected: 0,
                undo: 0,
              },
              selections: 0,
              sessionErrors: 0,
              sessions: 0,
              toolRoundTripMedianMs: null,
              toolRoundTripMs: [],
              toolRoundTripRangeMs: null,
              turns: 0,
              usage: {
                estimated: 0,
                estimatedUsd: 0,
                reported: 0,
                reportedUsd: 0,
                unknown: 0,
              },
            }
          }
        />
      </div>
      {snapshot.modes.every((mode) => mode.turns === 0) ? (
        <p className="mt-3 text-sm text-stone-500">
          Zatím žádná měření. Spusťte jeden z režimů a zkuste scénář.
        </p>
      ) : null}
      {snapshot.sessions.length > 0 ? (
        <p className="mt-2 text-xs leading-5 text-stone-500">
          Relace: {snapshot.sessions.length}; ukončené:{" "}
          {snapshot.sessions.filter((session) => session.endedAt !== null).length}.
        </p>
      ) : null}
    </section>
  );
}
