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
  updateNoteVoiceContentInputSchema,
  type UpdateNoteVoiceContentInput,
} from "@/lib/notes/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type NoteVoiceContentRouteContext = {
  params: Promise<{ id: string }>;
};

async function readNoteId(
  context: NoteVoiceContentRouteContext | undefined,
): Promise<string> {
  if (!context) {
    throw new InvalidNoteIdError();
  }

  const { id } = await context.params;
  assertNoteId(id);
  return id;
}

export const PATCH = createGuardedJsonRoute<
  UpdateNoteVoiceContentInput,
  NoteVoiceContentRouteContext
>({
  maxBytes: NOTE_EDIT_MAX_BYTES,
  schema: updateNoteVoiceContentInputSchema,
  methods: ["PATCH"],
  handler: async ({ data, routeContext }) => {
    try {
      return jsonOk(
        await getNoteService().updateNoteVoiceContent(
          await readNoteId(routeContext),
          data,
        ),
      );
    } catch (error) {
      return toNoteErrorResponse(error);
    }
  },
});
