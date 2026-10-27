const STORAGE_KEY = "ai-voice-notes:tts-voice";
const CHANGE_EVENT = "ai-voice-notes:tts-voice-changed";

function readStoredVoice(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)?.trim();

    return stored ? stored : null;
  } catch {
    return null;
  }
}

export function readTtsVoicePreference(): string | null {
  return readStoredVoice();
}

export function writeTtsVoicePreference(voice: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, voice);
  } catch {
    return;
  }

  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeTtsVoicePreference(
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

export function getTtsVoicePreferenceSnapshot(): string | null {
  return readStoredVoice();
}

export function getTtsVoicePreferenceServerSnapshot(): string | null {
  return null;
}
