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
import type { AppConfig } from "../../src/lib/config";
import {
  DEFAULT_SCRIBE_TOKEN_RATE_LIMIT,
  SCRIBE_REALTIME_MODEL_ID,
  SCRIBE_REALTIME_USD_PER_HOUR,
  SCRIBE_SESSION_MAX_SECONDS,
  SCRIBE_TOKEN_ESTIMATED_MAX_COST_USD,
  SCRIBE_TOKEN_OPERATION,
  SCRIBE_TOKEN_TTL_SECONDS,
  createScribeTokenRouteHandler,
  createScribeTokenService,
  type ElevenLabsTransport,
  type ScribeTokenService,
} from "../../src/lib/elevenlabs/client";
import {
  createMockElevenLabsTransport,
  resetProviderMocks,
} from "../helpers/provider-mocks";

const APP_ORIGIN = "http://127.0.0.1:3000";
const REQUEST_URL = `${APP_ORIGIN}/api/elevenlabs/scribe-token`;
const RESERVATION_ID = "11111111-1111-4111-8111-111111111111";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    appOrigin: APP_ORIGIN,
    appHost: "127.0.0.1",
    appPort: 3000,
    databaseUrl: null,
    testDatabaseUrl: null,
    aiTestMode: false,
    allowForwardedLoopback: false,
    elevenLabsApiKey: "test-only-elevenlabs",
    elevenLabsApiBaseUrl: "https://api.elevenlabs.io",
    openRouterApiKey: null,
    openRouterLlmModel: "deepseek/deepseek-v4.1-flash-1017",
    openRouterEmbeddingModel: "openai/text-embedding-3-small",
    openAiApiKey: null,
    geminiApiKey: null,
    noteMaxCharacters: 20_000,
    meetingMaxMinutes: 15,
    aiRequestBudgetUsd: 2,
    ...overrides,
  };
}

function reservation(): UsageOperationDto {
  return {
    id: RESERVATION_ID,
    operation: SCRIBE_TOKEN_OPERATION,
    provider: "elevenlabs",
    model: SCRIBE_REALTIME_MODEL_ID,
    status: "started",
    reservedCostUsd: "0.019500",
    reportedCostUsd: null,
    providerUsage: null,
    startedAt: new Date("2026-10-26T10:00:00Z"),
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
    settledAt: new Date("2026-10-26T10:00:01Z"),
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

function createService(options: {
  config?: Partial<AppConfig>;
  transport?: ElevenLabsTransport;
  now?: () => number;
  usage?: ReturnType<typeof createFakeUsage>;
} = {}) {
  const fakeUsage = options.usage ?? createFakeUsage();
  const service = createScribeTokenService({
    config: testConfig(options.config),
    usage: fakeUsage.usage,
    transport: options.transport,
    now: options.now,
  });

  return { service, ...fakeUsage };
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
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function createRoute(service: ScribeTokenService) {
  return createScribeTokenRouteHandler({
    serviceFactory: () => service,
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

describe("POST /api/elevenlabs/scribe-token", () => {
  it("mints one realtime_scribe token per explicit POST without reusing it", async () => {
    const transport = createMockElevenLabsTransport({
      tokens: ["sutkn_first_token", "sutkn_second_token"],
    });
    const { service, reserve, markUnknown } = createService({
      transport,
      now: () => Date.parse("2026-10-26T12:00:00Z"),
    });
    const route = createRoute(service);

    const firstResponse = await route(request({ body: {} }));
    expect(firstResponse.status).toBe(200);
    const firstBody = (await firstResponse.json()) as Record<string, unknown>;
    expect(firstBody).toEqual({
      token: "sutkn_first_token",
      expiresInSeconds: SCRIBE_TOKEN_TTL_SECONDS,
      expiresAt: "2026-10-26T12:15:00.000Z",
      modelId: SCRIBE_REALTIME_MODEL_ID,
      maxSessionSeconds: SCRIBE_SESSION_MAX_SECONDS,
    });
    expect(JSON.stringify(firstBody)).not.toContain("test-only-elevenlabs");

    const secondResponse = await route(request({ body: {} }));
    expect(secondResponse.status).toBe(200);
    const secondBody = (await secondResponse.json()) as Record<string, unknown>;
    expect(secondBody.token).toBe("sutkn_second_token");

    expect(transport.calls).toEqual([
      {
        apiKey: "test-only-elevenlabs",
        tokenType: "realtime_scribe",
        baseUrl: "https://api.elevenlabs.io",
      },
      {
        apiKey: "test-only-elevenlabs",
        tokenType: "realtime_scribe",
        baseUrl: "https://api.elevenlabs.io",
      },
    ]);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenNthCalledWith(1, {
      operation: SCRIBE_TOKEN_OPERATION,
      provider: "elevenlabs",
      model: SCRIBE_REALTIME_MODEL_ID,
      estimatedMaxCostUsd: SCRIBE_TOKEN_ESTIMATED_MAX_COST_USD,
    });
    expect(SCRIBE_TOKEN_ESTIMATED_MAX_COST_USD).toBe(0.0195);
    expect(SCRIBE_TOKEN_ESTIMATED_MAX_COST_USD + 1e-9).toBeGreaterThanOrEqual(
      SCRIBE_REALTIME_USD_PER_HOUR * (SCRIBE_SESSION_MAX_SECONDS / 3600),
    );
    expect(markUnknown).toHaveBeenCalledTimes(2);
    expect(markUnknown).toHaveBeenNthCalledWith(1, RESERVATION_ID, {
      tokenType: "realtime_scribe",
      tokenExpiresInSeconds: SCRIBE_TOKEN_TTL_SECONDS,
      sessionMaxSeconds: SCRIBE_SESSION_MAX_SECONDS,
      chargeReason: "realtime_session_usage_unknown",
    });
    expect(JSON.stringify(markUnknown.mock.calls)).not.toContain("sutkn_");
  });

  it("advertises expiry from before the provider call so it never overstates validity", async () => {
    const events: string[] = [];
    const transport: ElevenLabsTransport = {
      async createToken() {
        events.push("provider");
        return { token: "sutkn_ordering_token" };
      },
    };
    const { service } = createService({
      transport,
      now: () => {
        events.push("now");
        return Date.parse("2026-10-26T12:00:00Z");
      },
    });

    const result = await service.mintToken();

    expect(events).toEqual(["now", "provider"]);
    expect(result.expiresAt).toBe("2026-10-26T12:15:00.000Z");
  });

  it("rejects missing Origin, wrong Host and non-POST methods before the service runs", async () => {
    const service: ScribeTokenService = { mintToken: vi.fn() };
    const route = createRoute(service);

    const missingOrigin = await route(
      request({ body: {}, headers: { origin: null } }),
    );
    expect(missingOrigin.status).toBe(403);
    await expect(missingOrigin.json()).resolves.toMatchObject({
      error: { code: "invalid_origin" },
    });

    const wrongHost = await route(
      request({ body: {}, headers: { host: "example.com:3000" } }),
    );
    expect(wrongHost.status).toBe(403);
    await expect(wrongHost.json()).resolves.toMatchObject({
      error: { code: "invalid_host" },
    });

    const getResponse = await route(request({ method: "GET" }));
    expect(getResponse.status).toBe(405);

    expect(service.mintToken).not.toHaveBeenCalled();
  });

  it("rejects an invalid JSON shape without calling the service", async () => {
    const service: ScribeTokenService = { mintToken: vi.fn() };
    const route = createRoute(service);

    const response = await route(request({ body: { unexpected: true } }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_shape" },
    });
    expect(service.mintToken).not.toHaveBeenCalled();
  });

  it("returns an actionable Czech error when ELEVENLABS_API_KEY is missing", async () => {
    const transport = createMockElevenLabsTransport({
      tokens: ["sutkn_unused_token"],
    });
    const { service, reserve } = createService({
      config: { elevenLabsApiKey: null },
      transport,
    });

    const response = await createRoute(service)(request({ body: {} }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "elevenlabs_not_configured" },
    });
    expect(transport.calls).toHaveLength(0);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("blocks an unmocked outbound provider call before reserving budget", async () => {
    const { service, reserve } = createService();

    const response = await createRoute(service)(request({ body: {} }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unmocked_provider_call" },
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("rate limits rapid token requests", async () => {
    const transport = createMockElevenLabsTransport({
      tokens: ["sutkn_first_token", "sutkn_second_token"],
    });
    const { service, reserve } = createService({ transport });
    const route = createScribeTokenRouteHandler({
      serviceFactory: () => service,
      rateLimit: {
        ...DEFAULT_SCRIBE_TOKEN_RATE_LIMIT,
        limit: 2,
        key: "scribe-token-rate-limit-test",
        now: () => 1_000,
      },
    });

    expect((await route(request({ body: {} }))).status).toBe(200);
    expect((await route(request({ body: {} }))).status).toBe(200);
    const limited = await route(request({ body: {} }));

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    await expect(limited.json()).resolves.toMatchObject({
      error: { code: "rate_limited" },
    });
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  it("marks a failed provider request unknown and returns no token", async () => {
    const providerError = Object.assign(new Error("provider exploded"), {
      statusCode: 500,
    });
    const transport = createMockElevenLabsTransport({ error: providerError });
    const { service, reserve, markUnknown } = createService({ transport });

    const response = await createRoute(service)(request({ body: {} }));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(502);
    expect(body).toMatchObject({ error: { code: "elevenlabs_error" } });
    expect(body).not.toHaveProperty("token");
    expect(JSON.stringify(body)).not.toContain("provider exploded");
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(markUnknown).toHaveBeenCalledWith(RESERVATION_ID, {
      tokenType: "realtime_scribe",
      chargeReason: "provider_request_failed",
    });
  });

  it("maps provider authentication failures without leaking the API key", async () => {
    const providerError = Object.assign(new Error("unauthorized"), {
      statusCode: 401,
    });
    const transport = createMockElevenLabsTransport({ error: providerError });
    const { service, markUnknown } = createService({ transport });

    const response = await createRoute(service)(request({ body: {} }));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({ error: { code: "elevenlabs_auth_failed" } });
    expect(JSON.stringify(body)).not.toContain("test-only-elevenlabs");
    expect(markUnknown).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed provider token as unknown usage", async () => {
    const transport = createMockElevenLabsTransport({
      tokens: ["   "],
    });
    const { service, markUnknown } = createService({ transport });

    const response = await createRoute(service)(request({ body: {} }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_provider_response" },
    });
    expect(markUnknown).toHaveBeenCalledTimes(1);
  });

  it("returns an actionable database error when budget admission cannot reach the DB", async () => {
    const transport = createMockElevenLabsTransport({
      tokens: ["sutkn_unused_token"],
    });
    const fakeUsage = createFakeUsage();
    fakeUsage.reserve.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const { service } = createService({ transport, usage: fakeUsage });

    const response = await createRoute(service)(request({ body: {} }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "database_unavailable" },
    });
    expect(transport.calls).toHaveLength(0);
  });

  it("refuses admission before any provider call when the budget is exhausted", async () => {
    const transport = createMockElevenLabsTransport({
      tokens: ["sutkn_unused_token"],
    });
    const fakeUsage = createFakeUsage();
    fakeUsage.reserve.mockRejectedValue(
      new BudgetExceededError({
        budgetUsd: "2.000000",
        committedUsd: "1.990000",
        requestedUsd: "0.019500",
      }),
    );
    const { service } = createService({
      transport,
      usage: fakeUsage,
    });

    const response = await createRoute(service)(request({ body: {} }));

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "budget_exceeded" },
    });
    expect(transport.calls).toHaveLength(0);
    expect(fakeUsage.markUnknown).not.toHaveBeenCalled();
  });
});
