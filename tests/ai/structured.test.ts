import { describe, expect, it, vi } from "vitest";

import {
  BudgetExceededError,
  type UsageOperationDto,
  type UsageService,
} from "../../src/lib/ai/usage";
import {
  OpenRouterClient,
  type OpenRouterTransport,
} from "../../src/lib/ai/openrouter";
import {
  LLM_CANDIDATE_MODEL_ID,
  LLM_INPUT_MAX_CODE_UNITS,
  LLM_MAX_ESTIMATED_COST_USD,
  LLM_MAX_OUTPUT_TOKENS,
  LLM_SCHEMA_NAME,
  LLM_TIMEOUT_MS,
  createStructuredLlmService,
  getLlmProviderStatus,
  estimateStructuredLlmMaxCostUsd,
  preflightLlmModel,
} from "../../src/lib/ai/structured";
import {
  LLM_EDIT_JSON_SCHEMA,
  llmEditResponseSchema,
} from "../../src/lib/ai/schemas";
import { TAG_SUGGESTIONS_SCHEMA_NAME } from "../../src/lib/ai/tag-suggestions";
import { createMockOpenRouterTransport } from "../helpers/provider-mocks";

const RESERVATION_ID = "33333333-3333-4333-8333-333333333333";
const PROMPT = "Přidej na konec poznámky krátký odstavec o testech.";

function reservation(): UsageOperationDto {
  return {
    id: RESERVATION_ID,
    operation: "llm_structured_edit",
    provider: "openrouter",
    model: LLM_CANDIDATE_MODEL_ID,
    status: "started",
    reservedCostUsd: "0.008717",
    reportedCostUsd: null,
    providerUsage: null,
    startedAt: new Date("2026-10-27T10:00:00Z"),
    settledAt: null,
  };
}

function createFakeUsage() {
  const reserve = vi.fn();
  const settle = vi.fn();
  const markUnknown = vi.fn();
  const getSummary = vi.fn();
  const resetUsage = vi.fn();

  reserve.mockResolvedValue(reservation());
  markUnknown.mockResolvedValue({
    ...reservation(),
    status: "unknown",
    settledAt: new Date("2026-10-27T10:00:01Z"),
  });

  const usage: UsageService = {
    reserve,
    settle,
    markUnknown,
    getSummary,
    resetUsage,
  };

  return { usage, reserve, settle, markUnknown, getSummary, resetUsage };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chatResponse(
  content: unknown,
  options: {
    readonly finishReason?: string;
    readonly refusal?: string;
    readonly error?: unknown;
    readonly status?: number;
  } = {},
): Response {
  const body = {
    choices: [
      {
        message: {
          content:
            typeof content === "string" ? content : JSON.stringify(content),
          refusal: options.refusal ?? null,
        },
        finish_reason: options.finishReason ?? "stop",
      },
    ],
    ...(options.error === undefined ? {} : { error: options.error }),
  };

  return json(body, options.status ?? 200);
}

function createService(options: {
  readonly transport?: OpenRouterTransport;
  readonly usage?: ReturnType<typeof createFakeUsage>;
  readonly timeoutMs?: number;
  readonly inputMaxCodeUnits?: number;
  readonly maxOutputTokens?: number;
  readonly modelId?: string;
} = {}) {
  const fakeUsage = options.usage ?? createFakeUsage();
  const client = new OpenRouterClient({
    apiKey: "test-only-openrouter",
    usage: fakeUsage.usage,
    transport: options.transport,
  });
  const service = createStructuredLlmService({
    client,
    modelId: options.modelId ?? LLM_CANDIDATE_MODEL_ID,
    timeoutMs: options.timeoutMs ?? LLM_TIMEOUT_MS,
    inputMaxCodeUnits: options.inputMaxCodeUnits,
    maxOutputTokens: options.maxOutputTokens,
  });

  return { service, client, ...fakeUsage };
}

const validOperation = {
  kind: "operation",
  operation: {
    type: "append_bounded_section",
    text: "Nový odstavec o testech.",
  },
} as const;

function providerOperation(
  operation: unknown = validOperation.operation,
) {
  return {
    kind: "operation",
    operation,
    clarification: null,
  };
}

function providerUnclear(clarification: string) {
  return {
    kind: "unclear",
    operation: null,
    clarification,
  };
}

describe("P21 structured OpenRouter client", () => {
  it("sends a strict JSON-schema request with frozen model, bounds and schema", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [chatResponse(providerOperation())],
    });
    const { service, reserve, markUnknown } = createService({ transport });

    const result = await service.request({ prompt: PROMPT });

    expect(result).toEqual(validOperation);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.url).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(transport.calls[0]!.apiKey).toBe("test-only-openrouter");
    expect(transport.calls[0]!.accept).toBe("application/json");

    const body = JSON.parse(transport.calls[0]!.body) as {
      model: string;
      messages: { role: string; content: string }[];
      max_completion_tokens: number;
      temperature: number;
      response_format: {
        type: string;
        json_schema: {
          name: string;
          strict: boolean;
          schema: Record<string, unknown>;
        };
      };
      provider: Record<string, unknown>;
    };

    expect(body.model).toBe(LLM_CANDIDATE_MODEL_ID);
    expect(body.max_completion_tokens).toBe(LLM_MAX_OUTPUT_TOKENS);
    expect(body.temperature).toBe(0);
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: LLM_SCHEMA_NAME,
        strict: true,
      },
    });
    expect(body.response_format.json_schema.schema).toEqual(
      LLM_EDIT_JSON_SCHEMA,
    );
    expect(LLM_EDIT_JSON_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["kind", "operation", "clarification"],
    });
    expect(
      (LLM_EDIT_JSON_SCHEMA.properties as Record<string, unknown>).kind,
    ).toBeDefined();
    expect(JSON.stringify(LLM_EDIT_JSON_SCHEMA)).toContain(
      '"insert_before_sentence"',
    );
    expect(JSON.stringify(LLM_EDIT_JSON_SCHEMA)).not.toContain('"oneOf"');
    expect(JSON.stringify(LLM_EDIT_JSON_SCHEMA)).not.toContain("delete_note");
    expect(JSON.stringify(LLM_EDIT_JSON_SCHEMA)).not.toContain("sql");
    expect(body.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
    ]);
    expect(body.messages[1]!.content).toBe(PROMPT);

    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith({
      operation: "llm_structured_edit",
      provider: "openrouter",
      model: LLM_CANDIDATE_MODEL_ID,
      estimatedMaxCostUsd: estimateStructuredLlmMaxCostUsd(
        PROMPT.length + body.messages[0]!.content.length,
      ),
    });
    expect(markUnknown).toHaveBeenCalledTimes(1);

    const usagePayload = JSON.stringify(markUnknown.mock.calls[0]?.[1]);
    expect(usagePayload).not.toContain(PROMPT);
    expect(usagePayload).not.toContain("Nový odstavec");
    expect(usagePayload).toContain(LLM_SCHEMA_NAME);
  });

  it("requests and validates the separate tag-suggestion JSON schema", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [chatResponse({ tags: ["atlas"], category: "Práce" })],
    });
    const { service } = createService({ transport });

    const result = await service.requestTagSuggestions({
      prompt: "Navrhni tagy pro poznámku.",
    });

    expect(result).toEqual({ tags: ["atlas"], category: "Práce" });
    const body = JSON.parse(transport.calls[0]!.body) as {
      response_format: {
        json_schema: { name: string; schema: Record<string, unknown> };
      };
    };
    expect(body.response_format.json_schema.name).toBe(
      TAG_SUGGESTIONS_SCHEMA_NAME,
    );
    expect(body.response_format.json_schema.schema).toMatchObject({
      additionalProperties: false,
      required: ["tags", "category"],
    });
  });

  it("accepts a valid unclear response without inventing an operation", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [
        chatResponse(providerUnclear("Nevím, kterou větu mám změnit.")),
      ],
    });
    const { service } = createService({ transport });

    await expect(service.request({ prompt: PROMPT })).resolves.toEqual({
      kind: "unclear",
      clarification: "Nevím, kterou větu mám změnit.",
    });
  });

  it("rejects extra keys and unsafe actions through the server-side Zod schema", async () => {
    const extraKeys = createMockOpenRouterTransport({
      responses: [
        chatResponse(
          providerOperation({
            type: "append_bounded_section",
            text: "Text.",
            sql: "drop table notes",
          }),
        ),
      ],
    });
    const extra = createService({ transport: extraKeys });

    await expect(
      extra.service.request({ prompt: PROMPT }),
    ).rejects.toMatchObject({
      code: "llm_schema_invalid",
      status: 502,
    });
    expect(JSON.stringify(extra.markUnknown.mock.calls)).not.toContain(
      "drop table",
    );

    const rootExtraTransport = createMockOpenRouterTransport({
      responses: [
        chatResponse({
          ...providerOperation(),
          extra: "not allowed",
        }),
      ],
    });
    const rootExtra = createService({ transport: rootExtraTransport });
    await expect(
      rootExtra.service.request({ prompt: PROMPT }),
    ).rejects.toMatchObject({ code: "llm_schema_invalid" });
    expect(rootExtraTransport.calls).toHaveLength(1);

    const unsafe = createMockOpenRouterTransport({
      responses: [
        chatResponse(
          providerOperation({ type: "delete_note", noteId: "all" }),
        ),
      ],
    });
    const unsafeService = createService({ transport: unsafe });

    await expect(
      unsafeService.service.request({ prompt: PROMPT }),
    ).rejects.toMatchObject({ code: "llm_schema_invalid" });
    expect(unsafe.calls).toHaveLength(1);
  });

  it("rejects malformed JSON, truncation, refusals and provider errors without retrying", async () => {
    const malformed = createService({
      transport: createMockOpenRouterTransport({
        responses: [chatResponse("{not-json")],
      }),
    });
    await expect(
      malformed.service.request({ prompt: PROMPT }),
    ).rejects.toMatchObject({ code: "llm_malformed_json" });

    const truncated = createService({
      transport: createMockOpenRouterTransport({
        responses: [chatResponse(providerOperation(), { finishReason: "length" })],
      }),
    });
    await expect(
      truncated.service.request({ prompt: PROMPT }),
    ).rejects.toMatchObject({ code: "llm_truncated" });

    const refused = createService({
      transport: createMockOpenRouterTransport({
        responses: [
          chatResponse("", { refusal: "I cannot help with that." }),
        ],
      }),
    });
    await expect(
      refused.service.request({ prompt: PROMPT }),
    ).rejects.toMatchObject({ code: "llm_refused" });

    const providerErrorTransport = createMockOpenRouterTransport({
      responses: [
        chatResponse(validOperation, {
          error: { code: "provider_error", message: "denied" },
        }),
      ],
    });
    const providerError = createService({
      transport: providerErrorTransport,
    });
    await expect(
      providerError.service.request({ prompt: PROMPT }),
    ).rejects.toMatchObject({ code: "llm_provider_error" });
    expect(providerErrorTransport.calls).toHaveLength(1);
  });

  it("maps 429 and timeout to bounded Czech errors with one provider attempt", async () => {
    const rateLimitTransport = createMockOpenRouterTransport({
      responses: [json({ error: "rate limited" }, 429)],
    });
    const rateLimited = createService({ transport: rateLimitTransport });
    await expect(
      rateLimited.service.request({ prompt: PROMPT }),
    ).rejects.toMatchObject({
      status: 503,
      code: "openrouter_rate_limited",
    });
    expect(rateLimitTransport.calls).toHaveLength(1);

    const forbiddenTransport = createMockOpenRouterTransport({
      responses: [json({ error: "forbidden" }, 403)],
    });
    const forbidden = createService({ transport: forbiddenTransport });
    await expect(
      forbidden.service.request({ prompt: PROMPT }),
    ).rejects.toMatchObject({
      status: 502,
      code: "openrouter_forbidden",
    });
    expect(forbiddenTransport.calls).toHaveLength(1);

    const hangingCalls: unknown[] = [];
    const hanging: OpenRouterTransport = {
      fetch(request) {
        hangingCalls.push(request);

        return new Promise<Response>(() => {
          // Intentionally never settles; the client timeout must win.
        });
      },
    };
    const timedOut = createService({ transport: hanging, timeoutMs: 25 });

    await expect(
      timedOut.service.request({ prompt: PROMPT }),
    ).rejects.toMatchObject({
      status: 504,
      code: "openrouter_timeout",
    });
    expect(hangingCalls).toHaveLength(1);
  });

  it("does not call the provider when P12 budget admission is denied", async () => {
    const usage = createFakeUsage();
    usage.reserve.mockRejectedValueOnce(
      new BudgetExceededError({
        budgetUsd: "2.000000",
        committedUsd: "2.000000",
        requestedUsd: "0.008717",
      }),
    );
    const transport = createMockOpenRouterTransport({
      responses: [chatResponse(providerOperation())],
    });
    const { service } = createService({ usage, transport });

    await expect(service.request({ prompt: PROMPT })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(transport.calls).toHaveLength(0);
  });

  it("surfaces unknown usage settlement without accepting the response as applied", async () => {
    const usage = createFakeUsage();
    usage.markUnknown.mockRejectedValueOnce(new Error("db down"));
    const transport = createMockOpenRouterTransport({
      responses: [chatResponse(providerOperation())],
    });
    const { service } = createService({ usage, transport });

    await expect(
      service.request({ prompt: PROMPT }),
    ).rejects.toMatchObject({
      status: 503,
      code: "openrouter_usage_settlement_failed",
    });
    expect(transport.calls).toHaveLength(1);
  });

  it("rejects oversized input and enforces the cost cap before reserving", async () => {
    const usage = createFakeUsage();
    const transport = createMockOpenRouterTransport({
      responses: [chatResponse(providerOperation())],
    });
    const { service } = createService({
      usage,
      transport,
      inputMaxCodeUnits: 20,
    });

    await expect(
      service.request({ prompt: "Toto zadání je určitě delší než dvacet znaků." }),
    ).rejects.toMatchObject({
      status: 422,
      code: "llm_input_too_large",
    });
    expect(usage.reserve).not.toHaveBeenCalled();
    expect(transport.calls).toHaveLength(0);
    expect(
      estimateStructuredLlmMaxCostUsd(LLM_INPUT_MAX_CODE_UNITS),
    ).toBeLessThanOrEqual(LLM_MAX_ESTIMATED_COST_USD);
  });

  it("does not let a caller raise the hard input, output or timeout caps", async () => {
    const transport = createMockOpenRouterTransport({
      responses: [chatResponse(providerOperation())],
    });
    const { service, reserve } = createService({
      transport,
      maxOutputTokens: 999_999,
      inputMaxCodeUnits: 999_999,
      timeoutMs: 999_999,
    });

    await expect(service.request({ prompt: PROMPT })).resolves.toEqual(
      validOperation,
    );
    const body = JSON.parse(transport.calls[0]!.body) as {
      max_completion_tokens: number;
    };
    expect(body.max_completion_tokens).toBe(LLM_MAX_OUTPUT_TOKENS);
    expect(reserve.mock.calls[0]?.[0]).toMatchObject({
      estimatedMaxCostUsd: estimateStructuredLlmMaxCostUsd(
        PROMPT.length +
          JSON.parse(transport.calls[0]!.body).messages[0].content.length,
        LLM_MAX_OUTPUT_TOKENS,
      ),
    });

    const tooLong = "x".repeat(LLM_INPUT_MAX_CODE_UNITS + 1);
    const oversized = createService({
      transport: createMockOpenRouterTransport({
        responses: [chatResponse(providerOperation())],
      }),
      inputMaxCodeUnits: 999_999,
    });
    await expect(
      oversized.service.request({ prompt: tooLong }),
    ).rejects.toMatchObject({ code: "llm_input_too_large" });
    expect(oversized.reserve).not.toHaveBeenCalled();
  });

  it("blocks the structured path when the configured model is not the frozen candidate", async () => {
    const usage = createFakeUsage();
    const transport = createMockOpenRouterTransport({
      responses: [chatResponse(providerOperation())],
    });
    const { service } = createService({
      usage,
      transport,
      modelId: "other/unverified-model",
    });

    await expect(
      service.request({ prompt: PROMPT }),
    ).rejects.toMatchObject({
      status: 503,
      code: "llm_model_unsupported",
    });
    expect(usage.reserve).not.toHaveBeenCalled();
    expect(transport.calls).toHaveLength(0);
  });

  it("exposes the fail-closed provider status for a missing key and an unapproved model", () => {
    vi.stubEnv("OPENROUTER_LLM_MODEL", LLM_CANDIDATE_MODEL_ID);
    vi.stubEnv("OPENROUTER_API_KEY", "");

    try {
      const missingKey = getLlmProviderStatus();
      expect(missingKey.configured).toBe(false);
      expect(missingKey.liveStatus).toBe("verified");
      expect(missingKey.blockedReason).toMatch(/API klíč/i);
      expect(missingKey.estimatedMaxCostUsd).toBeGreaterThan(0);

      vi.stubEnv("OPENROUTER_API_KEY", "test-only-openrouter");
      const ready = getLlmProviderStatus();
      expect(ready.configured).toBe(true);
      expect(ready.blockedReason).toBeNull();
      expect(ready.model).toBe(LLM_CANDIDATE_MODEL_ID);
      expect(ready.structuredOutputs).toBe(true);

      vi.stubEnv("OPENROUTER_LLM_MODEL", "other/unverified-model");
      const unapproved = getLlmProviderStatus();
      expect(unapproved.configured).toBe(false);
      expect(unapproved.blockedReason).toMatch(/model/i);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("preflights the frozen candidate against current metadata and capability", () => {
    const metadata = {
      id: LLM_CANDIDATE_MODEL_ID,
      context_length: 1_048_576,
      pricing: {
        prompt: "0.00000015",
        completion: "0.0000006",
      },
      supported_parameters: [
        "response_format",
        "structured_outputs",
        "max_completion_tokens",
      ],
      architecture: { output_modalities: ["text"] },
      top_provider: {
        context_length: 1_048_576,
        max_completion_tokens: 393_216,
      },
    };

    expect(preflightLlmModel(metadata)).toMatchObject({
      supported: true,
      reasons: [],
      contextLength: 1_048_576,
      maxCompletionTokens: 393_216,
    });

    expect(
      preflightLlmModel({
        ...metadata,
        supported_parameters: ["response_format"],
      }),
    ).toMatchObject({ supported: false });

    expect(
      preflightLlmModel({ ...metadata, id: "other/model" }),
    ).toMatchObject({ supported: false });

    expect(
      preflightLlmModel({
        ...metadata,
        top_provider: { max_completion_tokens: 100 },
      }),
    ).toMatchObject({ supported: false });

    expect(
      preflightLlmModel({
        ...metadata,
        pricing: { prompt: "not-a-price", completion: "0.0000006" },
      }),
    ).toMatchObject({ supported: false });

    expect(
      preflightLlmModel({
        ...metadata,
        pricing: {
          prompt: "0.00000015",
          completion: "0.0000006",
          overrides: [
            { prompt: "0.100000", completion: "0.100000" },
          ],
        },
      }),
    ).toMatchObject({ supported: false });

    expect(
      preflightLlmModel({
        ...metadata,
        architecture: { output_modalities: ["image"] },
      }),
    ).toMatchObject({ supported: false });
  });

  it("keeps the edit response schema strict and free of unsafe operation types", () => {
    expect(llmEditResponseSchema.safeParse(validOperation).success).toBe(true);
    expect(
      llmEditResponseSchema.safeParse({
        ...validOperation,
        extra: "not allowed",
      }).success,
    ).toBe(false);
    expect(
      llmEditResponseSchema.safeParse({
        kind: "operation",
        operation: { type: "apply_sql", sql: "delete from notes" },
      }).success,
    ).toBe(false);
  });
});
