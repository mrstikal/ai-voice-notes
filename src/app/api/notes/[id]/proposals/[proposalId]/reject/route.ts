import {
  createGuardedJsonRoute,
  jsonOk,
} from "@/lib/security/http";
import {
  getEditProposalService,
  toEditProposalErrorResponse,
} from "@/lib/notes/proposals";
import { emptyJsonObjectSchema } from "@/lib/security/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProposalRejectContext = {
  params: Promise<{ id: string; proposalId: string }>;
};

export const POST = createGuardedJsonRoute<
  Record<string, never>,
  ProposalRejectContext
>({
  maxBytes: 1_024,
  schema: emptyJsonObjectSchema,
  methods: ["POST"],
  handler: async ({ routeContext }) => {
    try {
      const { id, proposalId } = await routeContext!.params;

      return jsonOk(
        await getEditProposalService().reject(id, proposalId),
      );
    } catch (error) {
      return toEditProposalErrorResponse(error);
    }
  },
});
