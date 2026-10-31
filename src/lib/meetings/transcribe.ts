import { unlink } from "node:fs/promises";

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

import {
  UsageServiceError,
  getUsageService,
  toUsageErrorResponse,
  type UsageOperationDto,
  type UsageService,
} from "../ai/usage.ts";
import {
  ConfigurationError,
  loadConfig,
  type AppConfig,
} from "../config.ts";
import { countGraphemes } from "../notes/limits.ts";
import {
  MEETING_AUDIO_MAX_BYTES,
  checkLocalHost,
  checkMutationOrigin,
  createRateLimiter,
  jsonError,
  jsonOk,
  type RateLimitOptions,
} from "../security/http.ts";
import {
  MeetingMediaError,
  MeetingUploadError,
  assertFfprobeAvailable,
  inspectMeetingAudio,
  receiveMeetingAudioToTemp,
} from "./audio.ts";

export const SCRIBE_BATCH_MODEL_ID = "scribe_v2";
export const SCRIBE_BATCH_PROVIDER = "elevenlabs";
export const SCRIBE_BATCH_OPERATION = "elevenlabs_scribe_batch";
export const SCRIBE_BATCH_LANGUAGE_CODE = "cs";
export const SCRIBE_BATCH_USD_PER_HOUR = 0.22;
export const SCRIBE_BATCH_TIMEOUT_MS = 240_000;
export const SCRIBE_BATCH_MAX_WORDS = 300_000;
export const SCRIBE_BATCH_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MEETING_TRANSCRIPT_MAX_GRAPHEMES = 60_000;
export const MEETING_TRANSCRIPT_MAX_APPROVAL_USD = 1;
export const MEETING_TRANSCRIPT_FILE_NAME = "meeting-upload";

export const DEFAULT_MEETING_TRANSCRIBE_RATE_LIMIT = {
  limit: 3,
  windowMs: 60_000,
  key: "meeting-transcribe",
} as const satisfies RateLimitOptions & { readonly key?: string };

export interface MeetingTranscriptionSpeakerSegment {
  readonly speakerId: string;
  readonly text: string;
}

export interface MeetingTranscription {
  readonly text: string;
  readonly languageCode: string | null;
  readonly audioDurationSeconds: number | null;
  readonly transcriptGraphemes: number;
  readonly speakers: readonly string[] | null;
  readonly segments: readonly MeetingTranscriptionSpeakerSegment[] | null;
  readonly diarization: "available" | "unavailable";
  readonly model: typeof SCRIBE_BATCH_MODEL_ID;
  readonly provider: typeof SCRIBE_BATCH_PROVIDER;
  readonly operation: typeof SCRIBE_BATCH_OPERATION;
}

export interface MeetingTranscriptionOffer {
  readonly provider: typeof SCRIBE_BATCH_PROVIDER;
  readonly model: typeof SCRIBE_BATCH_MODEL_ID;
  readonly operation: typeof SCRIBE_BATCH_OPERATION;
  readonly languageCode: typeof SCRIBE_BATCH_LANGUAGE_CODE;
  readonly maxMinutes: number;
  readonly maxBytes: number;
  readonly estimatedMaxCostUsd: number;
  readonly transcriptMaxGraphemes: number;
  readonly testMode: boolean;
}

export interface BatchTranscribeTransportRequest {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly filePath: string;
  readonly fileName: string;
  readonly timeoutMs: number;
}

export interface BatchTranscribeTransport {
  transcribe(request: BatchTranscribeTransportRequest): Promise<unknown>;
}

export interface MeetingTranscriptionService {
  transcribe(input: {
    readonly filePath: string;
    readonly fileName: string;
  }): Promise<MeetingTranscription>;
}

export class MeetingTranscriptionError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MeetingTranscriptionError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let testTransport: BatchTranscribeTransport | null = null;

export function setBatchTranscribeTransportForTests(
  transport: BatchTranscribeTransport | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "Testovací transport přepisu lze nastavit pouze v NODE_ENV=test.",
    );
  }

  testTransport = transport;
}

export function getBatchTranscribeTransport(): BatchTranscribeTransport {
  if (process.env.NODE_ENV === "test") {
    if (testTransport) {
      return testTransport;
    }

    throw new MeetingTranscriptionError(
      500,
      "unmocked_provider_call",
      "V testovacím režimu není povolený nemockovaný odchozí požadavek.",
    );
  }

  return createSdkTransport();
}

function createCappedFetch(maxBytes: number): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const contentLength = response.headers.get("content-length");

    if (
      contentLength !== null &&
      Number.isFinite(Number(contentLength)) &&
      Number(contentLength) > maxBytes
    ) {
      if (response.body !== null) {
        await response.body.cancel().catch(() => undefined);
      }

      throw new Error("Provider response exceeded the allowed size.");
    }

    if (response.body === null) {
      return response;
    }

    const reader = response.body.getReader();
    let received = 0;
    const stream = new ReadableStream<Uint8Array>({
      async cancel(reason) {
        await reader.cancel(reason);
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();

          if (done) {
            controller.close();
            return;
          }

          received += value.byteLength;

          if (received > maxBytes) {
            await reader.cancel().catch(() => undefined);
            controller.error(
              new Error("Provider response exceeded the allowed size."),
            );
            return;
          }

          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
    });

    return new Response(stream, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

function createSdkTransport(): BatchTranscribeTransport {
  return {
    async transcribe({ apiKey, baseUrl, filePath, fileName, timeoutMs }) {
      const client = new ElevenLabsClient({
        apiKey,
        baseUrl,
        fetch: createCappedFetch(SCRIBE_BATCH_MAX_RESPONSE_BYTES),
        timeoutInSeconds: Math.ceil(timeoutMs / 1_000),
        maxRetries: 0,
      });

      return client.speechToText.convert({
        modelId: SCRIBE_BATCH_MODEL_ID,
        languageCode: SCRIBE_BATCH_LANGUAGE_CODE,
        diarize: true,
        timestampsGranularity: "word",
        file: {
          path: filePath,
          filename: fileName,
          contentType: "application/octet-stream",
        },
      });
    },
  };
}

export function estimateMeetingTranscriptionMaxCostUsd(
  maxMinutes: number,
): number {
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) {
    throw new RangeError("Maximální délka schůzky musí být kladné číslo.");
  }

  const usd = (maxMinutes * 60 * SCRIBE_BATCH_USD_PER_HOUR) / 3_600;

  return Math.ceil(usd * 1_000_000) / 1_000_000;
}

export function buildMeetingTranscriptionOffer(
  config: Pick<AppConfig, "meetingMaxMinutes" | "aiTestMode">,
): MeetingTranscriptionOffer {
  return {
    provider: SCRIBE_BATCH_PROVIDER,
    model: SCRIBE_BATCH_MODEL_ID,
    operation: SCRIBE_BATCH_OPERATION,
    languageCode: SCRIBE_BATCH_LANGUAGE_CODE,
    maxMinutes: config.meetingMaxMinutes,
    maxBytes: MEETING_AUDIO_MAX_BYTES,
    estimatedMaxCostUsd: estimateMeetingTranscriptionMaxCostUsd(
      config.meetingMaxMinutes,
    ),
    transcriptMaxGraphemes: MEETING_TRANSCRIPT_MAX_GRAPHEMES,
    testMode: config.aiTestMode,
  };
}

function providerStatusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const candidate = (error as { statusCode?: unknown }).statusCode;

  return typeof candidate === "number" ? candidate : null;
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "ElevenLabsTimeoutError" ||
    /timeout|timed out/iu.test(error.message)
  );
}

function mapProviderError(error: unknown): MeetingTranscriptionError {
  if (error instanceof MeetingTranscriptionError) {
    return error;
  }

  const status = providerStatusCode(error);

  if (status === 401 || status === 402 || status === 403) {
    return new MeetingTranscriptionError(
      502,
      "elevenlabs_entitlement_denied",
      "ElevenLabs přepis odmítl. Zkontrolujte ELEVENLABS_API_KEY a zda váš tarif umožňuje přepis nahrávky této délky.",
    );
  }

  if (status === 429) {
    return new MeetingTranscriptionError(
      503,
      "elevenlabs_rate_limited",
      "ElevenLabs dočasně omezil požadavky. Zkuste to znovu později.",
    );
  }

  if (status === 422 || status === 400) {
    return new MeetingTranscriptionError(
      422,
      "elevenlabs_invalid_audio",
      "ElevenLabs nahrávku pro přepis odmítl. Zkuste jiný soubor.",
    );
  }

  if (isTimeoutError(error)) {
    return new MeetingTranscriptionError(
      504,
      "elevenlabs_timeout",
      "Přepis u ElevenLabs trval příliš dlouho. Zkuste to znovu.",
    );
  }

  return new MeetingTranscriptionError(
    502,
    "elevenlabs_error",
    "Přepis se u ElevenLabs nepodařil. Zkuste to znovu.",
  );
}

interface ProviderWord {
  readonly text?: unknown;
  readonly type?: unknown;
  readonly speaker_id?: unknown;
  readonly speakerId?: unknown;
}

interface ProviderTranscript {
  readonly text?: unknown;
  readonly language_code?: unknown;
  readonly languageCode?: unknown;
  readonly audio_duration_secs?: unknown;
  readonly audioDurationSecs?: unknown;
  readonly words?: unknown;
}

function normalizeTranscriptText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim();
}

function normalizeSegmentText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}

function validSpeakerId(value: unknown): string | null {
  return typeof value === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/u.test(value)
    ? value
    : null;
}

function parseOptionalPositiveNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function buildSpeakerView(
  words: unknown,
): Pick<MeetingTranscription, "speakers" | "segments" | "diarization"> {
  if (!Array.isArray(words) || words.length === 0) {
    return { speakers: null, segments: null, diarization: "unavailable" };
  }

  if (words.length > SCRIBE_BATCH_MAX_WORDS) {
    throw new MeetingTranscriptionError(
      502,
      "invalid_provider_response",
      "ElevenLabs vrátil neobvykle dlouhý přepis. Zkuste to znovu.",
    );
  }

  const speakers: string[] = [];
  const segments: MeetingTranscriptionSpeakerSegment[] = [];
  let currentSpeaker: string | null = null;
  let currentText = "";
  let sawWord = false;

  for (const raw of words) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }

    const word = raw as ProviderWord;

    if (typeof word.text !== "string") {
      continue;
    }

    if (word.type === "spacing") {
      if (currentSpeaker !== null) {
        currentText += word.text;
      }

      continue;
    }

    const speakerId = validSpeakerId(word.speaker_id ?? word.speakerId);

    if (speakerId === null) {
      return { speakers: null, segments: null, diarization: "unavailable" };
    }

    sawWord = true;

    if (speakerId !== currentSpeaker) {
      const text = normalizeSegmentText(currentText);

      if (currentSpeaker !== null && text.trim() !== "") {
        segments.push({ speakerId: currentSpeaker, text });
      }

      currentSpeaker = speakerId;
      currentText = word.text;
    } else {
      currentText += word.text;
    }

    if (!speakers.includes(speakerId)) {
      speakers.push(speakerId);
    }
  }

  const trailing = normalizeSegmentText(currentText).replace(/\s+$/u, "");

  if (currentSpeaker !== null && trailing !== "") {
    segments.push({ speakerId: currentSpeaker, text: trailing });
  }

  if (!sawWord || segments.length === 0) {
    return { speakers: null, segments: null, diarization: "unavailable" };
  }

  return { speakers, segments, diarization: "available" };
}

export function parseMeetingTranscriptionResponse(
  value: unknown,
): MeetingTranscription {
  if (typeof value !== "object" || value === null) {
    throw new MeetingTranscriptionError(
      502,
      "invalid_provider_response",
      "ElevenLabs vrátil neplatný přepis. Zkuste to znovu.",
    );
  }

  const transcript = value as ProviderTranscript;

  if (typeof transcript.text !== "string") {
    throw new MeetingTranscriptionError(
      502,
      "invalid_provider_response",
      "ElevenLabs vrátil neplatný přepis. Zkuste to znovu.",
    );
  }

  const text = normalizeTranscriptText(transcript.text);

  if (text === "") {
    throw new MeetingTranscriptionError(
      422,
      "meeting_transcript_empty",
      "Přepis je prázdný. Zkontrolujte, zda nahrávka obsahuje řeč.",
    );
  }

  const transcriptGraphemes = countGraphemes(text);

  if (transcriptGraphemes > MEETING_TRANSCRIPT_MAX_GRAPHEMES) {
    throw new MeetingTranscriptionError(
      422,
      "meeting_transcript_too_long",
      `Přepis je delší než ${MEETING_TRANSCRIPT_MAX_GRAPHEMES.toLocaleString("cs-CZ")} znaků a nebyl přijat.`,
      {
        transcriptGraphemes,
        maxGraphemes: MEETING_TRANSCRIPT_MAX_GRAPHEMES,
      },
    );
  }

  const speakers = buildSpeakerView(transcript.words);
  const rawLanguage = transcript.language_code ?? transcript.languageCode;
  const languageCode =
    typeof rawLanguage === "string" && /^[A-Za-z-]{2,16}$/u.test(rawLanguage)
      ? rawLanguage
      : null;

  return {
    text,
    languageCode,
    audioDurationSeconds: parseOptionalPositiveNumber(
      transcript.audio_duration_secs ?? transcript.audioDurationSecs,
    ),
    transcriptGraphemes,
    speakers: speakers.speakers,
    segments: speakers.segments,
    diarization: speakers.diarization,
    model: SCRIBE_BATCH_MODEL_ID,
    provider: SCRIBE_BATCH_PROVIDER,
    operation: SCRIBE_BATCH_OPERATION,
  };
}

async function markUnknownQuietly(
  usage: UsageService,
  id: string,
  providerUsage: Record<string, unknown>,
): Promise<void> {
  await usage.markUnknown(id, providerUsage).catch(() => undefined);
}

export interface CreateMeetingTranscriptionServiceOptions {
  readonly config: AppConfig;
  readonly usage: UsageService;
  readonly transport?: BatchTranscribeTransport;
}

export function createMeetingTranscriptionService(
  options: CreateMeetingTranscriptionServiceOptions,
): MeetingTranscriptionService {
  return {
    async transcribe({ filePath, fileName }) {
      const apiKey = options.config.elevenLabsApiKey;

      if (!apiKey) {
        throw new MeetingTranscriptionError(
          503,
          "elevenlabs_not_configured",
          "ElevenLabs není nakonfigurovaný. Doplňte ELEVENLABS_API_KEY do .env.local.",
        );
      }

      const transport =
        options.transport ?? getBatchTranscribeTransport();
      const estimatedMaxCostUsd = estimateMeetingTranscriptionMaxCostUsd(
        options.config.meetingMaxMinutes,
      );
      let reservation: UsageOperationDto;

      try {
        reservation = await options.usage.reserve({
          operation: SCRIBE_BATCH_OPERATION,
          provider: SCRIBE_BATCH_PROVIDER,
          model: SCRIBE_BATCH_MODEL_ID,
          estimatedMaxCostUsd,
        });
      } catch (error) {
        if (error instanceof UsageServiceError) {
          throw error;
        }

        throw new MeetingTranscriptionError(
          503,
          "database_unavailable",
          "Databázi využití se nepodařilo načíst. Zkontrolujte DATABASE_URL a spuštěnou databázi.",
        );
      }

      let raw: unknown;

      try {
        raw = await transport.transcribe({
          apiKey,
          baseUrl: options.config.elevenLabsApiBaseUrl,
          filePath,
          fileName,
          timeoutMs: SCRIBE_BATCH_TIMEOUT_MS,
        });
      } catch (error) {
        await markUnknownQuietly(options.usage, reservation.id, {
          model: SCRIBE_BATCH_MODEL_ID,
          chargeReason: "provider_request_failed",
        });
        throw mapProviderError(error);
      }

      let transcription: MeetingTranscription;

      try {
        transcription = parseMeetingTranscriptionResponse(raw);
      } catch (error) {
        await markUnknownQuietly(options.usage, reservation.id, {
          model: SCRIBE_BATCH_MODEL_ID,
          chargeReason: "invalid_provider_response",
        });
        throw error;
      }

      try {
        await options.usage.markUnknown(reservation.id, {
          model: SCRIBE_BATCH_MODEL_ID,
          languageCode: transcription.languageCode,
          audioDurationSecs: transcription.audioDurationSeconds,
          diarize: true,
          chargeReason: "batch_transcript_usage_unknown",
        });
      } catch {
        throw new MeetingTranscriptionError(
          503,
          "usage_settlement_failed",
          "Přepis byl vytvořen, ale využití se nepodařilo zapsat. Zkuste to znovu.",
        );
      }

      return transcription;
    },
  };
}

function providerFileName(format: string): string {
  return `${MEETING_TRANSCRIPT_FILE_NAME}.${format}`;
}

function transcriptionErrorResponse(error: unknown): Response {
  if (error instanceof MeetingTranscriptionError) {
    return jsonError(
      error.status,
      error.code,
      error.message,
      undefined,
      error.details,
    );
  }

  if (error instanceof MeetingMediaError) {
    return jsonError(
      error.status,
      error.code,
      error.message,
      undefined,
      error.details,
    );
  }

  if (error instanceof MeetingUploadError) {
    return jsonError(error.status, error.code, error.message);
  }

  if (error instanceof UsageServiceError) {
    return toUsageErrorResponse(error);
  }

  if (error instanceof ConfigurationError) {
    return jsonError(
      500,
      "invalid_config",
      "Konfigurace aplikace není platná.",
    );
  }

  return jsonError(
    500,
    "meeting_transcribe_failed",
    "Přepis nahrávky se nepodařilo vytvořit.",
  );
}

function hostAndOriginErrors(
  request: Request,
  config: AppConfig,
  mutation: boolean,
): Response | null {
  const hostError = checkLocalHost(
    request,
    config.appOrigin,
    config.allowForwardedLoopback,
  );

  if (hostError) {
    return hostError;
  }

  if (mutation) {
    return checkMutationOrigin(
      request,
      config.appOrigin,
      config.allowForwardedLoopback,
    );
  }

  return null;
}

function approvalFromRequest(
  request: Request,
  maxApprovalUsd: number,
): number | null {
  const url = new URL(request.url);
  const raw = url.searchParams.get("approveCostUsd");

  if (raw === null || raw.trim() === "") {
    return null;
  }

  const value = Number(raw);

  return Number.isFinite(value) && value >= 0 && value <= maxApprovalUsd
    ? value
    : null;
}

export interface MeetingTranscribeHandlerOptions {
  readonly config?: AppConfig;
  readonly usage?: UsageService;
  readonly transport?: BatchTranscribeTransport;
  readonly rateLimit?: RateLimitOptions & { readonly key?: string };
  readonly uploadDirectory?: string;
}

export interface MeetingTranscribeHandlers {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
}

export function createMeetingTranscribeHandlers(
  options: MeetingTranscribeHandlerOptions = {},
): MeetingTranscribeHandlers {
  const limiter = createRateLimiter(
    options.rateLimit ?? DEFAULT_MEETING_TRANSCRIBE_RATE_LIMIT,
  );

  function resolveConfig(): AppConfig | Response {
    try {
      return options.config ?? loadConfig();
    } catch {
      return jsonError(
        500,
        "invalid_config",
        "Konfigurace aplikace není platná.",
      );
    }
  }

  function resolveUsage(): UsageService | Response {
    if (options.usage) {
      return options.usage;
    }

    try {
      return getUsageService();
    } catch (error) {
      if (error instanceof ConfigurationError) {
        return jsonError(
          503,
          "database_unavailable",
          "Databáze není dostupná. Zkontrolujte DATABASE_URL a spuštěnou databázi.",
        );
      }

      return jsonError(
        503,
        "database_unavailable",
        "Databázi využití se nepodařilo načíst. Zkontrolujte DATABASE_URL a spuštěnou databázi.",
      );
    }
  }

  return {
    async GET(request) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return jsonError(
          405,
          "method_not_allowed",
          "Tento endpoint nabízí cenu přepisu pouze čtecím požadavkem.",
        );
      }

      const config = resolveConfig();

      if (config instanceof Response) {
        return config;
      }

      const guardError = hostAndOriginErrors(request, config, false);

      if (guardError) {
        return guardError;
      }

      return jsonOk(buildMeetingTranscriptionOffer(config));
    },

    async POST(request) {
      if (request.method !== "POST") {
        return jsonError(
          405,
          "method_not_allowed",
          "Přepis přijímá pouze požadavek POST.",
        );
      }

      const config = resolveConfig();

      if (config instanceof Response) {
        return config;
      }

      const guardError = hostAndOriginErrors(request, config, true);

      if (guardError) {
        return guardError;
      }

      const contentType = request.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();

      if (contentType !== "application/octet-stream") {
        return jsonError(
          415,
          "invalid_content_type",
          "Nahrávka pro přepis musí mít Content-Type application/octet-stream.",
        );
      }

      const decision = limiter.check(
        options.rateLimit?.key ?? "meeting-transcribe",
      );

      if (!decision.allowed) {
        return jsonError(
          429,
          "rate_limited",
          "Příliš mnoho požadavků na přepis. Zkuste to znovu později.",
          { "Retry-After": String(decision.retryAfterSeconds) },
        );
      }

      const estimatedMaxCostUsd = estimateMeetingTranscriptionMaxCostUsd(
        config.meetingMaxMinutes,
      );
      const approved = approvalFromRequest(
        request,
        Math.max(MEETING_TRANSCRIPT_MAX_APPROVAL_USD, estimatedMaxCostUsd),
      );

      if (approved === null || approved + 1e-9 < estimatedMaxCostUsd) {
        return jsonError(
          409,
          "meeting_cost_not_approved",
          "Přepis je placená operace. Potvrďte prosím zobrazený odhad ceny.",
          undefined,
          { approvedMaxCostUsd: approved, estimatedMaxCostUsd },
        );
      }

      const usage = resolveUsage();

      if (usage instanceof Response) {
        return usage;
      }

      try {
        await assertFfprobeAvailable();
      } catch (error) {
        return transcriptionErrorResponse(error);
      }

      let received: Awaited<ReturnType<typeof receiveMeetingAudioToTemp>> | null =
        null;

      try {
        received = await receiveMeetingAudioToTemp(request, {
          directory: options.uploadDirectory,
          maxBytes: MEETING_AUDIO_MAX_BYTES,
        });
        const inspected = await inspectMeetingAudio(received.path, {
          maxDurationSeconds: config.meetingMaxMinutes * 60,
          maxBytes: MEETING_AUDIO_MAX_BYTES,
        });
        const service = createMeetingTranscriptionService({
          config,
          usage,
          transport: options.transport,
        });
        const transcription = await service.transcribe({
          filePath: received.path,
          fileName: providerFileName(inspected.format),
        });

        return jsonOk({
          ...transcription,
          durationSeconds: inspected.durationSeconds,
          format: inspected.format,
          bytes: inspected.sizeBytes,
          testMode: config.aiTestMode,
        });
      } catch (error) {
        return transcriptionErrorResponse(error);
      } finally {
        if (received !== null) {
          await unlink(received.path).catch(() => undefined);
        }
      }
    },
  };
}

