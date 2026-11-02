import {
  NOTE_EDIT_MAX_BYTES,
  createGuardedJsonRoute,
  jsonOk,
} from "@/lib/security/http";
import { emptyJsonObjectSchema } from "@/lib/security/schemas";
import { getNoteService, toNoteErrorResponse } from "@/lib/notes/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = createGuardedJsonRoute<Record<string, never>>({
  maxBytes: NOTE_EDIT_MAX_BYTES,
  schema: emptyJsonObjectSchema,
  methods: ["DELETE"],
  handler: async () => {
    try {
      return jsonOk(await getNoteService().emptyTrash());
    } catch (error) {
      return toNoteErrorResponse(error);
    }
  },
});
