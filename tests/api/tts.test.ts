import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  BudgetExceededError,
  type UsageOperationDto,
  type UsageService,
} from "../../src/lib/ai/usage";
import {
  OpenRouterClient,
  type OpenRouterTransport,
} from "../../src/lib/ai/openrouter";
import { createReadAloudRouteHandler } from "../../src/app/api/tts/route";
import {
  DEFAULT_TTS_RATE_LIMIT,
  TTS_ESTIMATED_MAX_COST_USD,
  TTS_MAX_INPUT_CODE_UNITS,
  TTS_MODEL_ID,
  TTS_OPERATION,
  TTS_USD_PER_INPUT_UNIT,
  TTS_VOICES,
  createTtsRouteHandler,
  createTtsService,
  getTtsProviderStatus,
  type TtsService,
  type TtsVoice,
} from "../../src/lib/tts/provider";
import {
  createMockOpenRouterTransport,
  resetProviderMocks,
} from "../helpers/provider-mocks";

const APP_ORIGIN = "http://127.0.0.1:3000";
const REQUEST_URL = `${APP_ORIGIN}/api/tts`;
const RESERVATION_ID = "22222222-2222-4222-8222-222222222222";

function reservation(): UsageOperationDto {
  return {
    id: RESERVATION_ID,
    operation: TTS_OPERATION,
    provider: "openrouter",
    model: TTS_MODEL_ID,
    status: "started",
    reservedCostUsd: "0.140000",
    reportedCostUsd: null,
    providerUsage: null,
    startedAt: new Date("2026-10-27T10:00:00Z"),
    settledAt: null,
  };
}

function createFakeUsage() {
  const reserve = vi.fn();
  const settle = vi.fn();
  const markUnknown = vi.fn();
  const getSummary = vi.fn();
  const resetUsage = vi.fn();

  reserve.mockResolvedValue(reservation());
  markUnknown.mockResolvedValue({
    ...reservation(),
    status: "unknown",
    settledAt: new Date("2026-10-27T10:00:01Z"),
  });

  const usage: UsageService = {
    reserve,
    settle,
    markUnknown,
    getSummary,
    resetUsage,
  };

  return { usage, reserve, settle, markUnknown, getSummary, resetUsage };
}

function mp3Bytes(): Uint8Array {
  return new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);
}

function audioResponse(): Response {
  return new Response(Uint8Array.from(mp3Bytes()), {
    status: 200,
    headers: {
      "content-type": "audio/mpeg",
      "x-generation-id": "gen-tts-123",
    },
  });
}

function stallingAudioResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(mp3Bytes());
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "audio/mpeg",
      "x-generation-id": "gen-stall",
    },
  });
}

function jsonErrorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: { code: status, message } }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

function createService(options: {
  transport?: OpenRouterTransport;
  usage?: ReturnType<typeof createFakeUsage>;
  apiKey?: string;
  disabledVoices?: readonly TtsVoice[];
  timeoutMs?: number;
  maxResponseBytes?: number;
} = {}) {
  const fakeUsage = options.usage ?? createFakeUsage();
  const client = new OpenRouterClient({
    apiKey: options.apiKey ?? "test-only-openrouter",
    usage: fakeUsage.usage,
    transport: options.transport,
  });
  const service = createTtsService({
    client,
    disabledVoices: options.disabledVoices,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
  });

  return { service, client, ...fakeUsage };
}

function createRoute(serviceFactory: () => TtsService) {
  return createTtsRouteHandler({ serviceFactory });
}

function request(
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string | null>;
  } = {},
): Request {
  const headers = new Headers({
    host: "127.0.0.1:3000",
    origin: APP_ORIGIN,
    ...(options.body === undefined
      ? {}
      : { "content-type": "application/json" }),
  });

  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) {
      headers.delete(name);
    } else {
      headers.set(name, value);
    }
  }

  return new Request(REQUEST_URL, {
    method: options.method ?? "POST",
    headers,
    body:
      options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

beforeAll(() => {
  vi.stubEnv("APP_ORIGIN", APP_ORIGIN);
});

beforeEach(() => {
  resetProviderMocks();
});

afterEach(() => {
  resetProviderMocks();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/tts", () => {
  it("sends the exact pinned model, voice, and explicit mp3 format for both voices", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [audioResponse(), audioResponse()],
    });
    const { service, reserve, settle, markUnknown } = createService({
      transport,
    });
    const route = createRoute(() => service);
    const text = "Dobrý den, toto je česká zkouška čtení.";

    const first = await route(request({ body: { text, voice: "sarah" } }));
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("audio/mpeg");
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("x-tts-model")).toBe(TTS_MODEL_ID);
    expect(first.headers.get("x-tts-voice")).toBe("sarah");
    expect(first.headers.get("x-tts-generation-id")).toBe("gen-tts-123");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(mp3Bytes());

    const second = await route(request({ body: { text, voice: "george" } }));
    expect(second.status).toBe(200);
    expect(second.headers.get("x-tts-voice")).toBe("george");

    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]?.url).toBe(
      "https://openrouter.ai/api/v1/audio/speech",
    );
    expect(transport.calls[0]?.apiKey).toBe("test-only-openrouter");
    expect(transport.calls[0]?.accept).toBe("audio/mpeg");
    expect(JSON.parse(transport.calls[0]!.body)).toEqual({
      model: TTS_MODEL_ID,
      input: text,
      voice: "sarah",
      response_format: "mp3",
    });
    expect(JSON.parse(transport.calls[0]!.body)).not.toHaveProperty("speed");
    expect(JSON.parse(transport.calls[1]!.body)).toMatchObject({
      model: TTS_MODEL_ID,
      voice: "george",
      response_format: "mp3",
    });

    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenNthCalledWith(1, {
      operation: TTS_OPERATION,
      provider: "openrouter",
      model: TTS_MODEL_ID,
      estimatedMaxCostUsd: TTS_ESTIMATED_MAX_COST_USD,
    });
    expect(settle).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenNthCalledWith(
      1,
      RESERVATION_ID,
      {
        reportedCostUsd: text.length * TTS_USD_PER_INPUT_UNIT,
        providerUsage: expect.objectContaining({
          model: TTS_MODEL_ID,
          voice: "sarah",
          inputCodeUnits: text.length,
          responseFormat: "mp3",
          httpStatus: 200,
          contentType: "audio/mpeg",
          byteLength: mp3Bytes().byteLength,
          generationId: "gen-tts-123",
          chargeBasis: "input_characters",
          usdPerInputUnit: TTS_USD_PER_INPUT_UNIT,
          chargeReason: "estimated_from_input_length",
        }),
      },
    );
    expect(markUnknown).not.toHaveBeenCalled();
    expect(JSON.stringify(settle.mock.calls)).not.toContain(text);
    expect(JSON.stringify(settle.mock.calls)).not.toContain(
      "test-only-openrouter",
    );
  });

  it("rejects an invalid voice before reserving budget or calling OpenRouter", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [audioResponse()],
    });
    const { service, reserve } = createService({ transport });
    const route = createRoute(() => service);

    const response = await route(
      request({ body: { text: "Text", voice: "invented-voice" } }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "tts_invalid_voice",
        allowedVoices: TTS_VOICES.map((voice) => voice.id),
      },
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects a voice marked unavailable for the account", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [audioResponse()],
    });
    const { service, reserve } = createService({
      transport,
      disabledVoices: ["george"],
    });
    const route = createRoute(() => service);

    const response = await route(
      request({ body: { text: "Text", voice: "george" } }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "tts_voice_unavailable" },
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(transport.calls).toHaveLength(0);
  });

  it("enforces the 3,500 UTF-16 code-unit bound before any provider call", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [audioResponse()],
    });
    const { service, reserve } = createService({ transport });
    const route = createRoute(() => service);
    const tooLong = "a".repeat(TTS_MAX_INPUT_CODE_UNITS + 1);

    const rejected = await route(
      request({ body: { text: tooLong, voice: "sarah" } }),
    );

    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      error: {
        code: "tts_input_too_long",
        codeUnits: TTS_MAX_INPUT_CODE_UNITS + 1,
        maxCodeUnits: TTS_MAX_INPUT_CODE_UNITS,
      },
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(transport.calls).toHaveLength(0);

    const boundary = "a".repeat(TTS_MAX_INPUT_CODE_UNITS);
    const accepted = await route(
      request({ body: { text: boundary, voice: "sarah" } }),
    );

    expect(accepted.status).toBe(200);
    expect(JSON.parse(transport.calls[0]!.body).input).toHaveLength(
      TTS_MAX_INPUT_CODE_UNITS,
    );
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it("serves repeated direct summary text from the P19 cache with its note owner", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [audioResponse()],
    });
    const { service, reserve } = createService({ transport });
    const store = new Map<string, Uint8Array>();
    const cache = {
      clear: vi.fn(async () => 0),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      has: vi.fn(async (key: string) => store.has(key)),
      purgeModel: vi.fn(async () => 0),
      purgeNote: vi.fn(async () => 0),
      purgeVoice: vi.fn(async () => 0),
      put: vi.fn(async (key: string, bytes: Uint8Array) => {
        store.set(key, bytes);
      }),
      stats: vi.fn(async () => ({
        bytes: 0,
        entries: store.size,
        maxBytes: 1,
      })),
    };
    const route = createReadAloudRouteHandler({
      cache,
      ttsServiceFactory: () => service,
    });
    const body = {
      noteId: "11111111-1111-4111-8111-111111111111",
      text: "Zkouška shrnutí pro cache.",
      voice: "sarah",
    };

    const first = await route(request({ body }));
    expect(first.status).toBe(200);
    expect(first.headers.get("x-tts-cache")).toBe("miss");
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(transport.calls).toHaveLength(1);
    expect(cache.put).toHaveBeenCalledTimes(1);

    const second = await route(request({ body }));
    expect(second.status).toBe(200);
    expect(second.headers.get("x-tts-cache")).toBe("hit");
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(transport.calls).toHaveLength(1);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(mp3Bytes());
  });

  it("rejects empty text before reserving budget", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [audioResponse()],
    });
    const { service, reserve } = createService({ transport });
    const route = createRoute(() => service);

    const response = await route(
      request({ body: { text: "   ", voice: "sarah" } }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "tts_input_empty" },
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(transport.calls).toHaveLength(0);
  });

  it("maps a JSON provider error body without leaking its message or the API key", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [
        jsonErrorResponse(400, "secret provider detail about the request"),
      ],
    });
    const { service, reserve, markUnknown } = createService({ transport });
    const route = createRoute(() => service);

    const response = await route(
      request({ body: { text: "Text", voice: "sarah" } }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(502);
    expect(body).toMatchObject({ error: { code: "openrouter_error" } });
    expect(JSON.stringify(body)).not.toContain("secret provider detail");
    expect(JSON.stringify(body)).not.toContain("test-only-openrouter");
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(markUnknown).toHaveBeenCalledWith(
      RESERVATION_ID,
      expect.objectContaining({
        httpStatus: 400,
        contentType: "application/json",
        chargeReason: "provider_request_failed",
      }),
    );
  });

  it("rejects a 200 JSON response instead of treating it as MP3", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [
        new Response(JSON.stringify({ error: { message: "not audio" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ],
    });
    const { service, markUnknown } = createService({ transport });
    const route = createRoute(() => service);

    const response = await route(
      request({ body: { text: "Text", voice: "sarah" } }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "openrouter_invalid_response" },
    });
    expect(markUnknown).toHaveBeenCalledWith(
      RESERVATION_ID,
      expect.objectContaining({
        chargeReason: "invalid_provider_response",
      }),
    );
  });

  it("maps provider 401 and 429 responses without leaking secrets", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [
        jsonErrorResponse(401, "invalid key test-only-openrouter"),
        jsonErrorResponse(429, "rate limited secret"),
      ],
    });
    const { service, markUnknown } = createService({ transport });
    const route = createRoute(() => service);

    const unauthorized = await route(
      request({ body: { text: "Text", voice: "sarah" } }),
    );
    const unauthorizedBody = (await unauthorized.json()) as Record<
      string,
      unknown
    >;

    expect(unauthorized.status).toBe(502);
    expect(unauthorizedBody).toMatchObject({
      error: { code: "openrouter_auth_failed" },
    });
    expect(JSON.stringify(unauthorizedBody)).not.toContain(
      "test-only-openrouter",
    );

    const limited = await route(
      request({ body: { text: "Text", voice: "sarah" } }),
    );

    expect(limited.status).toBe(503);
    await expect(limited.json()).resolves.toMatchObject({
      error: { code: "openrouter_rate_limited" },
    });
    expect(markUnknown).toHaveBeenCalledTimes(2);
  });

  it("times out without waiting indefinitely and records unknown usage", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [() => new Promise<Response>(() => undefined)],
    });
    const { service, markUnknown } = createService({
      transport,
      timeoutMs: 20,
    });
    const route = createRoute(() => service);

    const response = await route(
      request({ body: { text: "Text", voice: "sarah" } }),
    );

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "openrouter_timeout" },
    });
    expect(markUnknown).toHaveBeenCalledWith(
      RESERVATION_ID,
      expect.objectContaining({ chargeReason: "provider_request_failed" }),
    );
  });

  it("times out while the response body is still streaming", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [stallingAudioResponse()],
    });
    const { service, markUnknown } = createService({
      transport,
      timeoutMs: 20,
    });
    const route = createRoute(() => service);

    const response = await route(
      request({ body: { text: "Text", voice: "sarah" } }),
    );

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "openrouter_timeout" },
    });
    expect(markUnknown).toHaveBeenCalledWith(
      RESERVATION_ID,
      expect.objectContaining({
        chargeReason: "provider_request_failed",
        httpStatus: 200,
        contentType: "audio/mpeg",
        generationId: "gen-stall",
      }),
    );
  });

  it("rate limits rapid billable TTS requests", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [audioResponse(), audioResponse(), audioResponse()],
    });
    const { service, reserve } = createService({ transport });
    const route = createTtsRouteHandler({
      serviceFactory: () => service,
      rateLimit: {
        ...DEFAULT_TTS_RATE_LIMIT,
        limit: 2,
        key: "tts-rate-limit-test",
        now: () => 1_000,
      },
    });

    expect(
      (await route(request({ body: { text: "Text", voice: "sarah" } })))
        .status,
    ).toBe(200);
    expect(
      (await route(request({ body: { text: "Text", voice: "sarah" } })))
        .status,
    ).toBe(200);

    const limited = await route(
      request({ body: { text: "Text", voice: "sarah" } }),
    );

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    await expect(limited.json()).resolves.toMatchObject({
      error: { code: "rate_limited" },
    });
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(transport.calls).toHaveLength(2);
  });

  it("rejects an audio response above the byte cap", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [
        new Response(new Uint8Array(64), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
      ],
    });
    const { service, markUnknown } = createService({
      transport,
      maxResponseBytes: 16,
    });
    const route = createRoute(() => service);

    const response = await route(
      request({ body: { text: "Text", voice: "sarah" } }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "openrouter_response_too_large" },
    });
    expect(markUnknown).toHaveBeenCalledWith(
      RESERVATION_ID,
      expect.objectContaining({
        chargeReason: "provider_response_read_failed",
        httpStatus: 200,
        contentType: "audio/mpeg",
        generationId: null,
      }),
    );
  });

  it("rejects an audio/mpeg response without a valid MP3 header", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
      ],
    });
    const { service } = createService({ transport });
    const route = createRoute(() => service);

    const response = await route(
      request({ body: { text: "Text", voice: "sarah" } }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "tts_invalid_audio" },
    });
  });

  it("returns an actionable error when OPENROUTER_API_KEY is missing", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [audioResponse()],
    });
    const fakeUsage = createFakeUsage();
    const route = createRoute(() => {
      const client = new OpenRouterClient({
        apiKey: "",
        usage: fakeUsage.usage,
        transport,
      });

      return createTtsService({ client });
    });

    const response = await route(
      request({ body: { text: "Text", voice: "sarah" } }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "openrouter_not_configured" },
    });
    expect(fakeUsage.reserve).not.toHaveBeenCalled();
    expect(transport.calls).toHaveLength(0);
  });

  it("blocks an unmocked outbound call before reserving budget", async () => {
    const fakeUsage = createFakeUsage();
    const route = createRoute(() => {
      const client = new OpenRouterClient({
        apiKey: "test-only-openrouter",
        usage: fakeUsage.usage,
      });

      return createTtsService({ client });
    });

    const response = await route(
      request({ body: { text: "Text", voice: "sarah" } }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unmocked_provider_call" },
    });
    expect(fakeUsage.reserve).not.toHaveBeenCalled();
  });

  it("refuses admission before any provider call when the budget is exhausted", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [audioResponse()],
    });
    const fakeUsage = createFakeUsage();
    fakeUsage.reserve.mockRejectedValue(
      new BudgetExceededError({
        budgetUsd: "2.000000",
        committedUsd: "1.990000",
        requestedUsd: "0.140000",
      }),
    );
    const { service } = createService({ transport, usage: fakeUsage });
    const route = createRoute(() => service);

    const response = await route(
      request({ body: { text: "Text", voice: "sarah" } }),
    );

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "budget_exceeded" },
    });
    expect(transport.calls).toHaveLength(0);
    expect(fakeUsage.markUnknown).not.toHaveBeenCalled();
  });

  it("rejects missing Origin, wrong Host, GET, and extra fields before the service runs", async () => {
    const service: TtsService = { synthesize: vi.fn() };
    const route = createRoute(() => service);

    const missingOrigin = await route(
      request({ body: { text: "Text", voice: "sarah" }, headers: { origin: null } }),
    );
    expect(missingOrigin.status).toBe(403);
    await expect(missingOrigin.json()).resolves.toMatchObject({
      error: { code: "invalid_origin" },
    });

    const wrongHost = await route(
      request({
        body: { text: "Text", voice: "sarah" },
        headers: { host: "example.com:3000" },
      }),
    );
    expect(wrongHost.status).toBe(403);
    await expect(wrongHost.json()).resolves.toMatchObject({
      error: { code: "invalid_host" },
    });

    const getResponse = await route(request({ method: "GET" }));
    expect(getResponse.status).toBe(405);

    const extraField = await route(
      request({
        body: { text: "Text", voice: "sarah", model: "invented/model" },
      }),
    );
    expect(extraField.status).toBe(400);
    await expect(extraField.json()).resolves.toMatchObject({
      error: { code: "invalid_shape" },
    });

    expect(service.synthesize).not.toHaveBeenCalled();
  });
});

describe("TTS provider status", () => {
  it("keeps all documented voices visible but unverified when verification is not claimed", () => {
    const status = getTtsProviderStatus({
      configured: true,
      disabledVoices: [],
      liveVerified: false,
    });

    expect(TTS_VOICES.map((voice) => voice.id)).toEqual([
      "sarah",
      "george",
      "adam",
      "alice",
      "bella",
      "bill",
      "brian",
      "callum",
      "charlie",
      "chris",
      "daniel",
      "eric",
      "harry",
      "jessica",
      "laura",
      "liam",
      "lily",
      "matilda",
      "river",
      "roger",
      "will",
    ]);
    expect(status.model).toBe(TTS_MODEL_ID);
    expect(status.responseFormat).toBe("mp3");
    expect(status.maxInputCodeUnits).toBe(TTS_MAX_INPUT_CODE_UNITS);
    expect(status.estimatedMaxCostUsd).toBe(TTS_ESTIMATED_MAX_COST_USD);
    expect(status.configured).toBe(true);
    expect(status.liveStatus).toBe("live_unverified");
    expect(status.voices).toHaveLength(TTS_VOICES.length);
    expect(
      status.voices.every(
        (voice) => voice.availability === "live_unverified",
      ),
    ).toBe(true);
  });

  it("marks a disabled voice unavailable and keeps the remaining voices visible", () => {
    const status = getTtsProviderStatus({
      configured: true,
      disabledVoices: ["george"],
      liveVerified: true,
    });

    expect(status.liveStatus).toBe("live_unverified");
    expect(status.voices).toHaveLength(TTS_VOICES.length);
    expect(
      status.voices.find((voice) => voice.id === "sarah")?.availability,
    ).toBe("available");
    expect(
      status.voices.find((voice) => voice.id === "george")?.availability,
    ).toBe("unavailable");
    expect(
      status.voices.filter(
        (voice) => voice.availability === "live_unverified",
      ),
    ).toHaveLength(TTS_VOICES.length - 2);
  });

  it("marks only the verified voices available by default", () => {
    const status = getTtsProviderStatus({ configured: true });

    expect(status.liveStatus).toBe("live_unverified");
    expect(
      status.voices
        .filter((voice) => voice.availability === "available")
        .map((voice) => voice.id),
    ).toEqual(["sarah", "george"]);
    expect(
      status.voices.filter(
        (voice) => voice.availability === "live_unverified",
      ),
    ).toHaveLength(TTS_VOICES.length - 2);
  });

  it("marks only the verified voices available after an explicit live verification", () => {
    const status = getTtsProviderStatus({
      configured: true,
      disabledVoices: [],
      liveVerified: true,
    });

    expect(status.liveStatus).toBe("live_unverified");
    expect(
      status.voices
        .filter((voice) => voice.availability === "available")
        .map((voice) => voice.id),
    ).toEqual(["sarah", "george"]);
  });

  it("does not claim a configured key when OpenRouter is not configured", () => {
    const status = getTtsProviderStatus({
      configured: false,
      disabledVoices: [],
      liveVerified: false,
    });

    expect(status.configured).toBe(false);
  });
});
