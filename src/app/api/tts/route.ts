import { createHash } from "node:crypto";

import { z } from "zod";

import {
  BudgetExceededError,
  UsageServiceError,
  getUsageService,
  toUsageErrorResponse,
  type UsageService,
} from "@/lib/ai/usage";
import { ConfigurationError } from "@/lib/config";
import {
  NoteServiceError,
  getNoteService,
  toNoteErrorResponse,
  type NoteService,
} from "@/lib/notes/service";
import {
  createGuardedJsonRoute,
  jsonError,
  jsonOk,
  type RateLimitOptions,
} from "@/lib/security/http";
import {
  TTS_ESTIMATED_MAX_COST_USD,
  TTS_MODEL_ID,
  TTS_REQUEST_MAX_BYTES,
  TtsProviderError,
  getTtsService,
  isTtsVoice,
  toTtsErrorResponse,
  type TtsAudioResult,
  type TtsService,
} from "@/lib/tts/provider";
import {
  TTS_SCOPES,
  selectTtsText,
  type TtsSelection,
} from "@/lib/tts/selection";
import { chunkText, TtsTextError } from "@/lib/tts/chunking";
import {
  TtsCacheError,
  getTtsCache,
  ttsCacheKey,
  type TtsCache,
} from "@/lib/tts/cache";

const selectionFields = {
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
  paragraphIndex: z.number().int().nonnegative().optional(),
  listIndex: z.number().int().nonnegative().optional(),
  paragraphCount: z.number().int().min(1).max(5).optional(),
};

const directRequestSchema = z
  .object({
    text: z.string(),
    voice: z.string(),
    noteId: z.string().uuid().optional(),
  })
  .strict();

const noteRequestSchema = z
  .object({
    noteId: z.string(),
    scope: z.enum(TTS_SCOPES),
    voice: z.string(),
    ...selectionFields,
    sectionIndex: z.number().int().nonnegative().optional(),
    expectedSourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.sectionIndex !== undefined &&
      value.expectedSourceHash === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedSourceHash"],
        message:
          "Pro načtení sekce je nutný expectedSourceHash z manifestu.",
      });
    }
  });

export const readAloudRequestSchema = z.union([
  directRequestSchema,
  noteRequestSchema,
]);

export const DEFAULT_READ_ALOUD_RATE_LIMIT = {
  limit: 30,
  windowMs: 60_000,
  key: "tts-read-aloud",
} as const satisfies RateLimitOptions & { readonly key?: string };

export interface ReadAloudRouteOptions {
  readonly noteServiceFactory?: () => Pick<NoteService, "getNote">;
  readonly ttsServiceFactory?: () => TtsService;
  readonly usageFactory?: () => UsageService;
  readonly cache?: TtsCache;
  readonly rateLimit?: RateLimitOptions & { readonly key?: string };
}

function hashSource(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function audioResponse(
  result: TtsAudioResult,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = new Headers({
    "content-type": result.contentType,
    "content-length": String(result.audio.byteLength),
    "cache-control": "no-store",
    "x-tts-model": result.model,
    "x-tts-voice": result.voice,
    ...extraHeaders,
  });

  if (result.generationId !== null) {
    headers.set("x-tts-generation-id", result.generationId);
  }

  return new Response(Uint8Array.from(result.audio), {
    status: 200,
    headers,
  });
}

function cachedAudioResponse(
  audio: Uint8Array,
  voice: string,
  extraHeaders: Record<string, string>,
): Response {
  return new Response(Uint8Array.from(audio), {
    status: 200,
    headers: {
      "content-type": "audio/mpeg",
      "content-length": String(audio.byteLength),
      "cache-control": "no-store",
      "x-tts-model": TTS_MODEL_ID,
      "x-tts-voice": voice,
      ...extraHeaders,
    },
  });
}

async function preflightBudget(
  usage: UsageService,
  missingChunks: number,
): Promise<number> {
  if (missingChunks <= 0) {
    return 0;
  }

  let summary;

  try {
    summary = await usage.getSummary();
  } catch {
    throw new TtsProviderError(
      503,
      "database_unavailable",
      "Databázi využití se nepodařilo načíst. Zkontrolujte DATABASE_URL a spuštěnou databázi.",
    );
  }

  const requested = missingChunks * TTS_ESTIMATED_MAX_COST_USD;
  const remaining = Number(summary.remainingUsd);

  if (!Number.isFinite(remaining) || remaining + 1e-9 < requested) {
    throw new BudgetExceededError({
      budgetUsd: summary.budgetUsd,
      committedUsd: summary.committedUsd,
      requestedUsd: requested.toFixed(6),
    });
  }

  return requested;
}

async function safeHas(cache: TtsCache, key: string): Promise<boolean> {
  try {
    return await cache.has(key);
  } catch {
    return false;
  }
}

async function safeGet(
  cache: TtsCache,
  key: string,
  noteId: string,
): Promise<Uint8Array | null> {
  try {
    return await cache.get(key, noteId);
  } catch {
    return null;
  }
}

async function safePut(
  cache: TtsCache,
  key: string,
  result: TtsAudioResult,
  noteId: string,
): Promise<void> {
  try {
    await cache.put(key, result.audio, {
      model: result.model,
      voice: result.voice,
      noteId,
    });
  } catch {
    return;
  }
}

function selectionPayload(selection: TtsSelection) {
  return {
    scope: selection.scope,
    start: selection.start,
    end: selection.end,
    paragraphIndex: selection.paragraphIndex,
    listIndex: selection.listIndex,
    paragraphCount: selection.paragraphCount,
  };
}

export function toReadAloudErrorResponse(error: unknown): Response {
  if (error instanceof TtsTextError) {
    return jsonError(
      error.status,
      error.code,
      error.message,
      undefined,
      error.details,
    );
  }

  if (error instanceof TtsCacheError) {
    return jsonError(error.status, error.code, error.message);
  }

  if (error instanceof NoteServiceError) {
    return toNoteErrorResponse(error);
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

  if (
    error instanceof TtsProviderError ||
    error instanceof Error
  ) {
    return toTtsErrorResponse(error);
  }

  return jsonError(
    500,
    "tts_error",
    "Čtení nahlas se nepodařilo. Zkuste to znovu.",
  );
}

export function createReadAloudRouteHandler(
  options: ReadAloudRouteOptions = {},
): (request: Request) => Promise<Response> {
  const noteServiceFactory =
    options.noteServiceFactory ?? (() => getNoteService());
  const ttsServiceFactory = options.ttsServiceFactory ?? getTtsService;
  const usageFactory = options.usageFactory ?? getUsageService;
  const cache = options.cache ?? getTtsCache();

  return createGuardedJsonRoute({
    maxBytes: TTS_REQUEST_MAX_BYTES,
    schema: readAloudRequestSchema,
    methods: ["POST"],
    rateLimit: options.rateLimit ?? DEFAULT_READ_ALOUD_RATE_LIMIT,
    handler: async ({ data }) => {
      try {
        if ("text" in data) {
          const key = ttsCacheKey({
            text: data.text,
            model: TTS_MODEL_ID,
            voice: data.voice,
          });

          if (data.noteId !== undefined) {
            const cachedAudio = await safeGet(cache, key, data.noteId);

            if (cachedAudio !== null) {
              return cachedAudioResponse(cachedAudio, data.voice, {
                "x-tts-cache": "hit",
              });
            }
          }

          const result = await ttsServiceFactory().synthesize({
            text: data.text,
            voice: data.voice,
          });

          if (data.noteId !== undefined) {
            await safePut(cache, key, result, data.noteId);

            return audioResponse(result, { "x-tts-cache": "miss" });
          }

          return audioResponse(result);
        }

        if (!isTtsVoice(data.voice)) {
          throw new TtsProviderError(
            400,
            "tts_invalid_voice",
            "Zvolený hlas není podporovaný. Použijte Sarah nebo George.",
          );
        }

        const note = await noteServiceFactory().getNote(data.noteId);
        const sourceHash = hashSource(note.contentMd);

        if (
          data.expectedSourceHash !== undefined &&
          data.expectedSourceHash !== sourceHash
        ) {
          throw new TtsTextError(
            409,
            "tts_stale_source",
            "Poznámka se mezitím změnila. Načtěte ji znovu a spusťte čtení nahlas znovu.",
            { expectedSourceHash: data.expectedSourceHash, sourceHash },
          );
        }

        const selection = selectTtsText(note.contentMd, data);
        const chunks = chunkText(selection.text);

        if (
          data.sectionIndex !== undefined &&
          !chunks[data.sectionIndex]
        ) {
          throw new TtsTextError(
            400,
            "tts_invalid_section",
            "Vybraná sekce čtení nahlas neexistuje.",
            {
              sectionIndex: data.sectionIndex,
              sectionCount: chunks.length,
            },
          );
        }

        const keys = chunks.map((chunk) =>
          ttsCacheKey({
            text: chunk.text,
            model: TTS_MODEL_ID,
            voice: data.voice,
          }),
        );
        const cached = await Promise.all(
          keys.map((key) => safeHas(cache, key)),
        );
        const missingChunks = cached.filter((value) => !value).length;
        const estimatedMaxCostUsd = await preflightBudget(
          usageFactory(),
          missingChunks,
        );

        if (data.sectionIndex === undefined) {
          return jsonOk({
            noteId: note.id,
            noteVersion: note.version,
            sourceHash,
            voice: data.voice,
            model: TTS_MODEL_ID,
            selection: selectionPayload(selection),
            cacheHit: missingChunks === 0,
            estimatedMaxCostUsd: estimatedMaxCostUsd.toFixed(6),
            sections: chunks.map((chunk, index) => ({
              index,
              text: chunk.text,
              start: chunk.start,
              end: chunk.end,
              cacheKey: keys[index]!,
              cached: cached[index]!,
            })),
          });
        }

        const section = chunks[data.sectionIndex]!;
        const key = keys[data.sectionIndex]!;
        const commonHeaders = {
          "x-tts-section-index": String(data.sectionIndex),
          "x-tts-section-count": String(chunks.length),
          "x-tts-note-version": String(note.version),
          "x-tts-source-hash": sourceHash,
        };
        const cachedAudio = await safeGet(cache, key, note.id);

        if (cachedAudio !== null) {
          return cachedAudioResponse(cachedAudio, data.voice, {
            ...commonHeaders,
            "x-tts-cache": "hit",
          });
        }

        const result = await ttsServiceFactory().synthesize({
          text: section.text,
          voice: data.voice,
        });
        await safePut(cache, key, result, note.id);

        return audioResponse(result, {
          ...commonHeaders,
          "x-tts-cache": "miss",
        });
      } catch (error) {
        return toReadAloudErrorResponse(error);
      }
    },
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createReadAloudRouteHandler();
