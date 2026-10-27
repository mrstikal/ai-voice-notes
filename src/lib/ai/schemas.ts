import { z } from "zod";

const phraseSchema = z.string().min(1).max(160);
const boundedTextSchema = z.string().min(1).max(2_000);
const targetSchema = z
  .object({
    startPhrase: phraseSchema,
    endPhrase: phraseSchema,
  })
  .strict();

const replaceSentenceOperation = z
  .object({
    type: z.literal("replace_sentence"),
    target: targetSchema,
    text: boundedTextSchema,
  })
  .strict();

const insertBeforeSentenceOperation = z
  .object({
    type: z.literal("insert_before_sentence"),
    target: targetSchema,
    text: boundedTextSchema,
  })
  .strict();

const insertAfterSentenceOperation = z
  .object({
    type: z.literal("insert_after_sentence"),
    target: targetSchema,
    text: boundedTextSchema,
  })
  .strict();

const deleteSentenceOperation = z
  .object({
    type: z.literal("delete_sentence"),
    target: targetSchema,
  })
  .strict();

const insertHeadingOperation = z
  .object({
    type: z.literal("insert_heading_before_sentence"),
    target: targetSchema,
    depth: z.number().int().min(1).max(3),
    text: phraseSchema,
  })
  .strict();

const replaceLastSentenceOperation = z
  .object({
    type: z.literal("replace_last_sentence"),
    text: boundedTextSchema,
  })
  .strict();

const setTaskCheckedOperation = z
  .object({
    type: z.literal("set_task_checked"),
    taskText: z.string().min(1).max(200),
    checked: z.boolean(),
  })
  .strict();

const replaceParagraphOperation = z
  .object({
    type: z.literal("replace_paragraph"),
    target: targetSchema,
    text: boundedTextSchema,
  })
  .strict();

const appendBoundedSectionOperation = z
  .object({
    type: z.literal("append_bounded_section"),
    text: boundedTextSchema,
  })
  .strict();

export const llmOperationSchema = z.discriminatedUnion("type", [
  replaceSentenceOperation,
  insertBeforeSentenceOperation,
  insertAfterSentenceOperation,
  deleteSentenceOperation,
  insertHeadingOperation,
  replaceLastSentenceOperation,
  setTaskCheckedOperation,
  replaceParagraphOperation,
  appendBoundedSectionOperation,
]);

export const llmOperationResponseSchema = z
  .object({
    kind: z.literal("operation"),
    operation: llmOperationSchema,
  })
  .strict();

export const llmUnclearResponseSchema = z
  .object({
    kind: z.literal("unclear"),
    clarification: z.string().min(1).max(300),
  })
  .strict();

export const llmEditResponseSchema = z.discriminatedUnion("kind", [
  llmOperationResponseSchema,
  llmUnclearResponseSchema,
]);

const llmProviderResponseBaseSchema = z
  .object({
    kind: z.enum(["operation", "unclear"]),
    operation: llmOperationSchema.nullable(),
    clarification: z.string().min(1).max(300).nullable(),
  })
  .strict();

export const llmProviderResponseSchema =
  llmProviderResponseBaseSchema.superRefine((value, context) => {
    if (value.kind === "operation") {
      if (value.operation === null) {
        context.addIssue({
          code: "custom",
          message: "Operace nesmí být null.",
          path: ["operation"],
        });
      }

      if (value.clarification !== null) {
        context.addIssue({
          code: "custom",
          message: "U operace musí být clarification null.",
          path: ["clarification"],
        });
      }

      return;
    }

    if (value.operation !== null) {
      context.addIssue({
        code: "custom",
        message: "U nejasného požadavku musí být operation null.",
        path: ["operation"],
      });
    }

    if (value.clarification === null) {
      context.addIssue({
        code: "custom",
        message: "Nejasný požadavek musí obsahovat clarification.",
        path: ["clarification"],
      });
    }
  });

export const openRouterModelMetadataSchema = z
  .object({
    id: z.string().min(1),
    context_length: z.number().int().positive().optional(),
    pricing: z
      .object({
        prompt: z.string().regex(/^\d+(?:\.\d+)?$/u),
        completion: z.string().regex(/^\d+(?:\.\d+)?$/u),
        overrides: z
          .array(
            z
              .object({
                prompt: z.string().regex(/^\d+(?:\.\d+)?$/u),
                completion: z.string().regex(/^\d+(?:\.\d+)?$/u),
              })
              .loose(),
          )
          .optional(),
      })
      .loose()
      .optional(),
    supported_parameters: z.array(z.string()).optional(),
    architecture: z
      .object({
        output_modalities: z.array(z.string()).optional(),
      })
      .loose()
      .optional(),
    top_provider: z
      .object({
        context_length: z.number().int().positive().optional(),
        max_completion_tokens: z.number().int().positive().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

export const chatCompletionResponseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z
              .object({
                content: z.string().nullable().optional(),
                refusal: z.string().nullable().optional(),
              })
              .loose(),
            finish_reason: z.string().nullable().optional(),
          })
          .loose(),
      )
      .min(1),
    error: z
      .object({
        code: z.union([z.string(), z.number()]).optional(),
        message: z.string().optional(),
      })
      .loose()
      .optional(),
    usage: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

function convertOneOfToAnyOf(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(convertOneOfToAnyOf);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const converted: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    converted[key === "oneOf" ? "anyOf" : key] = convertOneOfToAnyOf(child);
  }

  return converted;
}

const generatedJsonSchema = z.toJSONSchema(
  llmProviderResponseBaseSchema,
  { target: "draft-7" },
);
delete (generatedJsonSchema as { $schema?: unknown }).$schema;

// Root must be a closed object for strict structured output. Operation
// variants are mutually exclusive, so oneOf can safely become anyOf.
export const LLM_EDIT_JSON_SCHEMA = convertOneOfToAnyOf(
  generatedJsonSchema,
) as Record<string, unknown>;

export type LlmOperation = z.infer<typeof llmOperationSchema>;
export type LlmEditResponse = z.infer<typeof llmEditResponseSchema>;
export type ChatCompletionResponse = z.infer<
  typeof chatCompletionResponseSchema
>;
export type LlmProviderResponse = z.infer<
  typeof llmProviderResponseSchema
>;
