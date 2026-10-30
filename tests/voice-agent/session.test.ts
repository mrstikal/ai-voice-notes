// @vitest-environment jsdom

import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { AppConfig } from "../../src/lib/config";
import {
  OPENAI_REALTIME_CALLS_URL,
  OPENAI_REALTIME_DEFAULT_VOICE,
  OPENAI_REALTIME_MODEL_ID,
  OPENAI_REALTIME_SESSION_MAX_SECONDS,
  RealtimeProviderError,
  VOICE_AGENT_SDP_MAX_CHARACTERS,
  VOICE_AGENT_SESSION_REQUEST_MAX_BYTES,
  createFetchRealtimeTransport,
  createVoiceAgentEndRouteHandler,
  createVoiceAgentService,
  createVoiceAgentSessionRouteHandler,
  createVoiceAgentSessionStore,
  resetVoiceAgentSessionStoreForTests,
  setRealtimeTransportForTests,
  type RealtimeTransport,
} from "../../src/lib/voice-agent/openai-session";
import {
  VoiceAgentSession,
  VOICE_AGENT_DATA_CHANNEL,
} from "../../src/components/voice-agent/VoiceAgentSession";
import {
  FakeRTCPeerConnection,
  installFakeWebRtc,
  type FakeWebRtcHarness,
} from "../helpers/webrtc-double";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const APP_ORIGIN = "http://127.0.0.1:3000";
const REQUEST_URL = `${APP_ORIGIN}/api/voice-agent/session`;
const END_URL = `${APP_ORIGIN}/api/voice-agent/end`;
const API_KEY = "sk-test-voice-agent-secret";
const NOW = Date.parse("2026-10-30T12:00:00Z");
const SDP_OFFER =
  "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n";
const SDP_ANSWER =
  "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendonly\r\n";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    appOrigin: APP_ORIGIN,
    appHost: "127.0.0.1",
    appPort: 3000,
    databaseUrl: null,
    testDatabaseUrl: null,
    aiTestMode: false,
    allowForwardedLoopback: false,
    elevenLabsApiKey: null,
    elevenLabsApiBaseUrl: "https://api.elevenlabs.io",
    openRouterApiKey: null,
    openRouterLlmModel: "deepseek/deepseek-v4.1-flash-1017",
    openRouterEmbeddingModel: "openai/text-embedding-3-small",
    openAiApiKey: API_KEY,
    openAiRealtimeModel: OPENAI_REALTIME_MODEL_ID,
    geminiApiKey: null,
    noteMaxCharacters: 20_000,
    meetingMaxMinutes: 15,
    aiRequestBudgetUsd: 2,
    ...overrides,
  };
}

interface MockTransport extends RealtimeTransport {
  readonly calls: Array<Parameters<RealtimeTransport["exchangeSdp"]>[0]>;
}

function createMockTransport(
  handler?: (
    request: Parameters<RealtimeTransport["exchangeSdp"]>[0],
  ) => Promise<{ sdp: string }>,
): MockTransport {
  const calls: MockTransport["calls"] = [];

  return {
    calls,
    async exchangeSdp(request) {
      calls.push(request);

      if (handler) {
        return handler(request);
      }

      return { sdp: SDP_ANSWER };
    },
  };
}

function createHarness(
  options: {
    config?: Partial<AppConfig>;
    transport?: MockTransport;
    maxActiveSessions?: number;
    sessionMaxSeconds?: number;
  } = {},
) {
  const clock = { value: NOW };
  const store = createVoiceAgentSessionStore({
    now: () => clock.value,
    maxActiveSessions: options.maxActiveSessions,
    sessionMaxSeconds: options.sessionMaxSeconds,
  });
  const transport = options.transport ?? createMockTransport();
  const service = createVoiceAgentService({
    config: testConfig(options.config),
    store,
    transport,
  });
  const sessionRoute = createVoiceAgentSessionRouteHandler({
    serviceFactory: () => service,
    rateLimit: { limit: 100, windowMs: 60_000, key: "test-session" },
  });
  const endRoute = createVoiceAgentEndRouteHandler({
    serviceFactory: () => service,
    rateLimit: { limit: 100, windowMs: 60_000, key: "test-end" },
  });

  return { clock, store, transport, service, sessionRoute, endRoute };
}

function request(
  options: {
    url?: string;
    method?: string;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string | null>;
  } = {},
): Request {
  const headers = new Headers({
    host: "127.0.0.1:3000",
    origin: APP_ORIGIN,
    ...(options.body === undefined && options.rawBody === undefined
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

  return new Request(options.url ?? REQUEST_URL, {
    method: options.method ?? "POST",
    headers,
    body:
      options.rawBody ??
      (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  resetVoiceAgentSessionStoreForTests();
  setRealtimeTransportForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/voice-agent/session", () => {
  it("exchanges one SDP offer with the documented model, voice and no note access", async () => {
    const harness = createHarness();
    const rawOffer = `\r\n${SDP_OFFER}\r\n`;
    const response = await harness.sessionRoute(
      request({ body: { sdp: rawOffer } }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, string | number>;

    expect(body).toMatchObject({
      answerSdp: SDP_ANSWER,
      model: OPENAI_REALTIME_MODEL_ID,
      voice: OPENAI_REALTIME_DEFAULT_VOICE,
      maxSessionSeconds: OPENAI_REALTIME_SESSION_MAX_SECONDS,
      expiresAt: new Date(
        NOW + OPENAI_REALTIME_SESSION_MAX_SECONDS * 1000,
      ).toISOString(),
    });
    expect(typeof body.sessionId).toBe("string");
    expect(String(body.sessionId)).toHaveLength(43);

    expect(harness.transport.calls).toHaveLength(1);
    expect(harness.transport.calls[0]).toMatchObject({
      apiKey: API_KEY,
      model: OPENAI_REALTIME_MODEL_ID,
      voice: OPENAI_REALTIME_DEFAULT_VOICE,
      sdp: rawOffer,
    });
    expect(harness.transport.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(body)).not.toContain(API_KEY);
    expect(JSON.stringify(body)).not.toContain("tajná poznámka");
    expect(harness.store.has(String(body.sessionId))).toBe(true);
  });

  it("forwards the exact multipart contract and SDP bytes to the provider", async () => {
    const rawOffer = `\r\n${SDP_OFFER}\r\n`;
    const seen: Array<{
      url: string;
      authorization: string | null;
      sdp: unknown;
      session: unknown;
    }> = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const form = init?.body as FormData;
        seen.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
          sdp: form.get("sdp"),
          session: JSON.parse(String(form.get("session"))) as unknown,
        });

        return new Response(SDP_ANSWER, {
          status: 201,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      },
    );
    const transport = createFetchRealtimeTransport({
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await transport.exchangeSdp({
      apiKey: API_KEY,
      model: OPENAI_REALTIME_MODEL_ID,
      voice: OPENAI_REALTIME_DEFAULT_VOICE,
      sdp: rawOffer,
      signal: new AbortController().signal,
    });

    expect(result.sdp).toBe(SDP_ANSWER);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      url: OPENAI_REALTIME_CALLS_URL,
      authorization: `Bearer ${API_KEY}`,
      sdp: rawOffer,
      session: {
        type: "realtime",
        model: OPENAI_REALTIME_MODEL_ID,
        audio: { output: { voice: OPENAI_REALTIME_DEFAULT_VOICE } },
      },
    });
    expect(JSON.stringify(seen)).not.toContain("tajná poznámka");
  });

  it("blocks a missing OpenAI key without creating a session or provider call", async () => {
    const harness = createHarness({ config: { openAiApiKey: null } });
    const response = await harness.sessionRoute(
      request({ body: { sdp: SDP_OFFER } }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "openai_not_configured",
        message: expect.stringContaining("OPENAI_API_KEY") as string,
      },
    });
    expect(harness.transport.calls).toHaveLength(0);
  });

  it("blocks a changed realtime model instead of silently switching", async () => {
    const harness = createHarness({
      config: { openAiRealtimeModel: "gpt-realtime-2.1" },
    });
    const response = await harness.sessionRoute(
      request({ body: { sdp: SDP_OFFER } }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "openai_realtime_model_blocked" },
    });
    expect(harness.transport.calls).toHaveLength(0);
  });

  it("rejects Host, Origin, content type, shape, note content and SDP bounds", async () => {
    const harness = createHarness();
    const route = harness.sessionRoute;

    const wrongHost = await route(
      request({ body: { sdp: SDP_OFFER }, headers: { host: "example.com" } }),
    );
    expect(wrongHost.status).toBe(403);

    const missingOrigin = await route(
      request({ body: { sdp: SDP_OFFER }, headers: { origin: null } }),
    );
    expect(missingOrigin.status).toBe(403);

    const wrongContentType = await route(
      request({
        rawBody: JSON.stringify({ sdp: SDP_OFFER }),
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(wrongContentType.status).toBe(415);

    const notePayload = await route(
      request({
        body: { sdp: SDP_OFFER, noteContent: "tajná poznámka" },
      }),
    );
    expect(notePayload.status).toBe(400);

    const notSdp = await route(request({ body: { sdp: "not-sdp" } }));
    expect(notSdp.status).toBe(400);
    await expect(notSdp.json()).resolves.toMatchObject({
      error: { code: "invalid_sdp_offer" },
    });

    const oversizedSdp = await route(
      request({
        body: {
          sdp: `v=0\r\n${"a".repeat(VOICE_AGENT_SDP_MAX_CHARACTERS)}\r\nm=audio 9 x\r\n`,
        },
      }),
    );
    expect(oversizedSdp.status).toBe(400);

    const oversizedBody = await route(
      request({ rawBody: "x".repeat(VOICE_AGENT_SESSION_REQUEST_MAX_BYTES + 1) }),
    );
    expect(oversizedBody.status).toBe(413);

    expect(harness.transport.calls).toHaveLength(0);
  });

  it("maps provider model and rate-limit rejections without keeping capacity", async () => {
    for (const [providerStatus, providerCode, code, localStatus] of [
      [404, "model_not_found", "openai_model_unavailable", 503],
      [400, "invalid_offer", "openai_request_rejected", 502],
      [429, null, "openai_rate_limited", 503],
      [401, null, "openai_auth_failed", 502],
    ] as const) {
      const transport = createMockTransport(async () => {
        throw new RealtimeProviderError(providerStatus, undefined, providerCode);
      });
      const harness = createHarness({ transport });
      const rejected = await harness.sessionRoute(
        request({ body: { sdp: SDP_OFFER } }),
      );

      expect(rejected.status).toBe(localStatus);
      const rejectedBody = await rejected.text();
      expect(JSON.parse(rejectedBody)).toMatchObject({
        error: { code },
      });
      expect(rejectedBody).not.toContain(API_KEY);

      const recovering = createHarness({
        transport: createMockTransport(),
      });
      expect(
        (
          await recovering.sessionRoute(request({ body: { sdp: SDP_OFFER } }))
        ).status,
      ).toBe(200);
    }
  });

  it("times out a slow provider, rejects a malformed answer and releases capacity", async () => {
    const slowTransport: RealtimeTransport = {
      exchangeSdp: () => new Promise(() => undefined),
    };
    const slowStore = createVoiceAgentSessionStore({ now: () => NOW });
    const slowService = createVoiceAgentService({
      config: testConfig(),
      store: slowStore,
      transport: slowTransport,
      timeoutMs: 20,
    });
    const slowRoute = createVoiceAgentSessionRouteHandler({
      serviceFactory: () => slowService,
      rateLimit: { limit: 10, windowMs: 60_000, key: "timeout" },
    });

    const timedOut = await slowRoute(request({ body: { sdp: SDP_OFFER } }));
    expect(timedOut.status).toBe(504);
    await expect(timedOut.json()).resolves.toMatchObject({
      error: { code: "openai_timeout" },
    });

    let answerAttempts = 0;
    const malformed = createHarness({
      transport: createMockTransport(async () => {
        answerAttempts += 1;
        return {
          sdp: answerAttempts === 1 ? "<html>nope</html>" : SDP_ANSWER,
        };
      }),
    });
    const invalid = await malformed.sessionRoute(
      request({ body: { sdp: SDP_OFFER } }),
    );
    expect(invalid.status).toBe(502);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: "openai_invalid_response" },
    });

    const noActive = await malformed.sessionRoute(
      request({ body: { sdp: SDP_OFFER } }),
    );
    expect(noActive.status).toBe(200);
  });

  it("allows only one active session and rate limits rapid attempts", async () => {
    const harness = createHarness({ maxActiveSessions: 1 });
    const first = await harness.sessionRoute(
      request({ body: { sdp: SDP_OFFER } }),
    );
    expect(first.status).toBe(200);

    const second = await harness.sessionRoute(
      request({ body: { sdp: SDP_OFFER } }),
    );
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({
      error: { code: "session_limit_reached" },
    });
    expect(harness.transport.calls).toHaveLength(1);

    const sessionId = ((await first.json()) as { sessionId: string }).sessionId;
    expect(
      (
        await harness.endRoute(
          request({ url: END_URL, body: { sessionId } }),
        )
      ).status,
    ).toBe(200);

    const third = await harness.sessionRoute(
      request({ body: { sdp: SDP_OFFER } }),
    );
    expect(third.status).toBe(200);

    const limitedTransport = createMockTransport();
    const limitedStore = createVoiceAgentSessionStore({
      now: () => NOW,
      maxActiveSessions: 10,
    });
    const limitedService = createVoiceAgentService({
      config: testConfig(),
      store: limitedStore,
      transport: limitedTransport,
    });
    const limitedRoute = createVoiceAgentSessionRouteHandler({
      serviceFactory: () => limitedService,
      rateLimit: {
        limit: 2,
        windowMs: 60_000,
        key: "voice-agent-rate-limit-test",
        now: () => 1_000,
      },
    });

    expect(
      (await limitedRoute(request({ body: { sdp: SDP_OFFER } }))).status,
    ).toBe(200);
    expect(
      (await limitedRoute(request({ body: { sdp: SDP_OFFER } }))).status,
    ).toBe(200);
    const limited = await limitedRoute(request({ body: { sdp: SDP_OFFER } }));

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limitedTransport.calls).toHaveLength(2);
  });

  it("shares one process-wide store between the real session and end handlers", async () => {
    vi.stubEnv("APP_ORIGIN", APP_ORIGIN);
    vi.stubEnv("OPENAI_API_KEY", "test-only-openai");
    vi.stubEnv("OPENAI_REALTIME_MODEL", OPENAI_REALTIME_MODEL_ID);
    const transport = createMockTransport();
    setRealtimeTransportForTests(transport);

    const sessionRoute = createVoiceAgentSessionRouteHandler({
      rateLimit: { limit: 10, windowMs: 60_000, key: "shared-session" },
    });
    const endRoute = createVoiceAgentEndRouteHandler({
      rateLimit: { limit: 10, windowMs: 60_000, key: "shared-end" },
    });

    const created = await sessionRoute(request({ body: { sdp: SDP_OFFER } }));
    expect(created.status).toBe(200);
    const { sessionId } = (await created.json()) as { sessionId: string };

    const ended = await endRoute(
      request({ url: END_URL, body: { sessionId } }),
    );
    expect(ended.status).toBe(200);

    const again = await endRoute(
      request({ url: END_URL, body: { sessionId } }),
    );
    expect(again.status).toBe(404);
    expect(transport.calls).toHaveLength(1);
  });

  it("blocks unmocked provider egress in test mode", async () => {
    const store = createVoiceAgentSessionStore({ now: () => NOW });
    const service = createVoiceAgentService({
      config: testConfig(),
      store,
    });
    const route = createVoiceAgentSessionRouteHandler({
      serviceFactory: () => service,
      rateLimit: { limit: 10, windowMs: 60_000, key: "unmocked" },
    });

    const response = await route(request({ body: { sdp: SDP_OFFER } }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unmocked_provider_call" },
    });
  });
});

describe("POST /api/voice-agent/end", () => {
  it("invalidates the opaque session id exactly once", async () => {
    const harness = createHarness();
    const created = await harness.sessionRoute(
      request({ body: { sdp: SDP_OFFER } }),
    );
    const { sessionId } = (await created.json()) as { sessionId: string };

    const first = await harness.endRoute(
      request({ url: END_URL, body: { sessionId } }),
    );
    expect(first.status).toBe(200);
    const firstBody = await first.text();
    expect(JSON.parse(firstBody)).toEqual({ ended: true });
    expect(firstBody).not.toContain(API_KEY);
    expect(harness.store.has(sessionId)).toBe(false);

    const second = await harness.endRoute(
      request({ url: END_URL, body: { sessionId } }),
    );
    expect(second.status).toBe(404);
    await expect(second.json()).resolves.toMatchObject({
      error: { code: "session_not_found" },
    });

    expect(harness.transport.calls).toHaveLength(1);
  });

  it("removes an expired session via TTL and keeps the end route guarded", async () => {
    const harness = createHarness();
    const created = await harness.sessionRoute(
      request({ body: { sdp: SDP_OFFER } }),
    );
    const { sessionId } = (await created.json()) as { sessionId: string };

    harness.clock.value =
      NOW + OPENAI_REALTIME_SESSION_MAX_SECONDS * 1000 + 1;

    expect(harness.store.has(sessionId)).toBe(false);
    const expired = await harness.endRoute(
      request({ url: END_URL, body: { sessionId } }),
    );
    expect(expired.status).toBe(404);

    expect(
      (
        await harness.endRoute(
          request({
            url: END_URL,
            body: { sessionId },
            headers: { origin: "https://example.com" },
          }),
        )
      ).status,
    ).toBe(403);

    const next = await harness.sessionRoute(
      request({ body: { sdp: SDP_OFFER } }),
    );
    expect(next.status).toBe(200);
  });
});

describe("VoiceAgentSession browser behaviour", () => {
  let webrtc: FakeWebRtcHarness;
  let fetchMock: ReturnType<typeof vi.fn>;
  let endBodies: Array<{ sessionId: string }>;

  beforeEach(() => {
    webrtc = installFakeWebRtc();
    endBodies = [];
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/api/voice-agent/session")) {
        return jsonResponse(200, {
          sessionId: "s".repeat(43),
          answerSdp: SDP_ANSWER,
          model: OPENAI_REALTIME_MODEL_ID,
          voice: OPENAI_REALTIME_DEFAULT_VOICE,
          maxSessionSeconds: OPENAI_REALTIME_SESSION_MAX_SECONDS,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
      }

      if (url.endsWith("/api/voice-agent/end")) {
        endBodies.push(JSON.parse(String(init?.body ?? "{}")) as {
          sessionId: string;
        });
        return jsonResponse(200, { ended: true });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    });
  });

  afterEach(() => {
    webrtc.restore();
  });

  it("connects receive-only without microphone, exposes the oai-events channel and ends once", async () => {
    render(createElement(VoiceAgentSession));

    fireEvent.click(screen.getByRole("button", { name: "Připojit" }));
    expect(screen.getByText("Připojuji")).toBeTruthy();

    await waitFor(() => expect(webrtc.instances).toHaveLength(1));
    const peer = webrtc.instances[0] as FakeRTCPeerConnection;
    const channel = peer.getChannel(VOICE_AGENT_DATA_CHANNEL);

    expect(channel).not.toBeNull();
    expect(peer.remoteDescription?.type).toBe("answer");
    expect(channel?.sent).toEqual([]);
    expect(
      vi.mocked(navigator.mediaDevices.getUserMedia),
    ).not.toHaveBeenCalled();

    await act(async () => {
      peer.setConnectionState("connected");
    });

    expect(screen.getByText("Připojeno")).toBeTruthy();
    expect(screen.getByText(/Relace se automaticky ukončí/)).toBeTruthy();

    const sessionCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/api/voice-agent/session"),
    ) as [string, RequestInit];
    const sessionBody = JSON.parse(String(sessionCall[1].body)) as {
      sdp: string;
    };
    expect(sessionBody).toEqual({ sdp: SDP_OFFER });
    expect(JSON.stringify(sessionBody)).not.toContain(API_KEY);
    expect(sessionCall[1].headers).toEqual({
      "content-type": "application/json",
    });

    fireEvent.click(screen.getByRole("button", { name: "Ukončit" }));
    fireEvent.click(screen.getByRole("button", { name: "Ukončit" }));

    await waitFor(() => expect(endBodies).toHaveLength(1));
    expect(endBodies[0]).toEqual({ sessionId: "s".repeat(43) });
    expect(peer.closed).toBe(true);

    await waitFor(() => expect(screen.getByText("Odpojeno")).toBeTruthy());
  });

  it("shows the Czech server error and keeps the button usable", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/voice-agent/session")) {
        return jsonResponse(503, {
          error: {
            code: "openai_not_configured",
            message: "Konverzační asistent není nakonfigurovaný.",
          },
        });
      }

      throw new Error("Unexpected request");
    });

    render(createElement(VoiceAgentSession));
    fireEvent.click(screen.getByRole("button", { name: "Připojit" }));

    await waitFor(() => expect(screen.getByText("Chyba")).toBeTruthy());
    expect(
      screen.getByText("Konverzační asistent není nakonfigurovaný."),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Připojit" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(endBodies).toHaveLength(0);
  });

  it("surfaces a failed server-side end as Chyba instead of silent Odpojeno", async () => {
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url.endsWith("/api/voice-agent/session")) {
          return jsonResponse(200, {
            sessionId: "s".repeat(43),
            answerSdp: SDP_ANSWER,
            model: OPENAI_REALTIME_MODEL_ID,
            voice: OPENAI_REALTIME_DEFAULT_VOICE,
            maxSessionSeconds: OPENAI_REALTIME_SESSION_MAX_SECONDS,
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          });
        }

        if (url.endsWith("/api/voice-agent/end")) {
          endBodies.push(JSON.parse(String(init?.body ?? "{}")) as {
            sessionId: string;
          });
          return jsonResponse(500, {
            error: { code: "internal_error", message: "Server selhal." },
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      },
    );

    render(createElement(VoiceAgentSession));
    fireEvent.click(screen.getByRole("button", { name: "Připojit" }));

    await waitFor(() => expect(webrtc.instances).toHaveLength(1));
    const peer = webrtc.instances[0] as FakeRTCPeerConnection;

    await act(async () => {
      peer.setConnectionState("connected");
    });
    await waitFor(() => expect(screen.getByText("Připojeno")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Ukončit" }));

    await waitFor(() => expect(screen.getByText("Chyba")).toBeTruthy());
    expect(
      screen.getByText(/Relaci se nepodařilo ukončit na serveru/),
    ).toBeTruthy();
    expect(endBodies).toHaveLength(1);
  });

  it("reports Chyba when a cancelled in-flight start later fails to end", async () => {
    let resolveSession: ((response: Response) => void) | null = null;
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url.endsWith("/api/voice-agent/session")) {
          return new Promise<Response>((resolve) => {
            resolveSession = resolve;
          });
        }

        if (url.endsWith("/api/voice-agent/end")) {
          endBodies.push(JSON.parse(String(init?.body ?? "{}")) as {
            sessionId: string;
          });
          return jsonResponse(500, {
            error: { code: "internal_error", message: "Server selhal." },
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      },
    );

    render(createElement(VoiceAgentSession));
    fireEvent.click(screen.getByRole("button", { name: "Připojit" }));
    await waitFor(() => expect(webrtc.instances).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Ukončit" }));
    await waitFor(() => expect(screen.getByText("Odpojeno")).toBeTruthy());

    await act(async () => {
      resolveSession?.(
        jsonResponse(200, {
          sessionId: "s".repeat(43),
          answerSdp: SDP_ANSWER,
          model: OPENAI_REALTIME_MODEL_ID,
          voice: OPENAI_REALTIME_DEFAULT_VOICE,
          maxSessionSeconds: OPENAI_REALTIME_SESSION_MAX_SECONDS,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }),
      );
    });

    await waitFor(() => expect(screen.getByText("Chyba")).toBeTruthy());
    expect(
      screen.getByText(/Relaci se nepodařilo ukončit na serveru/),
    ).toBeTruthy();
    expect(endBodies).toHaveLength(1);
  });

  it("ignores a late failed end after a newer connect has succeeded", async () => {
    let resolveFirstEnd: ((response: Response) => void) | null = null;
    let endCallCount = 0;
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url.endsWith("/api/voice-agent/session")) {
          return jsonResponse(200, {
            sessionId: "s".repeat(43),
            answerSdp: SDP_ANSWER,
            model: OPENAI_REALTIME_MODEL_ID,
            voice: OPENAI_REALTIME_DEFAULT_VOICE,
            maxSessionSeconds: OPENAI_REALTIME_SESSION_MAX_SECONDS,
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          });
        }

        if (url.endsWith("/api/voice-agent/end")) {
          endCallCount += 1;
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            sessionId: string;
          };
          endBodies.push(body);

          if (endCallCount === 1) {
            return new Promise<Response>((resolve) => {
              resolveFirstEnd = resolve;
            });
          }

          return jsonResponse(200, { ended: true });
        }

        throw new Error(`Unexpected request: ${url}`);
      },
    );

    render(createElement(VoiceAgentSession));
    fireEvent.click(screen.getByRole("button", { name: "Připojit" }));
    await waitFor(() => expect(webrtc.instances).toHaveLength(1));

    const firstPeer = webrtc.instances[0] as FakeRTCPeerConnection;
    await act(async () => {
      firstPeer.setConnectionState("connected");
    });
    await waitFor(() => expect(screen.getByText("Připojeno")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Ukončit" }));
    await waitFor(() => expect(screen.getByText("Odpojeno")).toBeTruthy());
    expect(resolveFirstEnd).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Připojit" }));
    await waitFor(() => expect(webrtc.instances).toHaveLength(2));

    const secondPeer = webrtc.instances[1] as FakeRTCPeerConnection;
    await act(async () => {
      secondPeer.setConnectionState("connected");
    });
    await waitFor(() => expect(screen.getByText("Připojeno")).toBeTruthy());

    await act(async () => {
      resolveFirstEnd?.(
        jsonResponse(500, {
          error: { code: "internal_error", message: "Server selhal." },
        }),
      );
    });

    await waitFor(() => expect(endBodies).toHaveLength(1));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Připojeno")).toBeTruthy();
    expect(
      screen.queryByText(/Relaci se nepodařilo ukončit na serveru/),
    ).toBeNull();
  });

  it("ends the session on unmount", async () => {
    const view = render(createElement(VoiceAgentSession));
    fireEvent.click(screen.getByRole("button", { name: "Připojit" }));

    await waitFor(() => expect(webrtc.instances).toHaveLength(1));
    const peer = webrtc.instances[0] as FakeRTCPeerConnection;

    await act(async () => {
      peer.setConnectionState("connected");
    });
    await waitFor(() => expect(screen.getByText("Připojeno")).toBeTruthy());

    view.unmount();

    await waitFor(() => expect(endBodies).toHaveLength(1));
    expect(endBodies[0]).toEqual({ sessionId: "s".repeat(43) });
  });
});
