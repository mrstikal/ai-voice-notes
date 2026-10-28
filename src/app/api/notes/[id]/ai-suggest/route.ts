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
  TagSuggestionError,
  suggestTags,
} from "@/lib/ai/tag-suggestions";
import {
  TaskSuggestionError,
  prepareTaskInsertion,
  suggestTasks,
} from "@/lib/ai/task-suggestions";
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

const tagSuggestionsRequestSchema = z
  .object({
    kind: z.literal("tag_suggestions"),
  })
  .strict();

const taskSuggestionsRequestSchema = z
  .object({
    kind: z.literal("task_suggestions"),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.start >= value.end) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Vybraná pasáž vyžaduje platný začátek a konec.",
      });
    }
  });

const taskApplyRequestSchema = z
  .object({
    kind: z.literal("task_apply"),
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
    tasks: z.array(z.string().min(1).max(200)).min(1).max(10),
  })
  .strict();

const suggestRequestSchema = z.union([
  cleanupRequestSchema,
  summaryRequestSchema,
  tagSuggestionsRequestSchema,
  taskSuggestionsRequestSchema,
  taskApplyRequestSchema,
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

      if (data.kind === "task_suggestions") {
        const suggestion = await suggestTasks({
          note,
          start: data.start,
          end: data.end,
          llm: getStructuredLlmService(),
        });

        return jsonOk({ kind: "task_suggestions", ...suggestion });
      }

      if (data.kind === "task_apply") {
        const insertion = prepareTaskInsertion({
          note,
          expectedVersion: data.expectedVersion,
          tasks: data.tasks,
        });

        return jsonOk({
          kind: "task_apply",
          operation: insertion.operation,
          noteVersion: insertion.noteVersion,
          tasks: insertion.tasks,
        });
      }

      if (data.kind === "tag_suggestions") {
        const suggestion = await suggestTags({
          note,
          llm: getStructuredLlmService(),
        });

        return jsonOk({ kind: "tag_suggestions", ...suggestion });
      }

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
      if (error instanceof TaskSuggestionError) {
        return jsonError(error.status, error.code, error.message);
      }

      if (error instanceof TagSuggestionError) {
        return jsonError(error.status, error.code, error.message);
      }

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
        data.kind === "tag_suggestions"
          ? "AI návrh tagů není dostupný. Ruční tagy lze dál upravovat."
          : data.kind === "task_suggestions" || data.kind === "task_apply"
            ? "Extrakce úkolů není dostupná. Úkoly lze dál upravovat ručně."
            : data.kind === "summary"
            ? "Shrnutí není dostupné. Poznámky lze dál upravovat ručně."
            : "Čištění diktátu není dostupné. Poznámky lze dál upravovat ručně.";

      if (error instanceof ConfigurationError) {
        return jsonError(503, "ai_unavailable", unavailable);
      }

      return jsonError(503, "ai_unavailable", unavailable);
    }
  },
});
