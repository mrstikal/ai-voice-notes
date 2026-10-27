import { z } from "zod";

import { ConfigurationError } from "@/lib/config";
import { OpenRouterHttpError } from "@/lib/ai/openrouter";
import {
  CleanupError,
  suggestCleanup,
} from "@/lib/ai/cleanup";
import {
  SummaryError,
  suggestSummary,
} from "@/lib/ai/summary";
import {
  StructuredLlmError,
  getStructuredLlmService,
} from "@/lib/ai/structured";
import {
  UsageServiceError,
  toUsageErrorResponse,
} from "@/lib/ai/usage";
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

const summaryRequestSchema = z
  .object({
    kind: z.literal("summary"),
    scope: z.enum(["full", "range"]),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope === "full") {
      if (value.start !== undefined || value.end !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Shrnutí celé poznámky nesmí obsahovat rozsah.",
        });
      }

      return;
    }

    if (
      value.start === undefined ||
      value.end === undefined ||
      value.start >= value.end
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Vybraný text vyžaduje platný začátek a konec.",
      });
    }
  });

const suggestRequestSchema = z.union([
  cleanupRequestSchema,
  summaryRequestSchema,
]);

type SuggestRequest = z.infer<typeof suggestRequestSchema>;

type SuggestRouteContext = {
  params: Promise<{ id: string }>;
};

export const POST = createGuardedJsonRoute<
  SuggestRequest,
  SuggestRouteContext
>({
  maxBytes: 16 * 1024,
  schema: suggestRequestSchema,
  methods: ["POST"],
  handler: async ({ data, routeContext }) => {
    try {
      const { id } = await routeContext!.params;
      const note = await getNoteService().getNote(id);

      if (data.kind === "summary") {
        const suggestion = await suggestSummary({
          note,
          selection: {
            scope: data.scope,
            ...(data.start === undefined ? {} : { start: data.start }),
            ...(data.end === undefined ? {} : { end: data.end }),
          },
          llm: getStructuredLlmService(),
        });

        return jsonOk({
          kind: "summary",
          noteId: note.id,
          noteVersion: note.version,
          summaryText: suggestion.summaryText,
          sourceGraphemes: suggestion.sourceGraphemes,
        });
      }

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
      if (error instanceof SummaryError) {
        return jsonError(error.status, error.code, error.message);
      }

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

      if (error instanceof UsageServiceError) {
        return toUsageErrorResponse(error);
      }

      const unavailable =
        data.kind === "summary"
          ? "Shrnutí není dostupné. Poznámky lze dál upravovat ručně."
          : "Čištění diktátu není dostupné. Poznámky lze dál upravovat ručně.";

      if (error instanceof ConfigurationError) {
        return jsonError(503, "ai_unavailable", unavailable);
      }

      return jsonError(503, "ai_unavailable", unavailable);
    }
  },
});
