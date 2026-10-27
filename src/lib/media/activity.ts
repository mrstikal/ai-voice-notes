const SERVER_SNAPSHOT = {
  playbackActive: false,
  microphoneActive: false,
} as const;

let playbackOwners = new Set<string>();
let microphoneOwners = new Set<string>();
let snapshot: {
  readonly playbackActive: boolean;
  readonly microphoneActive: boolean;
} = SERVER_SNAPSHOT;
const listeners = new Set<() => void>();

function publish(): void {
  const next = {
    playbackActive: playbackOwners.size > 0,
    microphoneActive: microphoneOwners.size > 0,
  };

  if (
    next.playbackActive === snapshot.playbackActive &&
    next.microphoneActive === snapshot.microphoneActive
  ) {
    return;
  }

  snapshot = next;

  for (const listener of listeners) {
    listener();
  }
}

export function setPlaybackOwnerActive(owner: string, active: boolean): void {
  if (active) {
    playbackOwners.add(owner);
  } else {
    playbackOwners.delete(owner);
  }

  publish();
}

export function setMicrophoneOwnerActive(owner: string, active: boolean): void {
  if (active) {
    microphoneOwners.add(owner);
  } else {
    microphoneOwners.delete(owner);
  }

  publish();
}

export function subscribeMediaActivity(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function getMediaActivitySnapshot(): {
  readonly playbackActive: boolean;
  readonly microphoneActive: boolean;
} {
  return snapshot;
}

export function getMediaActivityServerSnapshot(): {
  readonly playbackActive: boolean;
  readonly microphoneActive: boolean;
} {
  return SERVER_SNAPSHOT;
}

export function resetMediaActivityForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "Reset mediální aktivity lze použít pouze v NODE_ENV=test.",
    );
  }

  playbackOwners = new Set();
  microphoneOwners = new Set();
  snapshot = SERVER_SNAPSHOT;
  listeners.clear();
}
