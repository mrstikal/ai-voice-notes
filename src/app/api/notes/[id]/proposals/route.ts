import {
  createGuardedJsonRoute,
  jsonOk,
} from "@/lib/security/http";
import {
  PROPOSAL_TEXT_MAX_BYTES,
  createEditProposalInputSchema,
  getEditProposalService,
  toEditProposalErrorResponse,
  type CreateEditProposalInput,
} from "@/lib/notes/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProposalRouteContext = {
  params: Promise<{ id: string }>;
};

export const POST = createGuardedJsonRoute<
  CreateEditProposalInput,
  ProposalRouteContext
>({
  maxBytes: PROPOSAL_TEXT_MAX_BYTES,
  schema: createEditProposalInputSchema,
  methods: ["POST"],
  handler: async ({ data, routeContext }) => {
    try {
      const { id } = await routeContext!.params;
      const proposal = await getEditProposalService().create(id, data);

      return jsonOk(proposal, 201);
    } catch (error) {
      return toEditProposalErrorResponse(error);
    }
  },
});
