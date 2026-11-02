import { z } from "zod";

import {
  OpenRouterHttpError,
  getOpenRouterClient,
  type OpenRouterClient,
} from "../ai/openrouter.ts";
import {
  UsageServiceError,
  toUsageErrorResponse,
} from "../ai/usage.ts";
import { ConfigurationError, loadConfig } from "../config.ts";
import { readEnvInt, readRateLimit } from "../env-limits.ts";
import {
  createGuardedJsonRoute,
  jsonError,
  type RateLimitOptions,
} from "../security/http.ts";

export const TTS_MODEL_ID = "elevenlabs/eleven-v4-turbo" as const;
export const TTS_RESPONSE_FORMAT = "mp3" as const;
export const TTS_MAX_INPUT_CODE_UNITS = readEnvInt(
  "TTS_MAX_INPUT_CODE_UNITS",
  3_500,
);
export const TTS_MAX_AUDIO_BYTES = readEnvInt(
  "TTS_MAX_AUDIO_BYTES",
  8 * 1024 * 1024,
);
export const TTS_TIMEOUT_MS = readEnvInt("TTS_TIMEOUT_MS", 60_000);
export const TTS_REQUEST_MAX_BYTES = readEnvInt(
  "TTS_REQUEST_MAX_BYTES",
  32 * 1024,
);
export const TTS_OPERATION = "openrouter_tts";
export const DEFAULT_TTS_RATE_LIMIT = {
  ...readRateLimit("DEFAULT_TTS_RATE_LIMIT", 5),
  key: "tts",
} as const satisfies RateLimitOptions & { readonly key?: string };
export const TTS_USD_PER_INPUT_UNIT = 0.00004;
export const TTS_ESTIMATED_MAX_COST_USD = Number(
  (TTS_USD_PER_INPUT_UNIT * TTS_MAX_INPUT_CODE_UNITS).toFixed(6),
);

export const TTS_VOICES = [
  { id: "sarah", label: "Sarah" },
  { id: "george", label: "George" },
  { id: "adam", label: "Adam" },
  { id: "alice", label: "Alice" },
  { id: "bella", label: "Bella" },
  { id: "bill", label: "Bill" },
  { id: "brian", label: "Brian" },
  { id: "callum", label: "Callum" },
  { id: "charlie", label: "Charlie" },
  { id: "chris", label: "Chris" },
  { id: "daniel", label: "Daniel" },
  { id: "eric", label: "Eric" },
  { id: "harry", label: "Harry" },
  { id: "jessica", label: "Jessica" },
  { id: "laura", label: "Laura" },
  { id: "liam", label: "Liam" },
  { id: "lily", label: "Lily" },
  { id: "matilda", label: "Matilda" },
  { id: "river", label: "River" },
  { id: "roger", label: "Roger" },
  { id: "will", label: "Will" },
] as const;

export type TtsVoice = (typeof TTS_VOICES)[number]["id"];

export const TTS_VERIFIED_VOICES: readonly TtsVoice[] = ["sarah", "george"];
export const TTS_UNAVAILABLE_VOICES: readonly TtsVoice[] = [];
export const TTS_VERIFIED_VOICES_ACTIVE = true;

export const ttsRequestSchema = z
  .object({
    text: z.string(),
    voice: z.string(),
  })
  .strict();

export type TtsRequest = z.infer<typeof ttsRequestSchema>;

export interface TtsSynthesizeRequest {
  readonly text: string;
  readonly voice: string;
}

export interface TtsAudioResult {
  readonly audio: Uint8Array;
  readonly contentType: "audio/mpeg";
  readonly model: typeof TTS_MODEL_ID;
  readonly voice: TtsVoice;
  readonly byteLength: number;
  readonly generationId: string | null;
}

export interface TtsService {
  synthesize(request: TtsSynthesizeRequest): Promise<TtsAudioResult>;
}

export interface TtsServiceOptions {
  readonly client: OpenRouterClient;
  readonly disabledVoices?: readonly TtsVoice[];
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export class TtsProviderError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TtsProviderError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isTtsVoice(value: string): value is TtsVoice {
  return TTS_VOICES.some((voice) => voice.id === value);
}

function isLikelyMp3(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) {
    return false;
  }

  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return true;
  }

  return bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
}

export function createTtsService(options: TtsServiceOptions): TtsService {
  const disabled = new Set(
    (options.disabledVoices ?? TTS_UNAVAILABLE_VOICES).filter(isTtsVoice),
  );
  const timeoutMs = options.timeoutMs ?? TTS_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? TTS_MAX_AUDIO_BYTES;

  return {
    async synthesize({ text, voice }) {
      if (!isTtsVoice(voice)) {
        throw new TtsProviderError(
          400,
          "tts_invalid_voice",
          "Zvolený hlas není podporovaný. Použijte některý z podporovaných hlasů.",
          { allowedVoices: TTS_VOICES.map((item) => item.id) },
        );
      }

      if (disabled.has(voice)) {
        throw new TtsProviderError(
          400,
          "tts_voice_unavailable",
          "Zvolený hlas není pro tento účet dostupný. Vyberte jiný hlas.",
          { voice },
        );
      }

      if (text.trim() === "") {
        throw new TtsProviderError(
          400,
          "tts_input_empty",
          "Text pro čtení nahlas je prázdný.",
        );
      }

      if (text.length > TTS_MAX_INPUT_CODE_UNITS) {
        throw new TtsProviderError(
          400,
          "tts_input_too_long",
          `Text pro čtení nahlas může mít nejvýše ${TTS_MAX_INPUT_CODE_UNITS.toLocaleString("cs-CZ")} znaků (UTF-16).`,
          {
            codeUnits: text.length,
            maxCodeUnits: TTS_MAX_INPUT_CODE_UNITS,
          },
        );
      }

      const response = await options.client.request({
        path: "/audio/speech",
        body: {
          model: TTS_MODEL_ID,
          input: text,
          voice,
          response_format: TTS_RESPONSE_FORMAT,
        },
        operation: TTS_OPERATION,
        model: TTS_MODEL_ID,
        estimatedMaxCostUsd: TTS_ESTIMATED_MAX_COST_USD,
        accept: "audio/mpeg",
        expectedContentType: "audio/mpeg",
        maxResponseBytes,
        timeoutMs,
        providerUsage: {
          model: TTS_MODEL_ID,
          voice,
          inputCodeUnits: text.length,
          responseFormat: TTS_RESPONSE_FORMAT,
        },
      });

      if (response.bytes.byteLength === 0 || !isLikelyMp3(response.bytes)) {
        throw new TtsProviderError(
          502,
          "tts_invalid_audio",
          "OpenRouter nevrátil platné MP3. Zkuste to znovu.",
        );
      }

      return {
        audio: response.bytes,
        contentType: "audio/mpeg",
        model: TTS_MODEL_ID,
        voice,
        byteLength: response.bytes.byteLength,
        generationId: response.generationId,
      };
    },
  };
}

export function getTtsService(): TtsService {
  return createTtsService({
    client: getOpenRouterClient(),
    disabledVoices: TTS_UNAVAILABLE_VOICES,
  });
}

export function toTtsErrorResponse(error: unknown): Response {
  if (error instanceof TtsProviderError) {
    return jsonError(
      error.status,
      error.code,
      error.message,
      undefined,
      error.details,
    );
  }

  if (error instanceof OpenRouterHttpError) {
    return jsonError(error.status, error.code, error.message);
  }

  if (error instanceof UsageServiceError) {
    return toUsageErrorResponse(error);
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
    "tts_error",
    "Čtení nahlas se nepodařilo. Zkuste to znovu.",
  );
}

export interface TtsRouteOptions {
  readonly serviceFactory?: () => TtsService;
  readonly rateLimit?: RateLimitOptions & { readonly key?: string };
}

export function createTtsRouteHandler(
  options: TtsRouteOptions = {},
): (request: Request) => Promise<Response> {
  const serviceFactory = options.serviceFactory ?? getTtsService;

  return createGuardedJsonRoute({
    maxBytes: TTS_REQUEST_MAX_BYTES,
    schema: ttsRequestSchema,
    methods: ["POST"],
    rateLimit: options.rateLimit ?? DEFAULT_TTS_RATE_LIMIT,
    handler: async ({ data }) => {
      try {
        const result = await serviceFactory().synthesize({
          text: data.text,
          voice: data.voice,
        });
        const headers = new Headers({
          "content-type": result.contentType,
          "content-length": String(result.audio.byteLength),
          "cache-control": "no-store",
          "x-tts-model": result.model,
          "x-tts-voice": result.voice,
        });

        if (result.generationId !== null) {
          headers.set("x-tts-generation-id", result.generationId);
        }

        return new Response(Uint8Array.from(result.audio), {
          status: 200,
          headers,
        });
      } catch (error) {
        return toTtsErrorResponse(error);
      }
    },
  });
}

export type TtsVoiceAvailability =
  | "available"
  | "live_unverified"
  | "unavailable";

export interface TtsProviderStatus {
  readonly model: typeof TTS_MODEL_ID;
  readonly responseFormat: typeof TTS_RESPONSE_FORMAT;
  readonly maxInputCodeUnits: number;
  readonly estimatedMaxCostUsd: number;
  readonly configured: boolean;
  readonly liveStatus: "verified" | "live_unverified";
  readonly voices: readonly {
    readonly id: TtsVoice;
    readonly label: string;
    readonly availability: TtsVoiceAvailability;
  }[];
}

export interface TtsProviderStatusOptions {
  readonly configured?: boolean;
  readonly disabledVoices?: readonly TtsVoice[];
  readonly liveVerified?: boolean;
}

export function getTtsProviderStatus(
  options: TtsProviderStatusOptions = {},
): TtsProviderStatus {
  const disabled = new Set(
    (options.disabledVoices ?? TTS_UNAVAILABLE_VOICES).filter(isTtsVoice),
  );
  const liveVerified = options.liveVerified ?? TTS_VERIFIED_VOICES_ACTIVE;
  const verified = new Set(liveVerified ? TTS_VERIFIED_VOICES : []);
  const configured =
    options.configured ?? loadConfig().openRouterApiKey !== null;
  const voices = TTS_VOICES.map((voice) => ({
    ...voice,
    availability: disabled.has(voice.id)
      ? ("unavailable" as const)
      : verified.has(voice.id)
        ? ("available" as const)
        : ("live_unverified" as const),
  }));
  const allVoicesVerified = TTS_VOICES.every((voice) =>
    verified.has(voice.id),
  );

  return {
    model: TTS_MODEL_ID,
    responseFormat: TTS_RESPONSE_FORMAT,
    maxInputCodeUnits: TTS_MAX_INPUT_CODE_UNITS,
    estimatedMaxCostUsd: TTS_ESTIMATED_MAX_COST_USD,
    configured,
    liveStatus:
      allVoicesVerified && disabled.size === 0
        ? "verified"
        : "live_unverified",
    voices,
  };
}
