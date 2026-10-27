import { z } from "zod";

import {
  createGuardedJsonRoute,
  createGuardedReadHandler,
  jsonError,
  jsonOk,
} from "@/lib/security/http";
import {
  TtsCacheError,
  getTtsCache,
  type TtsCache,
} from "@/lib/tts/cache";

const cacheActionSchema = z.union([
  z.object({ action: z.literal("clear") }).strict(),
  z
    .object({
      action: z.literal("purge"),
      voice: z.string().min(1).max(100),
    })
    .strict(),
  z
    .object({
      action: z.literal("purge"),
      model: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal("purge"),
      noteId: z.string().uuid(),
    })
    .strict(),
]);

function cacheErrorResponse(error: unknown): Response {
  if (error instanceof TtsCacheError) {
    return jsonError(error.status, error.code, error.message);
  }

  return jsonError(
    500,
    "tts_cache_error",
    "Cache čtení nahlas se nepodařilo obsloužit.",
  );
}

export interface TtsCacheRouteOptions {
  readonly cache?: TtsCache;
}

export function createTtsCacheRouteHandlers(
  options: TtsCacheRouteOptions = {},
): {
  readonly GET: (request: Request) => Promise<Response>;
  readonly POST: (request: Request) => Promise<Response>;
} {
  const cache = options.cache ?? getTtsCache();

  return {
    GET: createGuardedReadHandler({
      handler: async () => {
        try {
          return jsonOk(await cache.stats());
        } catch (error) {
          return cacheErrorResponse(error);
        }
      },
    }),
    POST: createGuardedJsonRoute({
      maxBytes: 4 * 1024,
      schema: cacheActionSchema,
      methods: ["POST"],
      handler: async ({ data }) => {
        try {
          let affected: number;

          if (data.action === "clear") {
            affected = await cache.clear();
          } else if ("voice" in data) {
            affected = await cache.purgeVoice(data.voice);
          } else if ("model" in data) {
            affected = await cache.purgeModel(data.model);
          } else {
            affected = await cache.purgeNote(data.noteId);
          }

          return jsonOk({
            affected,
            ...(await cache.stats()),
          });
        } catch (error) {
          return cacheErrorResponse(error);
        }
      },
    }),
  };
}

const handlers = createTtsCacheRouteHandlers();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = handlers.GET;
export const POST = handlers.POST;
