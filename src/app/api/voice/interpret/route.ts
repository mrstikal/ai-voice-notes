import { z } from "zod";

import {
  AiInterpretError,
  interpretAiEdit,
  isUndoCommand,
} from "@/lib/ai/edit-prompts";
import {
  OpenRouterHttpError,
} from "@/lib/ai/openrouter";
import {
  StructuredLlmError,
  getStructuredLlmService,
} from "@/lib/ai/structured";
import {
  NoteServiceError,
  getNoteService,
  toNoteErrorResponse,
} from "@/lib/notes/service";
import { normalizeMatchText } from "@/lib/notes/sentences";
import {
  createGuardedJsonRoute,
  jsonError,
  jsonOk,
} from "@/lib/security/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const interpretInputSchema = z
  .object({
    noteId: z.string().uuid(),
    command: z.string().max(4_000),
    snippet: z.string().max(8_000).optional().default(""),
  })
  .strict();

type InterpretInput = z.infer<typeof interpretInputSchema>;

export const POST = createGuardedJsonRoute<InterpretInput>({
  maxBytes: 16 * 1024,
  schema: interpretInputSchema,
  methods: ["POST"],
  handler: async ({ data }) => {
    try {
      const note = await getNoteService().getNote(data.noteId);

      if (isUndoCommand(data.command)) {
        return jsonOk({ kind: "undo" });
      }

      const normalizedSnippet = normalizeMatchText(data.snippet);

      if (
        normalizedSnippet !== "" &&
        !normalizeMatchText(note.contentMd).includes(normalizedSnippet) &&
        !normalizeMatchText(note.contentPlain).includes(normalizedSnippet)
      ) {
        return jsonError(
          422,
          "ai_snippet_unbound",
          "Vybraný text není součástí této poznámky. Vyberte text v náhledu poznámky.",
        );
      }

      const result = await interpretAiEdit({
        noteTitle: note.title,
        command: data.command,
        snippet: data.snippet,
        llm: getStructuredLlmService(),
      });

      return jsonOk(result);
    } catch (error) {
      if (error instanceof AiInterpretError) {
        return jsonError(error.status, error.code, error.message);
      }

      if (error instanceof NoteServiceError) {
        return toNoteErrorResponse(error);
      }

      if (error instanceof StructuredLlmError) {
        return jsonError(error.status, error.code, error.message);
      }

      if (error instanceof OpenRouterHttpError) {
        return jsonError(
          error.status,
          error.code,
          error.message,
        );
      }

      return jsonError(
        503,
        "ai_unavailable",
        "AI úprava není dostupná. Zkontrolujte OpenRouter konfiguraci; poznámky lze dál upravovat ručně.",
      );
    }
  },
});
