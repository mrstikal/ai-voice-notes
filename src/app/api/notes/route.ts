import {
  NOTE_EDIT_MAX_BYTES,
  createGuardedJsonRoute,
  createGuardedReadHandler,
  jsonOk,
} from "@/lib/security/http";
import {
  InvalidPageError,
  createNoteInputSchema,
  getNoteService,
  toNoteErrorResponse,
} from "@/lib/notes/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parsePage(value: string | null): number {
  if (value === null) {
    return 1;
  }

  if (!/^\d+$/.test(value)) {
    throw new InvalidPageError();
  }

  const page = Number(value);

  if (!Number.isSafeInteger(page) || page < 1) {
    throw new InvalidPageError();
  }

  return page;
}

const listHandler = createGuardedReadHandler({
  handler: async (request) => {
    try {
      const page = parsePage(new URL(request.url).searchParams.get("page"));
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
