import {
  createGuardedJsonRoute,
  jsonOk,
} from "@/lib/security/http";
import {
  PROPOSAL_TEXT_MAX_BYTES,
  confirmEditProposalInputSchema,
  getEditProposalService,
  toEditProposalErrorResponse,
  type ConfirmEditProposalInput,
} from "@/lib/notes/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProposalConfirmContext = {
  params: Promise<{ id: string; proposalId: string }>;
};

export const POST = createGuardedJsonRoute<
  ConfirmEditProposalInput,
  ProposalConfirmContext
>({
  maxBytes: PROPOSAL_TEXT_MAX_BYTES,
  schema: confirmEditProposalInputSchema,
  methods: ["POST"],
  handler: async ({ data, routeContext }) => {
    try {
      const { id, proposalId } = await routeContext!.params;

      return jsonOk(
        await getEditProposalService().confirm(id, proposalId, data),
      );
    } catch (error) {
      return toEditProposalErrorResponse(error);
    }
  },
});
