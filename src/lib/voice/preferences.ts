export const VAD_SILENCE_OPTIONS = [0.8, 1.2, 1.5] as const;

export type VadSilenceSecs = (typeof VAD_SILENCE_OPTIONS)[number];

export const DEFAULT_VAD_SILENCE_SECS: VadSilenceSecs = 1.2;

const STORAGE_KEY = "ai-voice-notes:vad-silence-secs";
const CHANGE_EVENT = "ai-voice-notes:vad-silence-changed";

export function isVadSilenceSecs(value: unknown): value is VadSilenceSecs {
  return (
    typeof value === "number" &&
    VAD_SILENCE_OPTIONS.some((option) => option === value)
  );
}

export function readVadSilencePreference(): VadSilenceSecs {
  if (typeof window === "undefined") {
    return DEFAULT_VAD_SILENCE_SECS;
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const parsed = stored === null ? Number.NaN : Number(stored);

    return isVadSilenceSecs(parsed) ? parsed : DEFAULT_VAD_SILENCE_SECS;
  } catch {
    return DEFAULT_VAD_SILENCE_SECS;
  }
}

export function writeVadSilencePreference(value: VadSilenceSecs): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    return;
  }

  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeVadSilencePreference(
  listener: () => void,
): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  function handleStorage(event: StorageEvent) {
    if (event.key === STORAGE_KEY) {
      listener();
    }
  }

  window.addEventListener("storage", handleStorage);
  window.addEventListener(CHANGE_EVENT, listener);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}

export function getVadSilencePreferenceSnapshot(): VadSilenceSecs {
  return readVadSilencePreference();
}

export function getVadSilencePreferenceServerSnapshot(): VadSilenceSecs {
  return DEFAULT_VAD_SILENCE_SECS;
}

export function formatVadSilence(value: VadSilenceSecs): string {
  return `${value.toLocaleString("cs-CZ", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  })} s`;
}
