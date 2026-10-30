import {
  FakeMediaStream,
  FakeMediaStreamTrack,
  installFakeMedia,
  type FakeMediaHarness,
} from "./media-double";

type Listener = (event: { readonly type: string; readonly [key: string]: unknown }) => void;

class FakeSocketTarget {
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  protected dispatch(type: string, detail: Record<string, unknown> = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ type, ...detail });
    }
  }
}

export class FakeWebSocket extends FakeSocketTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  closeCalls: Array<{ readonly code?: number; readonly reason?: string }> = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("WebSocket is not open.");
    }

    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", { code: code ?? 1000, reason: reason ?? "", wasClean: true });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open");
  }

  message(payload: unknown): void {
    this.dispatch("message", { data: JSON.stringify(payload) });
  }

  error(): void {
    this.dispatch("error", { message: "fake-error" });
  }
}

export class FakeAudioBuffer {
  readonly channels: Float32Array[];
  readonly duration: number;

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channels = Array.from(
      { length: numberOfChannels },
      () => new Float32Array(length),
    );
    this.duration = length / sampleRate;
  }

  copyToChannel(source: Float32Array, channel: number): void {
    this.channels[channel]?.set(source);
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel] ?? new Float32Array(0);
  }
}

export class FakeBufferSource {
  buffer: FakeAudioBuffer | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;

  connect(): void {}
  start(at: number): void {
    this.startedAt = at;
  }
  stop(): void {
    this.stopped = true;
    this.onended?.();
  }
}

export class FakeScriptProcessor {
  onaudioprocess: ((event: {
    readonly inputBuffer: { getChannelData: (channel: number) => Float32Array };
  }) => void) | null = null;
  connect(): void {}
  disconnect(): void {}

  emit(samples: Float32Array): void {
    this.onaudioprocess?.({
      inputBuffer: { getChannelData: () => samples },
    });
  }
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  readonly sampleRate: number;
  readonly destination = {};
  readonly bufferSources: FakeBufferSource[] = [];
  readonly processors: FakeScriptProcessor[] = [];
  currentTime = 0;
  state: AudioContextState = "running";

  constructor(options?: AudioContextOptions) {
    this.sampleRate = options?.sampleRate ?? 48_000;
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect: () => undefined, disconnect: () => undefined };
  }

  createScriptProcessor(): FakeScriptProcessor {
    const processor = new FakeScriptProcessor();
    this.processors.push(processor);
    return processor;
  }

  createGain(): { gain: { value: number }; connect: () => void; disconnect: () => void } {
    return {
      gain: { value: 1 },
      connect: () => undefined,
      disconnect: () => undefined,
    };
  }

  createBuffer(
    channels: number,
    length: number,
    sampleRate: number,
  ): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }

  createBufferSource(): FakeBufferSource {
    const source = new FakeBufferSource();
    this.bufferSources.push(source);
    return source;
  }

  resume(): Promise<void> {
    this.state = "running";
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = "closed";
    return Promise.resolve();
  }
}

export interface FakeGeminiHarness {
  readonly media: FakeMediaHarness;
  readonly sockets: FakeWebSocket[];
  readonly audioContexts: FakeAudioContext[];
  restore(): void;
}

export function installFakeGeminiBrowser(): FakeGeminiHarness {
  const media = installFakeMedia();
  const globalScope = globalThis as {
    WebSocket?: typeof WebSocket;
    AudioContext?: typeof AudioContext;
  };
  const previousWebSocket = globalScope.WebSocket;
  const previousAudioContext = globalScope.AudioContext;
  FakeWebSocket.instances = [];
  FakeAudioContext.instances = [];
  globalScope.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalScope.AudioContext =
    FakeAudioContext as unknown as typeof AudioContext;

  return {
    media,
    sockets: FakeWebSocket.instances,
    audioContexts: FakeAudioContext.instances,
    restore() {
      media.restore();

      if (previousWebSocket === undefined) {
        delete globalScope.WebSocket;
      } else {
        globalScope.WebSocket = previousWebSocket;
      }

      if (previousAudioContext === undefined) {
        delete globalScope.AudioContext;
      } else {
        globalScope.AudioContext = previousAudioContext;
      }
    },
  };
}

export { FakeMediaStream, FakeMediaStreamTrack };
