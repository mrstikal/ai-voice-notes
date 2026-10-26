import {
  NOTE_EDIT_MAX_BYTES,
  createGuardedJsonRoute,
  jsonOk,
} from "@/lib/security/http";
import {
  InvalidNoteIdError,
  assertNoteId,
  getNoteService,
  toNoteErrorResponse,
  updateNoteTitleInputSchema,
  type UpdateNoteTitleInput,
} from "@/lib/notes/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type NoteTitleRouteContext = {
  params: Promise<{ id: string }>;
};

async function readNoteId(
  context: NoteTitleRouteContext | undefined,
): Promise<string> {
  if (!context) {
    throw new InvalidNoteIdError();
  }

  const { id } = await context.params;
  assertNoteId(id);
  return id;
}

export const PATCH = createGuardedJsonRoute<
  UpdateNoteTitleInput,
  NoteTitleRouteContext
>({
  maxBytes: NOTE_EDIT_MAX_BYTES,
  schema: updateNoteTitleInputSchema,
  methods: ["PATCH"],
  handler: async ({ data, routeContext }) => {
    try {
      return jsonOk(
        await getNoteService().updateNoteTitle(
          await readNoteId(routeContext),
          data,
        ),
      );
    } catch (error) {
      return toNoteErrorResponse(error);
    }
  },
});
