import { z } from "zod";

import {
  createGuardedJsonRoute,
  jsonError,
  jsonOk,
} from "../../../../lib/security/http.ts";
import {
  ToolSessionError,
  getToolSessionStore,
  type ToolSessionStore,
} from "../../../../lib/voice-agent/tool-dispatch.ts";

export const voiceAgentToolMaxBytes = 16 * 1024;

const sessionIdSchema = z.string().min(20).max(128);

export const voiceAgentToolRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("call"),
      arguments: z.unknown(),
      callId: z.string().min(1).max(128),
      name: z.string().min(1).max(64),
      sessionId: sessionIdSchema,
      turnId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      action: z.literal("select"),
      noteId: z.string().min(1).max(64),
      sessionId: sessionIdSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("end"),
      sessionId: sessionIdSchema,
    })
    .strict(),
]);

export type VoiceAgentToolRequest = z.infer<typeof voiceAgentToolRequestSchema>;

export interface VoiceAgentToolRouteOptions {
  readonly store?: ToolSessionStore;
  readonly rateLimit?: { readonly limit: number; readonly windowMs: number };
}

export function createVoiceAgentToolRouteHandler(
  options: VoiceAgentToolRouteOptions = {},
): (request: Request) => Promise<Response> {
  return createGuardedJsonRoute({
    maxBytes: voiceAgentToolMaxBytes,
    methods: ["POST"],
    rateLimit: options.rateLimit ?? {
      key: "voice-agent-tool",
      limit: 60,
      windowMs: 60_000,
    },
    schema: voiceAgentToolRequestSchema,
    handler: async ({ data }) => {
      const store = options.store ?? getToolSessionStore();

      try {
        if (data.action === "call") {
          return jsonOk(await store.dispatch(data));
        }

        if (data.action === "select") {
          return jsonOk({
            ok: true,
            selected: await store.selectNote(data.sessionId, data.noteId),
          });
        }

        return jsonOk({
          ended: store.endSession(data.sessionId),
          ok: true,
        });
      } catch (error) {
        if (error instanceof ToolSessionError) {
          return jsonError(error.status, error.code, error.message);
        }

        return jsonError(
          500,
          "internal_error",
          "Požadavek nástroje se nepodařilo zpracovat.",
        );
      }
    },
  });
}

export const POST = createVoiceAgentToolRouteHandler();
