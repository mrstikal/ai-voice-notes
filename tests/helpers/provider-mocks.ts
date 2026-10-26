import {
  setElevenLabsTransportForTests,
  type ElevenLabsTransport,
  type ScribeTokenTransportRequest,
} from "../../src/lib/elevenlabs/client";

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
}

export function resetProviderMocks(): void {
  setElevenLabsTransportForTests(null);
}
