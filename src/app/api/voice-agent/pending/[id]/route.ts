import { z } from "zod";

import {
  createGuardedJsonRoute,
  jsonError,
  jsonOk,
} from "../../../../../lib/security/http.ts";
import {
  ToolSessionError,
  getToolSessionStore,
  type ToolSessionStore,
} from "../../../../../lib/voice-agent/tool-dispatch.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const voiceAgentPendingMaxBytes = 4 * 1024;

export const voiceAgentPendingRequestSchema = z
  .object({
    action: z.literal("reject").optional(),
    sessionId: z.string().min(20).max(128),
  })
  .strict();

export interface VoiceAgentPendingRouteOptions {
  readonly store?: ToolSessionStore;
  readonly rateLimit?: { readonly limit: number; readonly windowMs: number };
}

interface PendingRouteContext {
  params: Promise<{ id: string }>;
}

export function createVoiceAgentPendingRouteHandler(
  options: VoiceAgentPendingRouteOptions = {},
): (request: Request, routeContext: PendingRouteContext) => Promise<Response> {
  return createGuardedJsonRoute<
    z.infer<typeof voiceAgentPendingRequestSchema>,
    PendingRouteContext
  >({
    maxBytes: voiceAgentPendingMaxBytes,
    methods: ["POST"],
    rateLimit: options.rateLimit ?? {
      key: "voice-agent-pending",
      limit: 60,
      windowMs: 60_000,
    },
    schema: voiceAgentPendingRequestSchema,
    handler: async ({ data, routeContext }) => {
      const store = options.store ?? getToolSessionStore();

      try {
        const { id } = await routeContext!.params;

        if (data.action === "reject") {
          return jsonOk({
            ok: true,
            ...(await store.rejectPendingProposal(data.sessionId, id)),
          });
        }

        const proposal = await store.getPendingProposal(data.sessionId, id);

        return jsonOk({ ok: true, proposal });
      } catch (error) {
        if (error instanceof ToolSessionError) {
          return jsonError(error.status, error.code, error.message);
        }

        return jsonError(
          500,
          "internal_error",
          "Návrh se nepodařilo načíst.",
        );
      }
    },
  });
}

export const POST = createVoiceAgentPendingRouteHandler();
