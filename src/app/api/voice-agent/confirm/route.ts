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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const voiceAgentConfirmMaxBytes = 4 * 1024;

export const voiceAgentConfirmRequestSchema = z
  .object({
    confirmationNonce: z.string().min(16).max(200),
    proposalId: z.string().min(1).max(64),
    sessionId: z.string().min(20).max(128),
  })
  .strict();

export interface VoiceAgentConfirmRouteOptions {
  readonly store?: ToolSessionStore;
  readonly rateLimit?: { readonly limit: number; readonly windowMs: number };
}

export function createVoiceAgentConfirmRouteHandler(
  options: VoiceAgentConfirmRouteOptions = {},
): (request: Request) => Promise<Response> {
  return createGuardedJsonRoute({
    maxBytes: voiceAgentConfirmMaxBytes,
    methods: ["POST"],
    rateLimit: options.rateLimit ?? {
      key: "voice-agent-confirm",
      limit: 30,
      windowMs: 60_000,
    },
    schema: voiceAgentConfirmRequestSchema,
    handler: async ({ data }) => {
      const store = options.store ?? getToolSessionStore();

      try {
        const result = await store.confirmProposal(
          data.sessionId,
          data.proposalId,
          data.confirmationNonce,
        );

        return jsonOk({
          note: result.note,
          ok: true,
          proposal: result.proposal,
        });
      } catch (error) {
        if (error instanceof ToolSessionError) {
          return jsonError(error.status, error.code, error.message);
        }

        return jsonError(
          500,
          "internal_error",
          "Návrh se nepodařilo potvrdit.",
        );
      }
    },
  });
}

export const POST = createVoiceAgentConfirmRouteHandler();
