import { z } from "zod";

import { OpenRouterHttpError } from "@/lib/ai/openrouter";
import {
  CleanupError,
  suggestCleanup,
} from "@/lib/ai/cleanup";
import {
  StructuredLlmError,
  getStructuredLlmService,
} from "@/lib/ai/structured";
import {
  hashNoteSource,
  resolveOperation,
} from "@/lib/notes/operations";
import {
  NoteServiceError,
  getNoteService,
  toNoteErrorResponse,
} from "@/lib/notes/service";
import {
  createGuardedJsonRoute,
  jsonError,
  jsonOk,
} from "@/lib/security/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cleanupRequestSchema = z
  .object({
    kind: z.literal("cleanup"),
    blockIndex: z.number().int().min(0).max(1_000_000),
    properNames: z
      .array(z.string().min(1).max(200))
      .max(20)
      .optional()
      .default([]),
  })
  .strict();

type CleanupRequest = z.infer<typeof cleanupRequestSchema>;

type CleanupRouteContext = {
  params: Promise<{ id: string }>;
};

export const POST = createGuardedJsonRoute<
  CleanupRequest,
  CleanupRouteContext
>({
  maxBytes: 16 * 1024,
  schema: cleanupRequestSchema,
  methods: ["POST"],
  handler: async ({ data, routeContext }) => {
    try {
      const { id } = await routeContext!.params;
      const note = await getNoteService().getNote(id);
      const suggestion = await suggestCleanup({
        note,
        blockIndex: data.blockIndex,
        properNames: data.properNames,
        llm: getStructuredLlmService(),
      });
      const candidateId = `p${suggestion.paragraph.blockIndex}`;
      const resolution = resolveOperation({
        contentMd: note.contentMd,
        operation: suggestion.operation,
        noteVersion: note.version,
        expectedVersion: note.version,
        expectedSourceHash: hashNoteSource(note.contentMd),
        candidateId,
      });

      if (
        resolution.status !== "resolved" ||
        resolution.candidate?.blockIndex !== suggestion.paragraph.blockIndex
      ) {
        return jsonError(
          422,
          "cleanup_unresolvable",
          resolution.status === "resolved"
            ? "Čištění se nepodařilo svázat s vybraným odstavcem."
            : resolution.message,
        );
      }

      return jsonOk({
        kind: "cleanup",
        operation: suggestion.operation,
        originalText: suggestion.originalText,
        cleanedText: suggestion.cleanedText,
        noteVersion: note.version,
        candidateId,
        sourceHash: resolution.sourceHash,
      });
    } catch (error) {
      if (error instanceof CleanupError) {
        return jsonError(error.status, error.code, error.message);
      }

      if (error instanceof NoteServiceError) {
        return toNoteErrorResponse(error);
      }

      if (error instanceof StructuredLlmError) {
        return jsonError(error.status, error.code, error.message);
      }

      if (error instanceof OpenRouterHttpError) {
        return jsonError(error.status, error.code, error.message);
      }

      return jsonError(
        503,
        "ai_unavailable",
        "Čištění diktátu není dostupné. Poznámky lze dál upravovat ručně.",
      );
    }
  },
});
