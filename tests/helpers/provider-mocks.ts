import {
  setOpenRouterTransportForTests,
  type OpenRouterTransport,
  type OpenRouterTransportRequest,
} from "../../src/lib/ai/openrouter";
import {
  setElevenLabsTransportForTests,
  type ElevenLabsTransport,
  type ScribeTokenTransportRequest,
} from "../../src/lib/elevenlabs/client";
import type {
  MicrophoneLock,
  MicrophoneLockManager,
  MicrophoneLockMode,
} from "../../src/lib/voice/microphone";

export class UnmockedProviderCallError extends Error {
  constructor() {
    super("Unmocked provider call blocked in tests.");
    this.name = "UnmockedProviderCallError";
  }
}

export interface MockElevenLabsTransport extends ElevenLabsTransport {
  readonly calls: ScribeTokenTransportRequest[];
}

export interface MockElevenLabsTransportOptions {
  readonly tokens?: readonly string[];
  readonly handler?: (
    request: ScribeTokenTransportRequest,
    callIndex: number,
  ) => string | Promise<string>;
  readonly error?: unknown;
}

export function createMockElevenLabsTransport(
  options: MockElevenLabsTransportOptions = {},
): MockElevenLabsTransport {
  const calls: ScribeTokenTransportRequest[] = [];
  let callIndex = 0;

  return {
    calls,
    async createToken(request) {
      calls.push(request);
      const index = callIndex;
      callIndex += 1;

      if (options.error !== undefined) {
        throw options.error;
      }

      const token = options.handler
        ? await options.handler(request, index)
        : options.tokens?.[index];

      if (typeof token !== "string" || token.length === 0) {
        throw new UnmockedProviderCallError();
      }

      return { token };
    },
  };
}

export function installUnmockedProviderGuard(): void {
  setElevenLabsTransportForTests({
    async createToken() {
      throw new UnmockedProviderCallError();
    },
  });
  setOpenRouterTransportForTests({
    async fetch() {
      throw new UnmockedProviderCallError();
    },
  });
}

export function resetProviderMocks(): void {
  setElevenLabsTransportForTests(null);
  setOpenRouterTransportForTests(null);
}

export interface MockOpenRouterTransport extends OpenRouterTransport {
  readonly calls: OpenRouterTransportRequest[];
}

type OpenRouterResponseFactory = (
  request: OpenRouterTransportRequest,
  callIndex: number,
) => Response | Promise<Response>;

export interface MockOpenRouterTransportOptions {
  readonly responses?:
    | readonly (Response | OpenRouterResponseFactory)[]
    | OpenRouterResponseFactory;
  readonly error?: unknown;
}

export function createMockOpenRouterTransport(
  options: MockOpenRouterTransportOptions = {},
): MockOpenRouterTransport {
  const calls: OpenRouterTransportRequest[] = [];
  let callIndex = 0;

  return {
    calls,
    async fetch(request) {
      calls.push(request);
      const index = callIndex;
      callIndex += 1;

      if (options.error !== undefined) {
        throw options.error;
      }

      const entry = options.responses
        ? typeof options.responses === "function"
          ? await options.responses(request, index)
          : options.responses[index]
        : undefined;
      const response =
        typeof entry === "function"
          ? await entry(request, index)
          : entry;

      if (!response) {
        throw new UnmockedProviderCallError();
      }

      return response.clone();
    },
  };
}

export interface FakeLockManager extends MicrophoneLockManager {
  readonly heldNames: Set<string>;
}

export function createFakeLockManager(): FakeLockManager {
  const heldNames = new Set<string>();

  return {
    heldNames,
    async request(
      name: string,
      options: {
        readonly mode?: MicrophoneLockMode;
        readonly ifAvailable?: boolean;
      },
      callback: (lock: MicrophoneLock | null) => Promise<void> | void,
    ) {
      if (heldNames.has(name)) {
        if (options.ifAvailable) {
          await callback(null);
          return;
        }

        throw new Error("Queued Web Locks are not implemented in this fake.");
      }

      heldNames.add(name);

      try {
        await callback({
          name,
          mode: options.mode ?? "exclusive",
        });
      } finally {
        heldNames.delete(name);
      }
    },
  };
}
