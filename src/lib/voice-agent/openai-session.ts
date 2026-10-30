import { randomBytes, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  ConfigurationError,
  DEFAULT_OPENAI_REALTIME_MODEL,
  loadConfig,
  type AppConfig,
} from "../config.ts";
import {
  createGuardedJsonRoute,
  jsonError,
  jsonOk,
  type RateLimitOptions,
} from "../security/http.ts";

export const OPENAI_REALTIME_MODEL_ID = DEFAULT_OPENAI_REALTIME_MODEL;
export const OPENAI_REALTIME_DEFAULT_VOICE = "marin";
export const OPENAI_REALTIME_CALLS_URL =
  "https://api.openai.com/v1/realtime/calls";
export const OPENAI_REALTIME_TIMEOUT_MS = 15_000;
export const OPENAI_REALTIME_SESSION_MAX_SECONDS = 10 * 60;
export const OPENAI_REALTIME_ANSWER_MAX_BYTES = 64 * 1024;
export const VOICE_AGENT_SDP_MAX_CHARACTERS = 64_000;
export const VOICE_AGENT_SESSION_REQUEST_MAX_BYTES = 96 * 1024;
export const VOICE_AGENT_END_REQUEST_MAX_BYTES = 8 * 1024;
export const VOICE_AGENT_MAX_ACTIVE_SESSIONS = 1;

export const DEFAULT_VOICE_AGENT_SESSION_RATE_LIMIT = {
  limit: 5,
  windowMs: 60_000,
  key: "voice-agent-session",
} as const satisfies RateLimitOptions & { readonly key?: string };

export const DEFAULT_VOICE_AGENT_END_RATE_LIMIT = {
  limit: 20,
  windowMs: 60_000,
  key: "voice-agent-end",
} as const satisfies RateLimitOptions & { readonly key?: string };

export const voiceAgentSessionRequestSchema = z
  .object({
    sdp: z.string().min(1).max(VOICE_AGENT_SDP_MAX_CHARACTERS),
  })
  .strict();

export const voiceAgentEndRequestSchema = z
  .object({
    sessionId: z.string().min(20).max(128),
  })
  .strict();

export interface RealtimeSdpExchangeRequest {
  readonly apiKey: string;
  readonly model: typeof OPENAI_REALTIME_MODEL_ID;
  readonly voice: typeof OPENAI_REALTIME_DEFAULT_VOICE;
  readonly sdp: string;
  readonly signal: AbortSignal;
}

export interface RealtimeSdpExchangeResult {
  readonly sdp: string;
}

export interface RealtimeTransport {
  exchangeSdp(
    request: RealtimeSdpExchangeRequest,
  ): Promise<RealtimeSdpExchangeResult>;
}

export class RealtimeProviderError extends Error {
  readonly status: number;
  readonly providerCode: string | null;

  constructor(
    status: number,
    message = "OpenAI Realtime request failed.",
    providerCode: string | null = null,
  ) {
    super(message);
    this.name = "RealtimeProviderError";
    this.status = status;
    this.providerCode = providerCode;
  }
}

export class VoiceAgentError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "VoiceAgentError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface StoredSession {
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface CommittedVoiceAgentSession extends StoredSession {
  readonly id: string;
}

export interface VoiceAgentSessionStore {
  begin(): string | null;
  commit(reservation: string): CommittedVoiceAgentSession;
  cancel(reservation: string): void;
  end(id: string): boolean;
  has(id: string): boolean;
  clear(): void;
}

export interface VoiceAgentSessionStoreOptions {
  readonly now?: () => number;
  readonly maxActiveSessions?: number;
  readonly sessionMaxSeconds?: number;
}

export function createVoiceAgentSessionStore(
  options: VoiceAgentSessionStoreOptions = {},
): VoiceAgentSessionStore {
  const now = options.now ?? Date.now;
  const maxActiveSessions =
    options.maxActiveSessions ?? VOICE_AGENT_MAX_ACTIVE_SESSIONS;
  const sessionMaxSeconds =
    options.sessionMaxSeconds ?? OPENAI_REALTIME_SESSION_MAX_SECONDS;

  if (!Number.isSafeInteger(maxActiveSessions) || maxActiveSessions < 1) {
    throw new RangeError("Limit aktivních relací musí být kladné celé číslo.");
  }

  if (!Number.isSafeInteger(sessionMaxSeconds) || sessionMaxSeconds < 1) {
    throw new RangeError("Limit délky relace musí být kladné celé číslo.");
  }

  const sessions = new Map<string, StoredSession>();
  const pending = new Set<string>();
  const ttlMs = sessionMaxSeconds * 1000;

  function prune(timestamp: number): void {
    for (const [id, session] of sessions) {
      if (session.expiresAt <= timestamp) {
        sessions.delete(id);
      }
    }
  }

  return {
    begin() {
      prune(now());

      if (sessions.size + pending.size >= maxActiveSessions) {
        return null;
      }

      const reservation = randomUUID();
      pending.add(reservation);
      return reservation;
    },
    commit(reservation) {
      if (!pending.delete(reservation)) {
        throw new Error("Neznámá rezervace relace.");
      }

      const createdAt = now();
      const id = randomBytes(32).toString("base64url");
      const session = {
        createdAt,
        expiresAt: createdAt + ttlMs,
      };
      prune(createdAt);
      sessions.set(id, session);

      return { id, ...session };
    },
    cancel(reservation) {
      pending.delete(reservation);
    },
    end(id) {
      prune(now());
      return sessions.delete(id);
    },
    has(id) {
      prune(now());
      return sessions.has(id);
    },
    clear() {
      sessions.clear();
      pending.clear();
    },
  };
}

let sharedStore: VoiceAgentSessionStore | null = null;

export function getVoiceAgentSessionStore(): VoiceAgentSessionStore {
  sharedStore ??= createVoiceAgentSessionStore();
  return sharedStore;
}

export function resetVoiceAgentSessionStoreForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "Sdílený store relací lze resetovat pouze v NODE_ENV=test.",
    );
  }

  sharedStore = null;
}

let testTransport: RealtimeTransport | null = null;

export function setRealtimeTransportForTests(
  transport: RealtimeTransport | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Testovací transport lze nastavit pouze v NODE_ENV=test.");
  }

  testTransport = transport;
}

function unmockedProviderCall(): VoiceAgentError {
  return new VoiceAgentError(
    500,
    "unmocked_provider_call",
    "V testovacím režimu není povolený nemockovaný odchozí požadavek.",
  );
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      total += value.byteLength;

      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new VoiceAgentError(
          502,
          "openai_invalid_response",
          "OpenAI vrátil neočekávaně velkou odpověď.",
        );
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

export interface FetchRealtimeTransportOptions {
  readonly fetchImpl?: typeof fetch;
  readonly url?: string;
}

export function createFetchRealtimeTransport(
  options: FetchRealtimeTransportOptions = {},
): RealtimeTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = options.url ?? OPENAI_REALTIME_CALLS_URL;

  return {
    async exchangeSdp({ apiKey, model, voice, sdp, signal }) {
      const form = new FormData();
      form.set("sdp", sdp);
      form.set(
        "session",
        JSON.stringify({
          type: "realtime",
          model,
          audio: { output: { voice } },
        }),
      );

      let response: Response;

      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}` },
          body: form,
          signal,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError")
        ) {
          throw new VoiceAgentError(
            504,
            "openai_timeout",
            "OpenAI neodpověděl včas. Zkuste to znovu.",
          );
        }

        throw new VoiceAgentError(
          502,
          "openai_network_error",
          "Spojení s OpenAI se nepodařilo. Zkontrolujte síť a zkuste to znovu.",
        );
      }

      if (!response.ok) {
        let providerCode: string | null = null;

        try {
          const errorBody = (await response.json()) as {
            error?: { code?: unknown };
          };

          if (typeof errorBody.error?.code === "string") {
            providerCode = errorBody.error.code;
          }
        } catch {
          providerCode = null;
        }

        throw new RealtimeProviderError(response.status, undefined, providerCode);
      }

      let text: string;

      try {
        text = await readBoundedResponseText(
          response,
          OPENAI_REALTIME_ANSWER_MAX_BYTES,
        );
      } catch (error) {
        if (error instanceof VoiceAgentError) {
          throw error;
        }

        throw new VoiceAgentError(
          502,
          "openai_invalid_response",
          "OpenAI vrátil nečitelnou SDP odpověď.",
        );
      }

      return { sdp: text };
    },
  };
}

export function getRealtimeTransport(appConfig?: AppConfig): RealtimeTransport {
  const testMode =
    process.env.NODE_ENV === "test" ||
    appConfig?.aiTestMode === true ||
    process.env.AI_TEST_MODE?.trim() === "1";

  if (testMode) {
    if (testTransport) {
      return testTransport;
    }

    throw unmockedProviderCall();
  }

  return createFetchRealtimeTransport();
}

function assertUsableConfig(config: AppConfig): string {
  if (!config.openAiApiKey) {
    throw new VoiceAgentError(
      503,
      "openai_not_configured",
      "Konverzační asistent není nakonfigurovaný. Doplňte OPENAI_API_KEY do .env.local.",
    );
  }

  if (config.openAiRealtimeModel !== OPENAI_REALTIME_MODEL_ID) {
    throw new VoiceAgentError(
      503,
      "openai_realtime_model_blocked",
      `Konverzační asistent podporuje pouze model ${OPENAI_REALTIME_MODEL_ID}. ` +
        "Nastavený OPENAI_REALTIME_MODEL se nepoužije a relace se nevytvoří.",
    );
  }

  return config.openAiApiKey;
}

function validateSdpOffer(sdp: string): string {
  const value = sdp.trim();

  if (
    value.length === 0 ||
    value.length > VOICE_AGENT_SDP_MAX_CHARACTERS ||
    /[\x00]/u.test(value) ||
    !value.startsWith("v=0") ||
    !/\r?\nm=/u.test(value)
  ) {
    throw new VoiceAgentError(
      400,
      "invalid_sdp_offer",
      "Nabídka WebRTC není platné SDP.",
    );
  }

  return sdp;
}

function validateSdpAnswer(sdp: string): string {
  const value = sdp.trim();

  if (
    value.length === 0 ||
    value.length > OPENAI_REALTIME_ANSWER_MAX_BYTES ||
    /[\x00]/u.test(value) ||
    !value.startsWith("v=0") ||
    !/\r?\nm=/u.test(value)
  ) {
    throw new VoiceAgentError(
      502,
      "openai_invalid_response",
      "OpenAI vrátil neplatnou SDP odpověď.",
    );
  }

  return sdp;
}

function mapProviderError(error: unknown): VoiceAgentError {
  if (error instanceof VoiceAgentError) {
    return error;
  }

  if (error instanceof RealtimeProviderError) {
    if (error.status === 401 || error.status === 403) {
      return new VoiceAgentError(
        502,
        "openai_auth_failed",
        "OpenAI odmítl přihlašovací údaj nebo přístup k modelu. Zkontrolujte OPENAI_API_KEY.",
      );
    }

    if (error.status === 429) {
      return new VoiceAgentError(
        503,
        "openai_rate_limited",
        "OpenAI dočasně omezil požadavky. Zkuste to znovu později.",
      );
    }

    if (error.providerCode === "model_not_found" || error.status === 404) {
      return new VoiceAgentError(
        503,
        "openai_model_unavailable",
        `Účet nemá dostupný model ${OPENAI_REALTIME_MODEL_ID}. Ověřte přístup k Realtime API.`,
        {
          providerStatus: error.status,
          providerCode: error.providerCode,
        },
      );
    }

    if (error.status === 400) {
      return new VoiceAgentError(
        502,
        "openai_request_rejected",
        "OpenAI odmítl požadavek na WebRTC relaci. Zkuste to znovu.",
        {
          providerStatus: error.status,
          providerCode: error.providerCode,
        },
      );
    }

    return new VoiceAgentError(
      502,
      "openai_error",
      "Relaci u OpenAI se nepodařilo vytvořit. Zkuste to znovu.",
      {
        providerStatus: error.status,
        providerCode: error.providerCode,
      },
    );
  }

  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return new VoiceAgentError(
      504,
      "openai_timeout",
      "OpenAI neodpověděl včas. Zkuste to znovu.",
    );
  }

  return new VoiceAgentError(
    502,
    "openai_error",
    "Relaci u OpenAI se nepodařilo vytvořit. Zkuste to znovu.",
  );
}

export interface VoiceAgentSessionDto {
  readonly sessionId: string;
  readonly answerSdp: string;
  readonly model: typeof OPENAI_REALTIME_MODEL_ID;
  readonly voice: typeof OPENAI_REALTIME_DEFAULT_VOICE;
  readonly maxSessionSeconds: number;
  readonly expiresAt: string;
}

export interface VoiceAgentService {
  startSession(sdp: string): Promise<VoiceAgentSessionDto>;
  endSession(sessionId: string): { readonly ended: true };
}

export interface VoiceAgentServiceOptions {
  readonly config: AppConfig;
  readonly store?: VoiceAgentSessionStore;
  readonly transport?: RealtimeTransport;
  readonly timeoutMs?: number;
}

function createEndSession(
  store: VoiceAgentSessionStore,
): VoiceAgentService["endSession"] {
  return (sessionId) => {
    if (!store.end(sessionId)) {
      throw new VoiceAgentError(
        404,
        "session_not_found",
        "Relace už není aktivní.",
      );
    }

    return { ended: true };
  };
}

export function createVoiceAgentService(
  options: VoiceAgentServiceOptions,
): VoiceAgentService {
  const store = options.store ?? getVoiceAgentSessionStore();
  const timeoutMs = options.timeoutMs ?? OPENAI_REALTIME_TIMEOUT_MS;
  const endSession = createEndSession(store);

  return {
    async startSession(rawSdp) {
      const apiKey = assertUsableConfig(options.config);
      const sdp = validateSdpOffer(rawSdp);
      const transport = options.transport ?? getRealtimeTransport(options.config);
      const reservation = store.begin();

      if (reservation === null) {
        throw new VoiceAgentError(
          429,
          "session_limit_reached",
          "Je už aktivní jiná hlasová relace. Nejprve ji ukončete.",
        );
      }

      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new VoiceAgentError(
              504,
              "openai_timeout",
              "OpenAI neodpověděl včas. Zkuste to znovu.",
            ),
          );
        }, timeoutMs);
      });

      try {
        const result = await Promise.race([
          transport.exchangeSdp({
            apiKey,
            model: OPENAI_REALTIME_MODEL_ID,
            voice: OPENAI_REALTIME_DEFAULT_VOICE,
            sdp,
            signal: controller.signal,
          }),
          timeout,
        ]);
        const answerSdp = validateSdpAnswer(result.sdp);
        const session = store.commit(reservation);

        return {
          sessionId: session.id,
          answerSdp,
          model: OPENAI_REALTIME_MODEL_ID,
          voice: OPENAI_REALTIME_DEFAULT_VOICE,
          maxSessionSeconds: OPENAI_REALTIME_SESSION_MAX_SECONDS,
          expiresAt: new Date(session.expiresAt).toISOString(),
        };
      } catch (error) {
        store.cancel(reservation);
        throw mapProviderError(error);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
    endSession,
  };
}

export function getVoiceAgentService(): VoiceAgentService {
  try {
    return createVoiceAgentService({ config: loadConfig() });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw new VoiceAgentError(
        500,
        "invalid_config",
        "Konfigurace aplikace je neplatná.",
      );
    }

    throw error;
  }
}

export function toVoiceAgentErrorResponse(error: unknown): Response {
  if (error instanceof VoiceAgentError) {
    return jsonError(
      error.status,
      error.code,
      error.message,
      undefined,
      error.details,
    );
  }

  if (error instanceof ConfigurationError) {
    return jsonError(
      500,
      "invalid_config",
      "Konfigurace aplikace je neplatná.",
    );
  }

  return jsonError(
    500,
    "internal_error",
    "Hlasovou relaci se nepodařilo zpracovat.",
  );
}

export interface VoiceAgentSessionRouteOptions {
  readonly serviceFactory?: () => VoiceAgentService;
  readonly rateLimit?: RateLimitOptions & { readonly key?: string };
}

export function createVoiceAgentSessionRouteHandler(
  options: VoiceAgentSessionRouteOptions = {},
): (request: Request) => Promise<Response> {
  const serviceFactory = options.serviceFactory ?? getVoiceAgentService;

  return createGuardedJsonRoute({
    maxBytes: VOICE_AGENT_SESSION_REQUEST_MAX_BYTES,
    schema: voiceAgentSessionRequestSchema,
    methods: ["POST"],
    rateLimit: options.rateLimit ?? DEFAULT_VOICE_AGENT_SESSION_RATE_LIMIT,
    handler: async ({ data }) => {
      try {
        return jsonOk(await serviceFactory().startSession(data.sdp));
      } catch (error) {
        return toVoiceAgentErrorResponse(error);
      }
    },
  });
}

export interface VoiceAgentEndRouteOptions {
  readonly serviceFactory?: () => Pick<VoiceAgentService, "endSession">;
  readonly rateLimit?: RateLimitOptions & { readonly key?: string };
}

export function getVoiceAgentEndService(): Pick<VoiceAgentService, "endSession"> {
  return {
    endSession: createEndSession(getVoiceAgentSessionStore()),
  };
}

export function createVoiceAgentEndRouteHandler(
  options: VoiceAgentEndRouteOptions = {},
): (request: Request) => Promise<Response> {
  const serviceFactory = options.serviceFactory ?? getVoiceAgentEndService;

  return createGuardedJsonRoute({
    maxBytes: VOICE_AGENT_END_REQUEST_MAX_BYTES,
    schema: voiceAgentEndRequestSchema,
    methods: ["POST"],
    rateLimit: options.rateLimit ?? DEFAULT_VOICE_AGENT_END_RATE_LIMIT,
    handler: async ({ data }) => {
      try {
        return jsonOk(serviceFactory().endSession(data.sessionId));
      } catch (error) {
        return toVoiceAgentErrorResponse(error);
      }
    },
  });
}
