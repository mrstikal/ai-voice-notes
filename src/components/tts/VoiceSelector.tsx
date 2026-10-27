"use client";

import type { TtsProviderStatus } from "@/lib/tts/provider";

const availabilityLabels: Record<
  TtsProviderStatus["voices"][number]["availability"],
  string
> = {
  available: "ověřený pro účet",
  live_unverified: "live unverified",
  unavailable: "nedostupný pro účet",
};

export interface VoiceSelectorProps {
  readonly status: TtsProviderStatus | null;
  readonly error?: string | null;
  readonly value: string;
  readonly onChange: (voice: string) => void;
  readonly disabled?: boolean;
}

export function VoiceSelector({
  status,
  error = null,
  value,
  onChange,
  disabled = false,
}: VoiceSelectorProps) {
  const availableVoices =
    status?.voices.filter((voice) => voice.availability !== "unavailable") ??
    [];
  const unavailable = status === null || !status.configured;

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <label
        className="text-sm font-medium text-stone-700"
        htmlFor="tts-voice"
      >
        Hlas čtení nahlas
      </label>
      <select
        className="mt-2 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:bg-stone-100"
        data-testid="tts-voice"
        disabled={disabled || unavailable || availableVoices.length === 0}
        id="tts-voice"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {status?.voices.map((voice) => (
          <option
            disabled={voice.availability === "unavailable"}
            key={voice.id}
            value={voice.id}
          >
            {voice.label} — {availabilityLabels[voice.availability]}
          </option>
        ))}
      </select>

      {status === null ? (
        <p className="mt-2 text-sm text-red-800">
          {error ?? "Stav hlasů se nepodařilo načíst."}
        </p>
      ) : !status.configured ? (
        <p className="mt-2 text-sm text-amber-900">
          OpenRouter není nakonfigurovaný. Čtení nahlas zůstává vypnuté a klíč
          se nikdy neposílá do prohlížeče.
        </p>
      ) : status.liveStatus === "live_unverified" ? (
        <p className="mt-2 text-xs leading-5 text-amber-900">
          Hlasy jsou live unverified. Před spolehnutím na výstup je potřeba
          samostatně povolený poslech české věty.
        </p>
      ) : (
        <p className="mt-2 text-xs leading-5 text-stone-500">
          Nabízejí se jen hlasy ověřené pro nakonfigurovaný účet. Nedostupný
          hlas nelze vybrat.
        </p>
      )}
    </div>
  );
}
