import {
  createGuardedReadHandler,
  jsonOk,
} from "@/lib/security/http";
import {
  getRevisionService,
  toRevisionErrorResponse,
} from "@/lib/notes/revisions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RevisionsContext = {
  params: Promise<{ id: string }>;
};

export const GET = createGuardedReadHandler<RevisionsContext>({
  handler: async (_request, routeContext) => {
    try {
      const { id } = await routeContext!.params;

      return jsonOk(await getRevisionService().list(id));
    } catch (error) {
      return toRevisionErrorResponse(error);
    }
  },
});
