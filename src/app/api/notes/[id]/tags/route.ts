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
  updateNoteMetadataInputSchema,
  type UpdateNoteMetadataInput,
} from "@/lib/notes/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type NoteTagsRouteContext = {
  params: Promise<{ id: string }>;
};

async function readNoteId(
  context: NoteTagsRouteContext | undefined,
): Promise<string> {
  if (!context) {
    throw new InvalidNoteIdError();
  }

  const { id } = await context.params;
  assertNoteId(id);
  return id;
}

export const PATCH = createGuardedJsonRoute<
  UpdateNoteMetadataInput,
  NoteTagsRouteContext
>({
  maxBytes: NOTE_EDIT_MAX_BYTES,
  schema: updateNoteMetadataInputSchema,
  methods: ["PATCH"],
  handler: async ({ data, routeContext }) => {
    try {
      return jsonOk(
        await getNoteService().updateNoteMetadata(
          await readNoteId(routeContext),
          data,
        ),
      );
    } catch (error) {
      return toNoteErrorResponse(error);
    }
  },
});
