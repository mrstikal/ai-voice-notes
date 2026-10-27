import {
  createGuardedJsonRoute,
  jsonOk,
} from "@/lib/security/http";
import {
  getRevisionService,
  revisionRestoreInputSchema,
  toRevisionErrorResponse,
  type RevisionRestoreInput,
} from "@/lib/notes/revisions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RevisionRestoreContext = {
  params: Promise<{ id: string; revisionId: string }>;
};

export const POST = createGuardedJsonRoute<
  RevisionRestoreInput,
  RevisionRestoreContext
>({
  maxBytes: 1_024,
  schema: revisionRestoreInputSchema,
  methods: ["POST"],
  handler: async ({ data, routeContext }) => {
    try {
      const { id, revisionId } = await routeContext!.params;

      return jsonOk(
        await getRevisionService().restore(id, revisionId, data),
      );
    } catch (error) {
      return toRevisionErrorResponse(error);
    }
  },
});
