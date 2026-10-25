import {
  NOTE_EDIT_MAX_BYTES,
  createGuardedJsonRoute,
  createGuardedReadHandler,
  jsonOk,
} from "@/lib/security/http";
import {
  createNoteInputSchema,
  getNoteService,
  parsePageParam,
  toNoteErrorResponse,
} from "@/lib/notes/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const listHandler = createGuardedReadHandler({
  handler: async (request) => {
    try {
      const page = parsePageParam(
        new URL(request.url).searchParams.get("page"),
      );
      return jsonOk(await getNoteService().listActiveNotes(page));
    } catch (error) {
      return toNoteErrorResponse(error);
    }
  },
});

export const GET = listHandler;

export const POST = createGuardedJsonRoute({
  maxBytes: NOTE_EDIT_MAX_BYTES,
  schema: createNoteInputSchema,
  methods: ["POST"],
  handler: async ({ data }) => {
    try {
      return jsonOk(await getNoteService().createNote(data), 201);
    } catch (error) {
      return toNoteErrorResponse(error);
    }
  },
});
