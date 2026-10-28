import { z } from "zod";

import {
  parseReadSelection,
  type ReadSelectionResult,
} from "@/lib/notes/read-selection";
import {
  createGuardedJsonRoute,
  jsonOk,
} from "@/lib/security/http";
import {
  NoteNotFoundError,
  getNoteService,
  toNoteErrorResponse,
} from "@/lib/notes/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const readSelectionRequestSchema = z
  .object({
    noteId: z.string().uuid(),
    transcript: z.string().min(1).max(1_000),
    selection: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    paragraphIndex: z.number().int().nonnegative().optional(),
    summary: z
      .object({
        noteVersion: z.number().int().min(1),
        text: z.string().max(10_000),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

type ReadSelectionRequest = z.infer<typeof readSelectionRequestSchema>;

export const POST = createGuardedJsonRoute<ReadSelectionRequest>({
  maxBytes: 32 * 1024,
  schema: readSelectionRequestSchema,
  methods: ["POST"],
  handler: async ({ data }) => {
    try {
      const note = await getNoteService().getNote(data.noteId);

      if (note.deletedAt) {
        throw new NoteNotFoundError();
      }

      const result: ReadSelectionResult = parseReadSelection({
        transcript: data.transcript,
        note: {
          contentMd: note.contentMd,
          version: note.version,
        },
        ...(data.selection === undefined ? {} : { selection: data.selection }),
        ...(data.paragraphIndex === undefined
          ? {}
          : { paragraphIndex: data.paragraphIndex }),
        ...(data.summary === undefined ? {} : { summary: data.summary }),
      });

      return jsonOk(result);
    } catch (error) {
      return toNoteErrorResponse(error);
    }
  },
});
