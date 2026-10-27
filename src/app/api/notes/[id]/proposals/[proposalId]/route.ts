import {
  createGuardedReadHandler,
  jsonOk,
} from "@/lib/security/http";
import {
  getEditProposalService,
  toEditProposalErrorResponse,
} from "@/lib/notes/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProposalDetailContext = {
  params: Promise<{ id: string; proposalId: string }>;
};

export const GET = createGuardedReadHandler<ProposalDetailContext>({
  handler: async (_request, routeContext) => {
    try {
      const { id, proposalId } = await routeContext!.params;

      return jsonOk(
        await getEditProposalService().get(id, proposalId),
      );
    } catch (error) {
      return toEditProposalErrorResponse(error);
    }
  },
});
