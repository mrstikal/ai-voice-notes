import {
  NOTE_EDIT_MAX_BYTES,
  createGuardedJsonRoute,
  createGuardedReadHandler,
  jsonOk,
} from "@/lib/security/http";
import {
  InvalidNoteIdError,
  assertNoteId,
  deleteNoteInputSchema,
  getNoteService,
  toNoteErrorResponse,
  updateNoteInputSchema,
  type DeleteNoteInput,
  type UpdateNoteInput,
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

export const GET = createGuardedReadHandler<NoteRouteContext>({
  handler: async (_request, context) => {
    try {
      return jsonOk(await getNoteService().getNote(await readNoteId(context)));
    } catch (error) {
      return toNoteErrorResponse(error);
    }
  },
});

export const PATCH = createGuardedJsonRoute<
  UpdateNoteInput,
  NoteRouteContext
>({
  maxBytes: NOTE_EDIT_MAX_BYTES,
  schema: updateNoteInputSchema,
  methods: ["PATCH"],
  handler: async ({ data, routeContext }) => {
    try {
      return jsonOk(
        await getNoteService().updateNote(await readNoteId(routeContext), data),
      );
    } catch (error) {
      return toNoteErrorResponse(error);
    }
  },
});

export const DELETE = createGuardedJsonRoute<
  DeleteNoteInput,
  NoteRouteContext
>({
  maxBytes: NOTE_EDIT_MAX_BYTES,
  schema: deleteNoteInputSchema,
  methods: ["DELETE"],
  handler: async ({ data, routeContext }) => {
    try {
      return jsonOk(
        await getNoteService().deleteNote(
          await readNoteId(routeContext),
          data.expectedVersion,
        ),
      );
    } catch (error) {
      return toNoteErrorResponse(error);
    }
  },
});
