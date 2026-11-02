"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { formatUsdAmount } from "@/lib/ai/usage-format";
import type { TtsProviderStatus } from "@/lib/tts/provider";
import {
  getTtsVoicePreferenceServerSnapshot,
  getTtsVoicePreferenceSnapshot,
  subscribeTtsVoicePreference,
  writeTtsVoicePreference,
} from "@/lib/tts/voice-preference";
import {
  DEFAULT_GEMINI_VOICE,
  GEMINI_LIVE_VOICES,
  isGeminiVoice,
  type GeminiVoice,
} from "@/lib/voice-agent/gemini-voices";
import {
  getGeminiVoicePreferenceServerSnapshot,
  getGeminiVoicePreferenceSnapshot,
  subscribeGeminiVoicePreference,
  writeGeminiVoicePreference,
} from "@/lib/voice/gemini-voice-preference";
import { previewGeminiVoice } from "@/lib/voice-agent/gemini-voice-preview";
import { pcm16ToFloat32 } from "@/lib/voice-agent/pcm-audio";

const TTS_TEST_SENTENCE = "Toto je testovací věta pro čtení nahlas.";
const GEMINI_TEST_SENTENCE =
  "Toto je testovací věta pro hlasovou konverzaci.";

interface DefaultVoiceSettingsProps {
  readonly ttsStatus: TtsProviderStatus | null;
  readonly ttsStatusError: string | null;
  readonly ttsMaxCostUsd: number;
}

function availabilityLabel(
  availability: TtsProviderStatus["voices"][number]["availability"],
): string {
  switch (availability) {
    case "available":
      return "ověřený";
    case "live_unverified":
      return "neověřený v provozu";
    case "unavailable":
      return "nedostupný pro účet";
  }
}

function readApiError(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) {
    return fallback;
  }

  const error = (payload as { error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return fallback;
  }

  const message = (error as { message?: unknown }).message;

  return typeof message === "string" && message.trim() !== ""
    ? message
    : fallback;
}

export function DefaultVoiceSettings({
  ttsStatus,
  ttsStatusError,
  ttsMaxCostUsd,
}: DefaultVoiceSettingsProps) {
  const ttsVoices = ttsStatus?.voices ?? [];
  const storedTtsVoice = useSyncExternalStore(
    subscribeTtsVoicePreference,
    getTtsVoicePreferenceSnapshot,
    getTtsVoicePreferenceServerSnapshot,
  );
  const storedGeminiVoice = useSyncExternalStore(
    subscribeGeminiVoicePreference,
    getGeminiVoicePreferenceSnapshot,
    getGeminiVoicePreferenceServerSnapshot,
  );
  const [selectedTtsVoice, setSelectedTtsVoice] = useState("");
  const [selectedGeminiVoice, setSelectedGeminiVoice] = useState("");
  const [ttsConsent, setTtsConsent] = useState(false);
  const [ttsBusy, setTtsBusy] = useState(false);
  const [ttsTestError, setTtsTestError] = useState<string | null>(null);
  const [ttsNotice, setTtsNotice] = useState<string | null>(null);
  const [geminiConsent, setGeminiConsent] = useState(false);
  const [geminiBusy, setGeminiBusy] = useState(false);
  const [geminiTestError, setGeminiTestError] = useState<string | null>(null);
  const [geminiNotice, setGeminiNotice] = useState<string | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsUrlRef = useRef<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const geminiAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      ttsAudioRef.current?.pause();
      ttsAudioRef.current = null;

      if (ttsUrlRef.current !== null) {
        URL.revokeObjectURL(ttsUrlRef.current);
        ttsUrlRef.current = null;
      }

      geminiAbortRef.current?.abort();
      geminiAbortRef.current = null;
      void audioContextRef.current?.close();
      audioContextRef.current = null;
    };
  }, []);

  const effectiveTtsVoice =
    selectedTtsVoice !== "" &&
    ttsVoices.some((voice) => voice.id === selectedTtsVoice)
      ? selectedTtsVoice
      : storedTtsVoice !== null &&
          ttsVoices.some((voice) => voice.id === storedTtsVoice)
        ? storedTtsVoice
        : (ttsVoices.find((voice) => voice.availability !== "unavailable")
            ?.id ?? "sarah");
  const effectiveGeminiVoice: GeminiVoice = isGeminiVoice(selectedGeminiVoice)
    ? selectedGeminiVoice
    : isGeminiVoice(storedGeminiVoice)
      ? storedGeminiVoice
      : DEFAULT_GEMINI_VOICE;
  const currentTtsDefaultLabel =
    storedTtsVoice !== null
      ? (ttsVoices.find((voice) => voice.id === storedTtsVoice)?.label ??
        storedTtsVoice)
      : "není uložen (použije se první dostupný)";
  const currentGeminiDefaultLabel = isGeminiVoice(storedGeminiVoice)
    ? storedGeminiVoice
    : DEFAULT_GEMINI_VOICE;

  async function handleTtsTest() {
    if (!ttsConsent) {
      setTtsTestError("Potvrďte placené vyzkoušení hlasu.");
      return;
    }

    setTtsBusy(true);
    setTtsTestError(null);
    setTtsNotice(null);

    try {
      const response = await fetch("/api/tts", {
        body: JSON.stringify({
          text: TTS_TEST_SENTENCE,
          voice: effectiveTtsVoice,
        }),
        headers: {
          accept: "audio/mpeg",
          "content-type": "application/json",
        },
        method: "POST",
      });

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        throw new Error(
          readApiError(payload, "Zkoušku hlasu se nepodařilo přehrát."),
        );
      }

      const blob = await response.blob();

      if (ttsUrlRef.current !== null) {
        URL.revokeObjectURL(ttsUrlRef.current);
      }

      const url = URL.createObjectURL(blob);
      ttsUrlRef.current = url;
      const audio = new Audio(url);
      ttsAudioRef.current = audio;
      audio.onended = () => {
        setTtsBusy(false);
        setTtsNotice("Test hlasu se přehrál.");
      };
      audio.onerror = () => {
        setTtsBusy(false);
        setTtsTestError("Zvuk se nepodařilo přehrát.");
      };
      await audio.play();
    } catch (error) {
      setTtsBusy(false);
      setTtsTestError(
        error instanceof Error
          ? error.message
          : "Zkoušku hlasu se nepodařilo přehrát.",
      );
    }
  }

  function handleTtsSave() {
    writeTtsVoicePreference(effectiveTtsVoice);
    setTtsTestError(null);
    setTtsNotice("Výchozí hlas čtení nahlas byl uložen.");
  }

  async function handleGeminiTest() {
    if (!geminiConsent) {
      setGeminiTestError("Potvrďte placené vyzkoušení hlasu.");
      return;
    }

    setGeminiBusy(true);
    setGeminiTestError(null);
    setGeminiNotice(null);
    const controller = new AbortController();
    geminiAbortRef.current = controller;

    try {
      const audio = await previewGeminiVoice(
        effectiveGeminiVoice,
        GEMINI_TEST_SENTENCE,
        { signal: controller.signal },
      );
      const context = audioContextRef.current ?? new AudioContext();
      audioContextRef.current = context;
      await context.resume();
      const samples = pcm16ToFloat32(audio.pcm);
      const buffer = context.createBuffer(1, samples.length, audio.sampleRate);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        setGeminiBusy(false);
        setGeminiNotice("Test hlasu se přehrál.");
      };
      source.start();
    } catch (error) {
      setGeminiBusy(false);
      setGeminiTestError(
        error instanceof Error
          ? error.message
          : "Zkoušku hlasu se nepodařilo přehrát.",
      );
    } finally {
      geminiAbortRef.current = null;
    }
  }

  function handleGeminiSave() {
    writeGeminiVoicePreference(effectiveGeminiVoice);
    setGeminiTestError(null);
    setGeminiNotice("Výchozí hlas konverzace byl uložen.");
  }

  return (
    <section
      aria-labelledby="default-voices-title"
      className="mt-6 rounded-2xl border border-stone-200 bg-white p-6"
    >
      <h2
        className="text-xl font-semibold text-stone-950"
        id="default-voices-title"
      >
        Výchozí hlasy
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">
        Výchozí hlas se použije při otevření Čtení nahlas a Hlasové konverzace.
        Uložení je pouze v tomto prohlížeči.
      </p>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <div className="rounded-xl border border-stone-200 bg-stone-50 p-4">
          <h3 className="text-lg font-semibold text-stone-950">
            Čtení nahlas
          </h3>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            OpenRouter TTS. Aktuální výchozí:{" "}
            <strong>{currentTtsDefaultLabel}</strong>.
          </p>

          {ttsStatus === null ? (
            <p
              className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"
              role="alert"
            >
              {ttsStatusError ??
                "Stav čtení nahlas se nepodařilo načíst."}
            </p>
          ) : (
            <>
              <label className="mt-3 block text-sm font-medium text-stone-800">
                Hlas
                <select
                  className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900"
                  data-testid="default-tts-voice"
                  onChange={(event) => {
                    setSelectedTtsVoice(event.target.value);
                    setTtsTestError(null);
                    setTtsNotice(null);
                  }}
                  value={effectiveTtsVoice}
                >
                  {ttsVoices.map((voice) => (
                    <option
                      disabled={voice.availability === "unavailable"}
                      key={voice.id}
                      value={voice.id}
                    >
                      {voice.label} — {availabilityLabel(voice.availability)}
                    </option>
                  ))}
                </select>
              </label>

              <p className="mt-2 text-xs leading-5 text-stone-600">
                Testovací věta: „{TTS_TEST_SENTENCE}“
              </p>
              <p className="mt-1 text-xs leading-5 text-stone-600">
                Rezervace nejvýše{" "}
                {formatUsdAmount(String(ttsMaxCostUsd))}.
              </p>

              <label className="mt-3 flex items-start gap-2 text-sm text-stone-700">
                <input
                  checked={ttsConsent}
                  className="mt-1"
                  onChange={(event) => {
                    setTtsConsent(event.target.checked);
                    setTtsTestError(null);
                  }}
                  type="checkbox"
                />
                <span>Potvrzuji placené vyzkoušení hlasu.</span>
              </label>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600"
                  disabled={!ttsConsent || ttsBusy || ttsVoices.length === 0}
                  onClick={() => void handleTtsTest()}
                  type="button"
                >
                  {ttsBusy ? "Přehrávám…" : "Přehrát test"}
                </button>
                <button
                  className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60"
                  data-testid="default-tts-save"
                  disabled={ttsVoices.length === 0}
                  onClick={handleTtsSave}
                  type="button"
                >
                  Uložit jako výchozí
                </button>
              </div>

              {ttsNotice ? (
                <p
                  aria-live="polite"
                  className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
                >
                  {ttsNotice}
                </p>
              ) : null}

              {ttsTestError ? (
                <p
                  className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
                  role="alert"
                >
                  {ttsTestError}
                </p>
              ) : null}
            </>
          )}
        </div>

        <div className="rounded-xl border border-stone-200 bg-stone-50 p-4">
          <h3 className="text-lg font-semibold text-stone-950">
            Hlasová konverzace
          </h3>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            Gemini Live. Aktuální výchozí:{" "}
            <strong>{currentGeminiDefaultLabel}</strong>.
          </p>

          <label className="mt-3 block text-sm font-medium text-stone-800">
            Hlas
            <select
              className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900"
              data-testid="default-gemini-voice"
              onChange={(event) => {
                if (isGeminiVoice(event.target.value)) {
                  setSelectedGeminiVoice(event.target.value);
                  setGeminiTestError(null);
                  setGeminiNotice(null);
                }
              }}
              value={effectiveGeminiVoice}
            >
              {GEMINI_LIVE_VOICES.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.id} – {voice.description}
                </option>
              ))}
            </select>
          </label>

          <p className="mt-2 text-xs leading-5 text-stone-600">
            Testovací věta: „{GEMINI_TEST_SENTENCE}“
          </p>
          <p className="mt-1 text-xs leading-5 text-stone-600">
            Vyzkoušení otevře krátkou placenou Gemini Live relaci.
          </p>

          <label className="mt-3 flex items-start gap-2 text-sm text-stone-700">
            <input
              checked={geminiConsent}
              className="mt-1"
              onChange={(event) => {
                setGeminiConsent(event.target.checked);
                setGeminiTestError(null);
              }}
              type="checkbox"
            />
            <span>Potvrzuji placené vyzkoušení hlasu.</span>
          </label>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600"
              disabled={!geminiConsent || geminiBusy}
              onClick={() => void handleGeminiTest()}
              type="button"
            >
              {geminiBusy ? "Přehrávám…" : "Přehrát test"}
            </button>
            <button
              className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100"
              data-testid="default-gemini-save"
              onClick={handleGeminiSave}
              type="button"
            >
              Uložit jako výchozí
            </button>
          </div>

          {geminiNotice ? (
            <p
              aria-live="polite"
              className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
            >
              {geminiNotice}
            </p>
          ) : null}

          {geminiTestError ? (
            <p
              className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
              role="alert"
            >
              {geminiTestError}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
