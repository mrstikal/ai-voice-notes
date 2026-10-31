import { z } from "zod";

import { ConfigurationError } from "@/lib/config";

import { getStructuredLlmService } from "@/lib/ai/structured";
import { getEditProposalService } from "@/lib/notes/proposals";
import { createReadServices } from "@/lib/voice-agent/read-services";
import {
  ChainedControllerError,
  generateChainedSummary,
  runChainedTurn,
  type ChainedDependencies,
} from "@/lib/voice/chained-controller";
import {
  createGuardedJsonRoute,
  jsonError,
  jsonOk,
} from "@/lib/security/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const selectionSchema = z
  .object({
    end: z.number().int().nonnegative(),
    start: z.number().int().nonnegative(),
  })
  .strict();

export const chainedRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("turn"),
      selectedNoteId: z.string().uuid().optional(),
      selectedNoteVersion: z
        .number()
        .int()
        .min(1)
        .max(2_147_483_647)
        .optional(),
      selection: selectionSchema.nullable().optional(),
      transcript: z.string().trim().min(1, "Přepis nesmí být prázdný."),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.selectedNoteId !== undefined &&
        value.selectedNoteVersion === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "Vybraná poznámka musí mít ověřenou verzi.",
          path: ["selectedNoteVersion"],
        });
      }
    }),
  z
    .object({
      kind: z.literal("summary"),
      noteId: z.string().uuid(),
      expectedVersion: z
        .number()
        .int()
        .min(1)
        .max(2_147_483_647),
      selection: selectionSchema.nullable().optional(),
    })
    .strict(),
]);

export interface ChainedRouteOptions {
  readonly dependencies?: ChainedDependencies;
  readonly rateLimit?: { readonly limit: number; readonly windowMs: number };
}

export function createChainedRouteHandler(
  options: ChainedRouteOptions = {},
) {
  return createGuardedJsonRoute({
    maxBytes: 8 * 1024,
    methods: ["POST"],
    rateLimit: options.rateLimit ?? {
      key: "voice-agent-chained",
      limit: 30,
      windowMs: 60_000,
    },
    schema: chainedRequestSchema,
    handler: async ({ data }) => {
      try {
        const dependencies = options.dependencies ?? {
          llm: getStructuredLlmService(),
          proposals: getEditProposalService(),
          readServices: createReadServices(),
        };

        if (data.kind === "summary") {
          return jsonOk({
            kind: "summary",
            summary: await generateChainedSummary(
              {
                noteId: data.noteId,
                expectedVersion: data.expectedVersion,
                selection: data.selection,
              },
              dependencies,
            ),
          });
        }

        return jsonOk({
          kind: "turn",
          outcome: await runChainedTurn(
            {
              selectedNoteId: data.selectedNoteId,
              selectedNoteVersion: data.selectedNoteVersion,
              selection: data.selection,
              transcript: data.transcript,
            },
            dependencies,
          ),
        });
      } catch (error) {
        if (error instanceof ConfigurationError) {
          return jsonError(
            503,
            "openrouter_not_configured",
            "OpenRouter není nakonfigurovaný. Řetězený režim nelze spustit.",
            undefined,
            { provider: "openrouter" },
          );
        }

        if (error instanceof ChainedControllerError) {
          return jsonError(
            error.status,
            error.code,
            error.message,
            undefined,
            {
              provider: error.provider,
              ...error.details,
            },
          );
        }

        return jsonError(
          500,
          "chained_internal_error",
          "Řetězený režim selhal. Zkuste to znovu.",
        );
      }
    },
  });
}

export const POST = createChainedRouteHandler();
