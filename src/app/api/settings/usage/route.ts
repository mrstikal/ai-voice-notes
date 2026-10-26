import { z } from "zod";

import {
  TOKEN_TOOL_MAX_BYTES,
  createGuardedJsonRoute,
  createGuardedReadHandler,
  jsonOk,
} from "@/lib/security/http";
import {
  getUsageService,
  toUsageErrorResponse,
} from "@/lib/ai/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const resetUsageInputSchema = z
  .object({
    confirmation: z.literal("reset-usage"),
  })
  .strict();

export const GET = createGuardedReadHandler({
  handler: async () => {
    try {
      return jsonOk(await getUsageService().getSummary());
    } catch (error) {
      return toUsageErrorResponse(error);
    }
  },
});

export const POST = createGuardedJsonRoute({
  maxBytes: TOKEN_TOOL_MAX_BYTES,
  schema: resetUsageInputSchema,
  methods: ["POST"],
  handler: async () => {
    try {
      const service = getUsageService();
      await service.resetUsage();
      return jsonOk(await service.getSummary());
    } catch (error) {
      return toUsageErrorResponse(error);
    }
  },
});
