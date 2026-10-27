import {
  MicrophoneLeaseError,
  acquireMicrophoneLease,
  isWebLocksSupported,
  type MicrophoneLease,
  type MicrophoneLockManager,
} from "../voice/microphone.ts";

export class PlaybackLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaybackLeaseError";
  }
}

export async function tryAcquirePlaybackLease(
  locks?: MicrophoneLockManager | null,
): Promise<MicrophoneLease | null> {
  if (!isWebLocksSupported(locks)) {
    return null;
  }

  try {
    return await acquireMicrophoneLease({ locks });
  } catch (error) {
    if (
      error instanceof MicrophoneLeaseError &&
      error.code === "busy"
    ) {
      throw new PlaybackLeaseError(
        "Čtení nahlas nelze spustit: mikrofon nebo jiné přehrávání právě používá jiná karta. Ukončete jej a zkuste to znovu.",
      );
    }

    throw new PlaybackLeaseError(
      "Výhradní přístup k přehrávání se nepodařilo ověřit. Zkuste to znovu.",
    );
  }
}
