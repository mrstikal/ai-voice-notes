import {
  MicrophoneLeaseError,
  acquireMicrophoneLease,
  isWebLocksSupported,
  type MicrophoneLease,
  type MicrophoneLockManager,
} from "../voice/microphone.ts";

export const TTS_PLAYBACK_LOCK_NAME = "ai-voice-notes:tts-playback";

export class PlaybackLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaybackLeaseError";
  }
}

export type PlaybackMicrophoneLockMode = "exclusive" | "shared" | "none";

export interface PlaybackLeaseOptions {
  /**
   * P19B holds the microphone lease exclusively so no dictation can overlap.
   * P20's experimental monitor needs to share the lock with playback and holds
   * it in shared mode. "none" exists only for callers that already own the
   * microphone lock.
   */
  readonly microphoneLockMode?: PlaybackMicrophoneLockMode;
}

function translateBusyError(error: unknown, microphone: boolean): never {
  if (error instanceof MicrophoneLeaseError && error.code === "busy") {
    throw new PlaybackLeaseError(
      microphone
        ? "Čtení nahlas nelze spustit: mikrofon právě používá jiná karta. Ukončete diktování a zkuste to znovu."
        : "Čtení nahlas už přehrává jiná karta. Ukončete je a zkuste to znovu.",
    );
  }

  throw new PlaybackLeaseError(
    microphone
      ? "Výhradní přístup k mikrofonu se nepodařilo ověřit. Zkuste to znovu."
      : "Výhradní přístup k přehrávání se nepodařilo ověřit. Zkuste to znovu.",
  );
}

export async function tryAcquirePlaybackLease(
  locks?: MicrophoneLockManager | null,
  options: PlaybackLeaseOptions = {},
): Promise<MicrophoneLease | null> {
  if (!isWebLocksSupported(locks)) {
    return null;
  }

  let playbackLease: MicrophoneLease;

  try {
    playbackLease = await acquireMicrophoneLease({
      locks,
      name: TTS_PLAYBACK_LOCK_NAME,
    });
  } catch (error) {
    translateBusyError(error, false);
  }

  const micMode = options.microphoneLockMode ?? "exclusive";

  if (micMode === "none") {
    return playbackLease;
  }

  try {
    const microphoneLease = await acquireMicrophoneLease({
      locks,
      mode: micMode,
    });

    return {
      async release() {
        await Promise.allSettled([
          microphoneLease.release(),
          playbackLease.release(),
        ]);
      },
    };
  } catch (error) {
    if (micMode === "shared") {
      // The physical Stop must remain usable when another mode owns the mic.
      // Playback continues with its own lock; the monitor will report the
      // conflict separately.
      return playbackLease;
    }

    await playbackLease.release().catch(() => undefined);
    translateBusyError(error, true);
  }
}
