export class FakeMediaStreamTrack {
  readonly kind = "audio";
  readyState: MediaStreamTrackState = "live";
  stopCalls = 0;

  stop(): void {
    this.stopCalls += 1;
    this.readyState = "ended";
  }
}

export class FakeMediaStream {
  static nextId = 1;
  readonly id: string;
  readonly tracks: FakeMediaStreamTrack[];

  constructor(tracks: FakeMediaStreamTrack[] = []) {
    this.id = `fake-stream-${FakeMediaStream.nextId++}`;
    this.tracks = tracks;
  }

  getTracks(): FakeMediaStreamTrack[] {
    return [...this.tracks];
  }

  getAudioTracks(): FakeMediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}

export class FakeMediaDevices {
  readonly requests: MediaStreamConstraints[] = [];
  readonly streams: FakeMediaStream[] = [];
  getUserMediaImpl: (
    constraints: MediaStreamConstraints,
  ) => Promise<FakeMediaStream> = async () =>
    new FakeMediaStream([new FakeMediaStreamTrack()]);

  readonly getUserMedia = async (
    constraints: MediaStreamConstraints = { audio: true },
  ): Promise<FakeMediaStream> => {
    this.requests.push(constraints);
    const stream = await this.getUserMediaImpl(constraints);
    this.streams.push(stream);
    return stream;
  };
}

interface HeldLock {
  readonly mode: LockMode;
  count: number;
  readonly waiters: Array<() => void>;
}

export class FakeLockManager {
  private readonly held = new Map<string, HeldLock>();
  readonly requests: Array<{ readonly name: string; readonly mode: LockMode }> =
    [];

  async request<T>(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => Promise<T>,
  ): Promise<T> {
    const mode = options.mode ?? "exclusive";
    this.requests.push({ name, mode });

    while (!this.tryAcquire(name, mode)) {
      if (options.ifAvailable) {
        return callback(null);
      }

      await new Promise<void>((resolve) => {
        const held = this.held.get(name);

        if (held) {
          held.waiters.push(resolve);
        } else {
          resolve();
        }
      });
    }

    try {
      return await callback({ name, mode } as Lock);
    } finally {
      this.release(name, mode);
    }
  }

  isHeld(name: string): boolean {
    return this.held.has(name);
  }

  private tryAcquire(name: string, mode: LockMode): boolean {
    const held = this.held.get(name);

    if (!held) {
      this.held.set(name, { mode, count: 1, waiters: [] });
      return true;
    }

    if (held.mode === "shared" && mode === "shared") {
      held.count += 1;
      return true;
    }

    return false;
  }

  private release(name: string, mode: LockMode): void {
    const held = this.held.get(name);

    if (!held || held.mode !== mode) {
      return;
    }

    held.count -= 1;

    if (held.count > 0) {
      return;
    }

    this.held.delete(name);
    const waiters = held.waiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }
}

export interface FakeMediaHarness {
  readonly mediaDevices: FakeMediaDevices;
  readonly locks: FakeLockManager;
  restore(): void;
}

export function installFakeMedia(): FakeMediaHarness {
  const navigation = navigator as Navigator & {
    mediaDevices?: MediaDevices;
    locks?: LockManager;
  };
  const previousMediaDevices = Object.getOwnPropertyDescriptor(
    navigation,
    "mediaDevices",
  );
  const previousLocks = Object.getOwnPropertyDescriptor(navigation, "locks");
  const mediaDevices = new FakeMediaDevices();
  const locks = new FakeLockManager();
  Object.defineProperty(navigation, "mediaDevices", {
    configurable: true,
    value: mediaDevices,
  });
  Object.defineProperty(navigation, "locks", {
    configurable: true,
    value: locks,
  });

  function restoreProperty(
    target: object,
    key: string,
    descriptor: PropertyDescriptor | undefined,
  ): void {
    if (descriptor) {
      Object.defineProperty(target, key, descriptor);
    } else {
      delete (target as Record<string, unknown>)[key];
    }
  }

  return {
    mediaDevices,
    locks,
    restore() {
      restoreProperty(navigation, "mediaDevices", previousMediaDevices);
      restoreProperty(navigation, "locks", previousLocks);
    },
  };
}

export { FakeMediaDevices as FakeMicrophoneDevices };
