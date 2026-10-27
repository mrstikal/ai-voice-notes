// @vitest-environment jsdom

import {
  type ScribeHookOptions,
  type ScribeStatus,
  type TranscriptSegment,
  type UseScribeReturn,
} from "@elevenlabs/react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode, createElement, useEffect, useState } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import {
  AudioPlayer,
  type PlaybackAudioFactory,
  type PlaybackAudioHandle,
} from "../../src/components/tts/AudioPlayer";
import type { NoteDetail } from "../../src/lib/notes/client";
import type { TtsProviderStatus } from "../../src/lib/tts/provider";
import type { TtsManifest } from "../../src/lib/tts/player";
import {
  getStopMonitorPreferenceSnapshot,
  getStopMonitorStatsSnapshot,
  isStandaloneStopCommand,
  recordStopMonitorAttempt,
  recordStopMonitorSuccess,
  resetStopMonitorForTests,
  resetStopMonitorStats,
  writeStopMonitorPreference,
} from "../../src/lib/voice/stop-monitor";
import {
  resetMediaActivityForTests,
} from "../../src/lib/media/activity";
import {
  MICROPHONE_LOCK_NAME,
  type MicrophoneLock,
  type MicrophoneLockManager,
  type MicrophoneLockMode,
} from "../../src/lib/voice/microphone";
import { TTS_PLAYBACK_LOCK_NAME } from "../../src/lib/tts/playback-lease";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const useScribeMock = vi.hoisted(() => vi.fn());

vi.mock("@elevenlabs/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elevenlabs/react")>();

  return { ...actual, useScribe: useScribeMock };
});

type ScribeConnection = NonNullable<
  ReturnType<UseScribeReturn["getConnection"]>
>;
type CommittedListener = (data: { text: string }) => void;

interface FakeConnection {
  readonly active: Set<CommittedListener>;
  readonly handle: ScribeConnection;
}

function createFakeConnection(): FakeConnection {
  const active = new Set<CommittedListener>();
  const handle = {
    on(event: string, listener: CommittedListener) {
      if (event === "committed_transcript") {
        active.add(listener);
      }
    },
    off(event: string, listener: CommittedListener) {
      if (event === "committed_transcript") {
        active.delete(listener);
      }
    },
    commit: vi.fn(),
  } as unknown as ScribeConnection;

  return { active, handle };
}

interface MockScribeInstance {
  options: ScribeHookOptions | null;
  readonly connections: FakeConnection[];
  readonly connect: Mock<UseScribeReturn["connect"]>;
  readonly disconnect: Mock<UseScribeReturn["disconnect"]>;
  readonly commit: Mock<UseScribeReturn["commit"]>;
  readonly emitPartial: (text: string) => void;
  readonly emitCommitted: (text: string) => void;
}

const scribeInstances: MockScribeInstance[] = [];

function createMockScribeInstance(
  setStatus: (status: ScribeStatus) => void,
  setPartialTranscript: (text: string) => void,
  setCommittedTranscripts: (
    update: (current: TranscriptSegment[]) => TranscriptSegment[],
  ) => void,
): MockScribeInstance {
  const connections: FakeConnection[] = [];
  const instance: MockScribeInstance = {
    options: null,
    connections,
    connect: vi.fn<UseScribeReturn["connect"]>(async () => {
      if (connectFailure) {
        throw new DOMException("Permission denied", "NotAllowedError");
      }

      connections.push(createFakeConnection());
      setStatus("connecting");
      instance.options?.onSessionStarted?.();
      setStatus("connected");
    }),
    disconnect: vi.fn<UseScribeReturn["disconnect"]>(() => {
      setStatus("disconnected");
      instance.options?.onDisconnect?.();
    }),
    commit: vi.fn<UseScribeReturn["commit"]>(() => undefined),
    emitPartial: (text) => {
      setPartialTranscript(text);
      instance.options?.onPartialTranscript?.({ text });
    },
    emitCommitted: (text) => {
      setCommittedTranscripts((current) => [
        ...current,
        { id: `segment-${current.length}`, text, timestamp: Date.now(), isFinal: true },
      ]);

      for (const listener of connections.at(-1)?.active ?? []) {
        listener({ text });
      }
    },
  };

  return instance;
}

function useMockScribe(options: ScribeHookOptions): UseScribeReturn {
  const [status, setStatus] = useState<ScribeStatus>("disconnected");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [committedTranscripts, setCommittedTranscripts] = useState<
    TranscriptSegment[]
  >([]);
  const [providerError] = useState<string | null>(null);
  const [instanceIndex] = useState(() => {
    scribeInstances.push(
      createMockScribeInstance(
        setStatus,
        setPartialTranscript,
        setCommittedTranscripts,
      ),
    );

    return scribeInstances.length - 1;
  });
  const instance = scribeInstances[instanceIndex]!;

  useEffect(() => {
    instance.options = options;
  }, [instance, options]);

  return {
    status,
    isConnected: status === "connected" || status === "transcribing",
    isTranscribing: status === "transcribing",
    isMuted: false,
    partialTranscript,
    committedTranscripts,
    error: providerError,
    connect: instance.connect,
    disconnect: instance.disconnect,
    mute: vi.fn(),
    unmute: vi.fn(),
    sendAudio: vi.fn(),
    commit: instance.commit,
    clearTranscripts: vi.fn(() => {
      setPartialTranscript("");
      setCommittedTranscripts(() => []);
    }),
    getConnection: () => instance.connections.at(-1)?.handle ?? null,
  };
}

const NOTE_ID = "55555555-5555-4555-8555-555555555555";
const SOURCE_HASH = "d".repeat(64);

const baseNote: NoteDetail = {
  category: null,
  contentMd: "První věta. Druhá věta.",
  contentPlain: "První věta. Druhá věta.",
  createdAt: "2026-10-27T10:00:00.000Z",
  deletedAt: null,
  id: NOTE_ID,
  tags: [],
  title: "Test hlasového Stopu",
  updatedAt: "2026-10-27T10:00:00.000Z",
  version: 1,
};

const providerStatus: TtsProviderStatus = {
  model: "elevenlabs/eleven-v4-turbo",
  responseFormat: "mp3",
  maxInputCodeUnits: 3500,
  estimatedMaxCostUsd: 0.14,
  configured: true,
  liveStatus: "verified",
  voices: [
    { id: "sarah", label: "Sarah", availability: "available" },
    { id: "george", label: "George", availability: "available" },
  ],
};

interface FakeAudio extends PlaybackAudioHandle {
  readonly disposed: boolean;
  triggerEnded(): void;
}

function createAudioHarness(): {
  readonly factory: PlaybackAudioFactory;
  readonly instances: FakeAudio[];
} {
  const instances: FakeAudio[] = [];
  const factory: PlaybackAudioFactory = () => {
    let disposed = false;
    let endedHandler: (() => void) | null = null;

    const audio = {
      get disposed() {
        return disposed;
      },
      play: () => Promise.resolve(),
      pause: () => undefined,
      dispose: () => {
        disposed = true;
      },
      setOnEnded: (handler: (() => void) | null) => {
        endedHandler = handler;
      },
      setOnError: () => undefined,
      triggerEnded: () => {
        endedHandler?.();
      },
    } as FakeAudio;

    instances.push(audio);
    return audio;
  };

  return { factory, instances };
}

function manifest(texts: readonly string[]): TtsManifest {
  return {
    noteId: NOTE_ID,
    noteVersion: 1,
    sourceHash: SOURCE_HASH,
    voice: "sarah",
    model: "elevenlabs/eleven-v4-turbo",
    selection: { scope: "full" },
    cacheHit: false,
    estimatedMaxCostUsd: "0.140000",
    sections: texts.map((text, index) => ({
      index,
      text,
      start: index * 10,
      end: index * 10 + text.length,
      cacheKey: `key-${index}`,
      cached: false,
    })),
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function audioResponse(): Response {
  return new Response(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0]), {
    status: 200,
    headers: { "content-type": "audio/mpeg" },
  });
}

function createTtsFetch(texts: readonly string[]): typeof fetch {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};

    return body.sectionIndex === undefined
      ? jsonResponse(manifest(texts))
      : audioResponse();
  }) as unknown as typeof fetch;
}

interface ModeAwareLocks extends MicrophoneLockManager {
  isHeld(name: string): boolean;
  isExclusive(name: string): boolean;
  sharedCount(name: string): number;
  holdExclusive(name: string): void;
}

function createModeAwareLocks(): ModeAwareLocks {
  const exclusive = new Set<string>();
  const shared = new Map<string, number>();

  function busy(name: string, mode: MicrophoneLockMode): boolean {
    return (
      exclusive.has(name) ||
      (mode === "exclusive" && (shared.get(name) ?? 0) > 0)
    );
  }

  return {
    isHeld(name) {
      return exclusive.has(name) || (shared.get(name) ?? 0) > 0;
    },
    isExclusive(name) {
      return exclusive.has(name);
    },
    sharedCount(name) {
      return shared.get(name) ?? 0;
    },
    holdExclusive(name) {
      exclusive.add(name);
    },
    async request(
      name: string,
      options: {
        readonly mode?: MicrophoneLockMode;
        readonly ifAvailable?: boolean;
      },
      callback: (lock: MicrophoneLock | null) => Promise<void> | void,
    ) {
      const mode = options.mode ?? "exclusive";

      if (busy(name, mode)) {
        if (options.ifAvailable) {
          await callback(null);
          return;
        }

        throw new Error("Queued Web Locks are not implemented in this fake.");
      }

      if (mode === "exclusive") {
        exclusive.add(name);
      } else {
        shared.set(name, (shared.get(name) ?? 0) + 1);
      }

      try {
        await callback({ name, mode });
      } finally {
        if (mode === "exclusive") {
          exclusive.delete(name);
        } else {
          const count = (shared.get(name) ?? 1) - 1;

          if (count === 0) {
            shared.delete(name);
          } else {
            shared.set(name, count);
          }
        }
      }
    },
  };
}

interface Harness {
  readonly audio: ReturnType<typeof createAudioHarness>;
  readonly locks: ModeAwareLocks;
  readonly noteFetches: () => number;
}

let locks: ModeAwareLocks;
let tokenFailure: boolean;
let connectFailure: boolean;
let noteFetchCount: number;
let originalLocksDescriptor: PropertyDescriptor | undefined;

async function startPlayback(
  texts: readonly string[] = ["První věta. Druhá věta."],
  options: { readonly strict?: boolean } = {},
): Promise<Harness> {
  const audio = createAudioHarness();
  const player = createElement(AudioPlayer, {
    audioFactory: audio.factory,
    fetchImpl: createTtsFetch(texts),
    note: baseNote,
    providerStatus,
  });

  render(options.strict ? createElement(StrictMode, null, player) : player);

  fireEvent.click(
    screen.getByRole("button", { name: "Zjistit rozsah a cenu" }),
  );
  await screen.findByTestId("tts-section-list");
  fireEvent.click(screen.getByTestId("tts-consent"));
  fireEvent.click(screen.getByRole("button", { name: "Přehrát" }));

  await waitFor(() => {
    expect(audio.instances).toHaveLength(1);
  });

  return {
    audio,
    locks,
    noteFetches: () => noteFetchCount,
  };
}

async function waitForMonitorActive() {
  await waitFor(() => {
    expect(scribeInstances.at(-1)?.connect).toHaveBeenCalled();
  });
  await screen.findByText(/Poslouchám jen samostatný příkaz/);
  await waitFor(() => {
    expect(
      scribeInstances.at(-1)?.connections.at(-1)?.active.size,
    ).toBe(1);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  resetStopMonitorForTests();
  resetMediaActivityForTests();
  scribeInstances.length = 0;
  tokenFailure = false;
  connectFailure = false;
  noteFetchCount = 0;
  useScribeMock.mockImplementation((options: ScribeHookOptions) =>
    useMockScribe(options),
  );
  locks = createModeAwareLocks();
  originalLocksDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "locks",
  );
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("/api/elevenlabs/scribe-token")) {
        if (tokenFailure) {
          throw new TypeError("offline");
        }

        return jsonResponse({ token: "sutkn_stop_monitor" });
      }

      if (url.includes("/api/notes")) {
        noteFetchCount += 1;
      }

      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  cleanup();
  resetStopMonitorForTests();
  resetMediaActivityForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();

  if (originalLocksDescriptor) {
    Object.defineProperty(navigator, "locks", originalLocksDescriptor);
  } else {
    delete (navigator as { locks?: unknown }).locks;
  }
});

describe("spoken Stop command and aggregates", () => {
  it("accepts only standalone stop with optional terminal punctuation", () => {
    for (const text of [
      "stop",
      " Stop. ",
      "STOP!",
      "stop,",
      "stop…",
      "stop?",
      "„Stop!“",
      "stóp.",
    ]) {
      expect(isStandaloneStopCommand(text)).toBe(true);
    }

    for (const text of [
      "stop prosím",
      "prosím stop",
      "zastav",
      "nestop",
      "stopku",
      "stop, prosím",
      "",
    ]) {
      expect(isStandaloneStopCommand(text)).toBe(false);
    }
  });

  it("is off by default and stores only aggregate attempt/success/delay numbers", () => {
    expect(getStopMonitorPreferenceSnapshot()).toBe(false);
    writeStopMonitorPreference(true);
    expect(getStopMonitorPreferenceSnapshot()).toBe(true);

    recordStopMonitorAttempt();
    recordStopMonitorSuccess(420);
    recordStopMonitorAttempt();
    recordStopMonitorSuccess(180);

    expect(getStopMonitorStatsSnapshot()).toEqual({
      attempts: 2,
      successes: 2,
      slowestDelayMs: 420,
    });
    expect(window.localStorage.getItem("ai-voice-notes:stop-monitor-stats")).toBe(
      JSON.stringify({
        attempts: 2,
        successes: 2,
        slowestDelayMs: 420,
      }),
    );
    expect(
      window.localStorage.getItem("ai-voice-notes:stop-monitor-stats"),
    ).not.toMatch(/transcript|audio|stopová věta/i);

    resetStopMonitorStats();
    expect(getStopMonitorStatsSnapshot()).toEqual({
      attempts: 0,
      successes: 0,
      slowestDelayMs: null,
    });
  });
});

describe("spoken Stop monitor", () => {
  it("ignores TTS echo, stops locally on standalone stop, closes the mic and records aggregates only", async () => {
    writeStopMonitorPreference(true);
    const harness = await startPlayback();
    await waitForMonitorActive();

    expect(scribeInstances).toHaveLength(1);
    expect(scribeInstances[0]!.options?.microphone).toMatchObject({
      echoCancellation: true,
      noiseSuppression: true,
    });
    expect(locks.isHeld(TTS_PLAYBACK_LOCK_NAME)).toBe(true);
    expect(locks.isHeld(MICROPHONE_LOCK_NAME)).toBe(true);
    expect(locks.sharedCount(MICROPHONE_LOCK_NAME)).toBe(2);

    const exclusiveDictationAcquired = await new Promise<boolean>((resolve) => {
      void locks.request(
        MICROPHONE_LOCK_NAME,
        { mode: "exclusive", ifAvailable: true },
        (lock) => resolve(lock !== null),
      );
    });
    expect(exclusiveDictationAcquired).toBe(false);

    act(() => {
      scribeInstances.at(-1)!.emitCommitted(
        "Toto je ozvěna právě čteného textu.",
      );
      scribeInstances.at(-1)!.emitCommitted("smaž odstavec");
    });

    expect(harness.audio.instances[0]!.disposed).toBe(false);
    expect(harness.noteFetches()).toBe(0);
    expect(getStopMonitorStatsSnapshot()).toMatchObject({
      attempts: 1,
      successes: 0,
      slowestDelayMs: null,
    });

    const sessionStartedAt = Date.now();
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValue(sessionStartedAt + 5_000);

    act(() => {
      scribeInstances.at(-1)!.emitPartial("stop");
      scribeInstances.at(-1)!.emitCommitted("stop");
      scribeInstances.at(-1)!.emitCommitted("stop");
    });
    nowSpy.mockRestore();

    await waitFor(() => {
      expect(harness.audio.instances[0]!.disposed).toBe(true);
    });
    expect(
      screen.getByText("Hlasový Stop zastavil přehrávání."),
    ).toBeDefined();
    expect(scribeInstances[0]!.disconnect).toHaveBeenCalled();
    expect(harness.noteFetches()).toBe(0);
    expect(getStopMonitorStatsSnapshot().attempts).toBe(1);
    expect(getStopMonitorStatsSnapshot().successes).toBe(1);
    expect(getStopMonitorStatsSnapshot().slowestDelayMs).toBe(0);

    await waitFor(() => {
      expect(locks.isHeld(TTS_PLAYBACK_LOCK_NAME)).toBe(false);
      expect(locks.isHeld(MICROPHONE_LOCK_NAME)).toBe(false);
    });
  });

  it("the physical Stop closes an active monitor and audio", async () => {
    writeStopMonitorPreference(true);
    const harness = await startPlayback();
    await waitForMonitorActive();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(harness.audio.instances[0]!.disposed).toBe(true);
    await waitFor(() => {
      expect(scribeInstances[0]!.disconnect).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(locks.isHeld(TTS_PLAYBACK_LOCK_NAME)).toBe(false);
      expect(locks.isHeld(MICROPHONE_LOCK_NAME)).toBe(false);
    });
  });

  it("forces a commit for a stable partial stop and stops only on the committed stop", async () => {
    writeStopMonitorPreference(true);
    const harness = await startPlayback();
    await waitForMonitorActive();
    const monitor = scribeInstances.at(-1)!;

    act(() => {
      monitor.emitPartial("stopku");
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(monitor.commit).not.toHaveBeenCalled();
    expect(harness.audio.instances[0]!.disposed).toBe(false);

    act(() => {
      monitor.emitPartial("stop");
    });

    await waitFor(
      () => {
        expect(monitor.commit).toHaveBeenCalled();
      },
      { timeout: 1500 },
    );
    expect(harness.audio.instances[0]!.disposed).toBe(false);

    act(() => {
      monitor.emitCommitted("stop");
    });

    await waitFor(() => {
      expect(harness.audio.instances[0]!.disposed).toBe(true);
    });
    expect(
      screen.getByText("Hlasový Stop zastavil přehrávání."),
    ).toBeDefined();
    const stats = getStopMonitorStatsSnapshot();
    expect(stats).toMatchObject({
      attempts: 1,
      successes: 1,
    });
    expect(stats.slowestDelayMs).not.toBeNull();
  });

  it("survives a forced commit that races a closed Scribe session", async () => {
    writeStopMonitorPreference(true);
    const harness = await startPlayback();
    await waitForMonitorActive();
    const monitor = scribeInstances.at(-1)!;
    monitor.commit.mockImplementation(() => {
      throw new Error("WebSocket is not connected");
    });

    act(() => {
      monitor.emitPartial("stop");
    });
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(harness.audio.instances[0]!.disposed).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(harness.audio.instances[0]!.disposed).toBe(true);
  });

  it("closes the microphone when playback ends without a spoken stop", async () => {
    writeStopMonitorPreference(true);
    const harness = await startPlayback(["Jediná sekce."]);
    await waitForMonitorActive();

    act(() => {
      harness.audio.instances[0]!.triggerEnded();
    });

    await waitFor(() => {
      expect(scribeInstances[0]!.disconnect).toHaveBeenCalled();
    });
    expect(screen.getByText("Přehrávání je dokončené.")).toBeDefined();
    expect(getStopMonitorStatsSnapshot()).toMatchObject({
      attempts: 1,
      successes: 0,
    });
    await waitFor(() => {
      expect(locks.isHeld(TTS_PLAYBACK_LOCK_NAME)).toBe(false);
      expect(locks.isHeld(MICROPHONE_LOCK_NAME)).toBe(false);
    });
  });

  it("refuses spoken Stop when another tab owns the microphone but keeps audio and the button working", async () => {
    writeStopMonitorPreference(true);
    locks.holdExclusive(MICROPHONE_LOCK_NAME);
    const harness = await startPlayback();

    expect(
      await screen.findByText(/Hlasový Stop není dostupný: Mikrofon už používá jiná karta/),
    ).toBeDefined();
    expect(harness.audio.instances[0]!.disposed).toBe(false);
    expect(locks.isHeld(TTS_PLAYBACK_LOCK_NAME)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(harness.audio.instances[0]!.disposed).toBe(true);
    await waitFor(() => {
      expect(locks.isHeld(TTS_PLAYBACK_LOCK_NAME)).toBe(false);
    });
    expect(locks.isExclusive(MICROPHONE_LOCK_NAME)).toBe(true);
  });

  it("keeps the physical Stop working when the token request fails", async () => {
    writeStopMonitorPreference(true);
    tokenFailure = true;
    const harness = await startPlayback();
    await waitFor(() => {
      expect(scribeInstances.at(-1)?.connect).not.toHaveBeenCalled();
    });

    expect(
      await screen.findByText(
        /Hlasový Stop není dostupný: Token pro diktování se nepodařilo načíst/,
      ),
    ).toBeDefined();
    expect(harness.audio.instances[0]!.disposed).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(harness.audio.instances[0]!.disposed).toBe(true);
    await waitFor(() => {
      expect(locks.isHeld(TTS_PLAYBACK_LOCK_NAME)).toBe(false);
      expect(locks.isHeld(MICROPHONE_LOCK_NAME)).toBe(false);
    });
    expect(harness.noteFetches()).toBe(0);
  });

  it("keeps the physical Stop working when microphone permission is denied", async () => {
    writeStopMonitorPreference(true);
    connectFailure = true;
    const harness = await startPlayback();
    await waitFor(() => {
      expect(scribeInstances.at(-1)?.connect).toHaveBeenCalled();
    });

    expect(
      await screen.findByText(
        /Hlasový Stop není dostupný: Přístup k mikrofonu byl zamítnut/,
      ),
    ).toBeDefined();
    expect(harness.audio.instances[0]!.disposed).toBe(false);
    await waitFor(() => {
      expect(locks.sharedCount(MICROPHONE_LOCK_NAME)).toBe(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(harness.audio.instances[0]!.disposed).toBe(true);
    await waitFor(() => {
      expect(locks.isHeld(TTS_PLAYBACK_LOCK_NAME)).toBe(false);
      expect(locks.isHeld(MICROPHONE_LOCK_NAME)).toBe(false);
    });
    expect(harness.noteFetches()).toBe(0);
  });

  it("starts the monitor under React StrictMode after cleanup", async () => {
    writeStopMonitorPreference(true);
    const harness = await startPlayback(["První věta."], { strict: true });

    await screen.findByText(/Poslouchám jen samostatný příkaz/);
    expect(
      scribeInstances.some(
        (instance) => instance.connect.mock.calls.length > 0,
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(harness.audio.instances[0]!.disposed).toBe(true);
    await waitFor(() => {
      expect(locks.isHeld(TTS_PLAYBACK_LOCK_NAME)).toBe(false);
      expect(locks.isHeld(MICROPHONE_LOCK_NAME)).toBe(false);
    });
  });

  it("does not start the monitor when the experimental setting is off", async () => {
    const harness = await startPlayback();

    expect(scribeInstances).toHaveLength(0);
    expect(harness.audio.instances[0]!.disposed).toBe(false);
    expect(locks.isExclusive(MICROPHONE_LOCK_NAME)).toBe(true);
    expect(screen.queryByTestId("spoken-stop-monitor")).toBeNull();
  });
});
