"use client";

import { useSyncExternalStore } from "react";

import {
  getVoiceDiagnosticsServerSnapshot,
  getVoiceDiagnosticsSnapshot,
  resetVoiceDiagnostics,
  subscribeVoiceDiagnostics,
} from "@/lib/voice/diagnostics";
import {
  VAD_SILENCE_OPTIONS,
  formatVadSilence,
  getVadSilencePreferenceServerSnapshot,
  getVadSilencePreferenceSnapshot,
  isVadSilenceSecs,
  subscribeVadSilencePreference,
  writeVadSilencePreference,
} from "@/lib/voice/preferences";

function formatLatency(value: number | null): string {
  return value === null ? "zatím neměřeno" : `${value.toLocaleString("cs-CZ")} ms`;
}

export function VoiceSettings() {
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

  function handleVadSilenceChange(value: string) {
    const parsed = Number(value);

    if (isVadSilenceSecs(parsed)) {
      writeVadSilencePreference(parsed);
    }
  }

  return (
    <section
      aria-labelledby="voice-settings-heading"
      className="rounded-2xl border border-stone-200 bg-white p-6"
    >
      <h2
        className="text-xl font-semibold text-stone-950"
        id="voice-settings-heading"
      >
        Diktování a diagnostika
      </h2>
      <p className="mt-2 text-sm leading-6 text-stone-600">
        Prodleva ticha se předává ElevenLabs Scribe SDK přes{" "}
        <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">
          vadSilenceThresholdSecs
        </code>{" "}
        při dalším Startu. Diagnostika je pouze v paměti této karty; neukládá
        zvuk ani přepis a po obnovení stránky se vynuluje.
      </p>

      <div className="mt-4 max-w-sm">
        <label
          className="block text-sm font-medium text-stone-800"
          htmlFor="voice-vad-silence"
        >
          Prodleva ticha pro ukončení promluvy (VAD)
        </label>
        <select
          className="mt-2 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          id="voice-vad-silence"
          onChange={(event) => handleVadSilenceChange(event.target.value)}
          value={vadSilence}
        >
          {VAD_SILENCE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {formatVadSilence(option)}
            </option>
          ))}
        </select>
        <p className="mt-2 text-xs leading-5 text-stone-500">
          Výchozí hodnota je 1,2 s. Změna se použije až v nové relaci
          diktování.
        </p>
      </div>

      <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
        <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
          <dt className="font-medium text-stone-700">
            Od konce řeči k potvrzení
          </dt>
          <dd className="mt-1 text-stone-950">
            {formatLatency(diagnostics.lastCommitLatencyMs)}
          </dd>
        </div>
        <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
          <dt className="font-medium text-stone-700">
            Od konce řeči k příkazu
          </dt>
          <dd className="mt-1 text-stone-950">
            {formatLatency(diagnostics.lastCommandLatencyMs)}
          </dd>
        </div>
        <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
          <dt className="font-medium text-stone-700">
            Ruční reconnecty (všechna diktování)
          </dt>
          <dd className="mt-1 text-stone-950">
            {diagnostics.manualReconnectCount.toLocaleString("cs-CZ")}
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          onClick={resetVoiceDiagnostics}
          type="button"
        >
          Vynulovat diagnostiku
        </button>
        <span className="text-xs text-stone-500">
          Automatické reconnecty jsou vypnuté; nové připojení vždy vyžaduje
          ruční Start a nový token.
        </span>
      </div>
    </section>
  );
}
