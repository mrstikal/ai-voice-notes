import {
  NOTE_EDIT_MAX_BYTES,
  createGuardedJsonRoute,
  jsonOk,
} from "@/lib/security/http";
import {
  InvalidNoteIdError,
  assertNoteId,
  getNoteService,
  restoreNoteInputSchema,
  toNoteErrorResponse,
  type RestoreNoteInput,
} from "@/lib/notes/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type NoteRouteContext = {
  params: Promise<{ id: string }>;
};

async function readNoteId(
  context: NoteRouteContext | undefined,
): Promise<string> {
  if (!context) {
    throw new InvalidNoteIdError();
  }

  const { id } = await context.params;
  assertNoteId(id);
  return id;
}

export const POST = createGuardedJsonRoute<
  RestoreNoteInput,
  NoteRouteContext
>({
  maxBytes: NOTE_EDIT_MAX_BYTES,
  schema: restoreNoteInputSchema,
  methods: ["POST"],
  handler: async ({ data, routeContext }) => {
    try {
      return jsonOk(
        await getNoteService().restoreNote(
          await readNoteId(routeContext),
          data.expectedVersion,
        ),
      );
    } catch (error) {
      return toNoteErrorResponse(error);
    }
  },
});
