import {
  DEFAULT_OPENROUTER_LLM_MODEL,
  loadConfig,
} from "../config.ts";
import {
  OpenRouterClient,
  OpenRouterHttpError,
  getOpenRouterClient,
  type OpenRouterResponse,
} from "./openrouter.ts";
import {
  UsageServiceError,
} from "./usage.ts";
import {
  LLM_EDIT_JSON_SCHEMA,
  chatCompletionResponseSchema,
  llmEditResponseSchema,
  llmProviderResponseSchema,
  openRouterModelMetadataSchema,
  type LlmEditResponse,
} from "./schemas.ts";
import {
  TAG_SUGGESTIONS_JSON_SCHEMA,
  TAG_SUGGESTIONS_SCHEMA_NAME,
  tagSuggestionResponseSchema,
  type TagSuggestionResponse,
} from "./tag-suggestions.ts";
import {
  SUMMARY_JSON_SCHEMA,
  SUMMARY_SCHEMA_NAME,
  summaryResponseSchema,
  type SummaryResponse,
} from "./summary.ts";
import {
  TASK_SUGGESTIONS_JSON_SCHEMA,
  TASK_SUGGESTIONS_SCHEMA_NAME,
  taskSuggestionResponseSchema,
  type TaskSuggestionResponse,
} from "./task-suggestions.ts";

export const LLM_CANDIDATE_MODEL_ID = DEFAULT_OPENROUTER_LLM_MODEL;
export const LLM_OPERATION = "llm_structured_edit";
export const TAG_SUGGESTIONS_OPERATION = "llm_tag_suggestions";
export const TASK_SUGGESTIONS_OPERATION = "llm_task_suggestions";
export const SUMMARY_OPERATION = "llm_summary";
export const LLM_INPUT_MAX_CODE_UNITS = 12_000;
export const LLM_MAX_OUTPUT_TOKENS = 1_200;
export const LLM_TIMEOUT_MS = 20_000;
export const LLM_RESPONSE_MAX_BYTES = 64 * 1024;
export const LLM_PROMPT_OVERHEAD_TOKENS = 256;
export const LLM_MAX_ESTIMATED_COST_USD = 0.02;
export const LLM_WORST_CASE_PROMPT_USD_PER_TOKEN = 0.0000003;
export const LLM_WORST_CASE_COMPLETION_USD_PER_TOKEN = 0.0000012;
export const LLM_SCHEMA_NAME = "note_edit_proposal";
export const LLM_LIVE_VERIFIED = true;
const LLM_SCHEMA_CODE_UNITS = JSON.stringify(LLM_EDIT_JSON_SCHEMA).length;
const LLM_REQUEST_OVERHEAD_CODE_UNITS = LLM_SCHEMA_CODE_UNITS + 512;

const DEFAULT_SYSTEM_PROMPT =
  "Vracíš pouze platný JSON podle poskytnutého striktního schématu. " +
  "Nepřidávej vysvětlení, markdown ani další klíče. " +
  "Když je požadavek nejasný nebo nebezpečný, vrať kind=unclear.";

export interface LlmModelProfile {
  readonly id: string;
  readonly structuredOutputs: boolean;
  readonly checkedAt: string;
  readonly contextLength: number;
  readonly maxCompletionTokens: number;
  readonly promptUsdPerToken: number;
  readonly completionUsdPerToken: number;
}

/**
 * Frozen preflight of the candidate from 2026-10-27. The public OpenRouter
 * model catalog reported structured_outputs/response_format support, context
 * 1,048,576 and max completion 393,216 tokens. The account /key check returned
 * 200 and was not a free tier. A separately authorized short structured
 * request succeeded on 2026-10-27 (append_bounded_section); compatibility is
 * live verified for this candidate. Keep the profile frozen until a new
 * model change is approved and preflighted.
 */
export const LLM_MODEL_PROFILE: LlmModelProfile = Object.freeze({
  id: LLM_CANDIDATE_MODEL_ID,
  structuredOutputs: true,
  checkedAt: "2026-10-27",
  contextLength: 1_048_576,
  maxCompletionTokens: 393_216,
  promptUsdPerToken: LLM_WORST_CASE_PROMPT_USD_PER_TOKEN,
  completionUsdPerToken: LLM_WORST_CASE_COMPLETION_USD_PER_TOKEN,
});

export interface LlmPreflightResult {
  readonly supported: boolean;
  readonly reasons: readonly string[];
  readonly contextLength: number | null;
  readonly maxCompletionTokens: number | null;
}

export interface LlmProviderStatus {
  readonly configured: boolean;
  readonly model: string;
  readonly structuredOutputs: boolean;
  readonly liveStatus: "live_unverified" | "verified";
  readonly maxInputCodeUnits: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly estimatedMaxCostUsd: number;
  readonly checkedAt: string;
  readonly blockedReason: string | null;
}

export class StructuredLlmError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "StructuredLlmError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function parsePrice(value: string): number | null {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function preflightLlmModel(
  metadata: unknown,
  modelId: string = LLM_CANDIDATE_MODEL_ID,
): LlmPreflightResult {
  const parsed = openRouterModelMetadataSchema.safeParse(metadata);

  if (!parsed.success) {
    return {
      supported: false,
      reasons: ["Model metadata have an unexpected shape."],
      contextLength: null,
      maxCompletionTokens: null,
    };
  }

  const model = parsed.data;
  const reasons: string[] = [];
  const contextLength =
    model.context_length ?? model.top_provider?.context_length ?? null;
  const maxCompletionTokens =
    model.top_provider?.max_completion_tokens ?? null;
  const inputTokens = estimateStructuredLlmInputTokens(
    LLM_INPUT_MAX_CODE_UNITS,
  );

  if (model.id !== modelId) {
    reasons.push(`Model catalog returned ${model.id}, expected ${modelId}.`);
  }

  if (
    !model.supported_parameters?.includes("structured_outputs") ||
    !model.supported_parameters?.includes("response_format")
  ) {
    reasons.push("Structured JSON-schema output is not advertised.");
  }

  if (!model.architecture?.output_modalities?.includes("text")) {
    reasons.push("The model does not advertise text output.");
  }

  if (
    contextLength === null ||
    contextLength < inputTokens + LLM_MAX_OUTPUT_TOKENS
  ) {
    reasons.push("The context window is smaller than the enforced bounds.");
  }

  if (
    maxCompletionTokens === null ||
    maxCompletionTokens < LLM_MAX_OUTPUT_TOKENS
  ) {
    reasons.push("The output-token limit is below the enforced bound.");
  }

  const priceEntries =
    model.pricing === undefined
      ? []
      : [
          {
            prompt: model.pricing.prompt,
            completion: model.pricing.completion,
          },
          ...(model.pricing.overrides ?? []),
        ];
  const promptPrices = priceEntries.map((entry) =>
    parsePrice(entry.prompt),
  );
  const completionPrices = priceEntries.map((entry) =>
    parsePrice(entry.completion),
  );
  const promptPrice =
    promptPrices.length === 0
      ? null
      : Math.max(...promptPrices.map((price) => price ?? -1));
  const completionPrice =
    completionPrices.length === 0
      ? null
      : Math.max(...completionPrices.map((price) => price ?? -1));

  if (
    promptPrice === null ||
    completionPrice === null ||
    promptPrice < 0 ||
    completionPrice < 0
  ) {
    reasons.push("Model pricing is missing or invalid.");
  } else {
    const maxCost =
      Math.ceil(
        inputTokens *
          Math.max(promptPrice, LLM_WORST_CASE_PROMPT_USD_PER_TOKEN) *
          1e6,
      ) /
        1e6 +
      Math.ceil(
        LLM_MAX_OUTPUT_TOKENS *
          Math.max(
            completionPrice,
            LLM_WORST_CASE_COMPLETION_USD_PER_TOKEN,
          ) *
          1e6,
      ) /
        1e6;

    if (maxCost > LLM_MAX_ESTIMATED_COST_USD) {
      reasons.push("The worst-case estimated cost exceeds the local cap.");
    }
  }

  return {
    supported: reasons.length === 0,
    reasons,
    contextLength,
    maxCompletionTokens,
  };
}

export function estimateStructuredLlmInputTokens(
  codeUnits: number,
): number {
  return (
    Math.ceil(
      (Math.max(0, codeUnits) + LLM_REQUEST_OVERHEAD_CODE_UNITS) * 2,
    ) + LLM_PROMPT_OVERHEAD_TOKENS
  );
}

export function estimateStructuredLlmMaxCostUsd(
  codeUnits: number,
  maxOutputTokens: number = LLM_MAX_OUTPUT_TOKENS,
): number {
  const inputTokens = estimateStructuredLlmInputTokens(codeUnits);
  const total =
    inputTokens * LLM_WORST_CASE_PROMPT_USD_PER_TOKEN +
    maxOutputTokens * LLM_WORST_CASE_COMPLETION_USD_PER_TOKEN;

  return Math.ceil(total * 1e6) / 1e6;
}

export function getLlmProviderStatus(): LlmProviderStatus {
  const config = loadConfig();
  const model = config.openRouterLlmModel;
  const candidateSupported =
    model === LLM_MODEL_PROFILE.id && LLM_MODEL_PROFILE.structuredOutputs;
  const blockedReason = !config.openRouterApiKey
    ? "OpenRouter API klíč není nakonfigurovaný. Strukturované AI úpravy zůstávají vypnuté."
    : !candidateSupported
      ? "Zvolený model není ověřený pro striktní JSON-schema výstup. Změna modelu vyžaduje schválený preflight."
      : null;

  return {
    configured: blockedReason === null,
    model,
    structuredOutputs: candidateSupported,
    liveStatus: LLM_LIVE_VERIFIED ? "verified" : "live_unverified",
    maxInputCodeUnits: LLM_INPUT_MAX_CODE_UNITS,
    maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
    timeoutMs: LLM_TIMEOUT_MS,
    estimatedMaxCostUsd: estimateStructuredLlmMaxCostUsd(
      LLM_INPUT_MAX_CODE_UNITS,
    ),
    checkedAt: LLM_MODEL_PROFILE.checkedAt,
    blockedReason,
  };
}

export interface StructuredLlmRequest {
  readonly prompt: string;
  readonly systemPrompt?: string;
}

export interface StructuredLlmServiceOptions {
  readonly client: OpenRouterClient;
  readonly modelId?: string;
  readonly timeoutMs?: number;
  readonly inputMaxCodeUnits?: number;
  readonly maxOutputTokens?: number;
}

export interface StructuredLlmService {
  request(input: StructuredLlmRequest): Promise<LlmEditResponse>;
  requestSummary(input: StructuredLlmRequest): Promise<SummaryResponse>;
  requestTagSuggestions(
    input: StructuredLlmRequest,
  ): Promise<TagSuggestionResponse>;
  requestTaskSuggestions(
    input: StructuredLlmRequest,
  ): Promise<TaskSuggestionResponse>;
}

function ensureSupportedModel(modelId: string): void {
  if (
    modelId !== LLM_MODEL_PROFILE.id ||
    !LLM_MODEL_PROFILE.structuredOutputs
  ) {
    throw new StructuredLlmError(
      503,
      "llm_model_unsupported",
      "Zvolený model není ověřený pro striktní strukturovaný výstup. AI úprava byla zablokována.",
    );
  }
}

function parseJsonBytes(
  bytes: Uint8Array,
  code: string,
  message: string,
): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

    return JSON.parse(text) as unknown;
  } catch {
    throw new StructuredLlmError(502, code, message);
  }
}

function readProviderContent(response: OpenRouterResponse): unknown {
  const envelope = chatCompletionResponseSchema.safeParse(
    parseJsonBytes(
      response.bytes,
      "llm_malformed_provider_response",
      "OpenRouter nevrátil čitelnou JSON odpověď.",
    ),
  );

  if (!envelope.success) {
    throw new StructuredLlmError(
      502,
      "llm_invalid_provider_response",
      "OpenRouter vrátil neočekávaný tvar odpovědi.",
    );
  }

  if (envelope.data.error !== undefined) {
    throw new StructuredLlmError(
      502,
      "llm_provider_error",
      "OpenRouter odmítl strukturovaný požadavek. Zkuste to znovu.",
    );
  }

  const choice = envelope.data.choices[0]!;

  if (choice.message.refusal?.trim()) {
    throw new StructuredLlmError(
      502,
      "llm_refused",
      "Model odmítl požadavek. Upravte zadání.",
    );
  }

  if (choice.finish_reason === "length") {
    throw new StructuredLlmError(
      502,
      "llm_truncated",
      "Model překročil limit výstupu. Zkuste kratší zadání.",
    );
  }

  if (
    typeof choice.message.content !== "string" ||
    choice.message.content.trim() === ""
  ) {
    throw new StructuredLlmError(
      502,
      "llm_empty_response",
      "Model nevrátil strukturovanou odpověď.",
    );
  }

  return parseJsonBytes(
    new TextEncoder().encode(choice.message.content),
    "llm_malformed_json",
    "Model nevrátil platný JSON. AI úprava nebyla vytvořena.",
  );
}

function parseProviderResponse(
  response: OpenRouterResponse,
): LlmEditResponse {
  const provider = llmProviderResponseSchema.safeParse(
    readProviderContent(response),
  );

  if (!provider.success) {
    throw new StructuredLlmError(
      502,
      "llm_schema_invalid",
      "Model vrátil data, která neodpovídají povolenému schématu. AI úprava nebyla vytvořena.",
      {
        issues: provider.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          code: issue.code,
        })),
      },
    );
  }

  const normalized: LlmEditResponse =
    provider.data.kind === "operation"
      ? {
          kind: "operation",
          operation: provider.data.operation!,
        }
      : {
          kind: "unclear",
          clarification: provider.data.clarification!,
        };
  const parsed = llmEditResponseSchema.safeParse(normalized);

  if (!parsed.success) {
    throw new StructuredLlmError(
      502,
      "llm_schema_invalid",
      "Model vrátil data, která neodpovídají povolenému schématu. AI úprava nebyla vytvořena.",
    );
  }

  return parsed.data;
}

function parseTagSuggestionProviderResponse(
  response: OpenRouterResponse,
): TagSuggestionResponse {
  const parsed = tagSuggestionResponseSchema.safeParse(
    readProviderContent(response),
  );

  if (!parsed.success) {
    throw new StructuredLlmError(
      502,
      "llm_schema_invalid",
      "Model nevrátil platný návrh tagů. Návrh nebyl přijat.",
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          code: issue.code,
        })),
      },
    );
  }

  return parsed.data;
}

function parseSummaryProviderResponse(
  response: OpenRouterResponse,
): SummaryResponse {
  const parsed = summaryResponseSchema.safeParse(readProviderContent(response));

  if (!parsed.success) {
    throw new StructuredLlmError(
      502,
      "llm_schema_invalid",
      "Model nevrátil platné shrnutí. Návrh nebyl přijat.",
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          code: issue.code,
        })),
      },
    );
  }

  return parsed.data;
}

function parseTaskSuggestionProviderResponse(
  response: OpenRouterResponse,
): TaskSuggestionResponse {
  const parsed = taskSuggestionResponseSchema.safeParse(
    readProviderContent(response),
  );

  if (!parsed.success) {
    throw new StructuredLlmError(
      502,
      "llm_schema_invalid",
      "Model nevrátil platný seznam úkolů. Návrh nebyl přijat.",
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          code: issue.code,
        })),
      },
    );
  }

  return parsed.data;
}

export function createStructuredLlmService(
  options: StructuredLlmServiceOptions,
): StructuredLlmService {
  const modelId = options.modelId ?? LLM_CANDIDATE_MODEL_ID;
  const timeoutMs = Math.max(
    1,
    Math.min(options.timeoutMs ?? LLM_TIMEOUT_MS, LLM_TIMEOUT_MS),
  );
  const inputMaxCodeUnits = Math.max(
    1,
    Math.min(
      options.inputMaxCodeUnits ?? LLM_INPUT_MAX_CODE_UNITS,
      LLM_INPUT_MAX_CODE_UNITS,
    ),
  );
  const maxOutputTokens = Math.max(
    1,
    Math.min(
      options.maxOutputTokens ?? LLM_MAX_OUTPUT_TOKENS,
      LLM_MAX_OUTPUT_TOKENS,
    ),
  );

  interface StructuredRequestConfig<T> {
    readonly label: string;
    readonly schemaName: string;
    readonly jsonSchema: unknown;
    readonly operation: string;
    readonly requestKind: string;
    readonly parse: (response: OpenRouterResponse) => T;
  }

  async function requestStructured<T>(
    input: StructuredLlmRequest,
    config: StructuredRequestConfig<T>,
  ): Promise<T> {
    ensureSupportedModel(modelId);

    const prompt = input.prompt.trim();
    const systemPrompt =
      input.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;

    if (prompt === "") {
      throw new StructuredLlmError(
        400,
        "llm_empty_prompt",
        `Zadání pro ${config.label} je prázdné.`,
      );
    }

    const inputCodeUnits = prompt.length + systemPrompt.length;

    if (inputCodeUnits > inputMaxCodeUnits) {
      throw new StructuredLlmError(
        422,
        "llm_input_too_large",
        `Zadání pro ${config.label} překračuje limit ${inputMaxCodeUnits.toLocaleString("cs-CZ")} znaků.`,
        { inputCodeUnits, inputMaxCodeUnits },
      );
    }

    const estimatedMaxCostUsd = estimateStructuredLlmMaxCostUsd(
      inputCodeUnits,
      maxOutputTokens,
    );

    if (estimatedMaxCostUsd > LLM_MAX_ESTIMATED_COST_USD) {
      throw new StructuredLlmError(
        422,
        "llm_cost_cap_exceeded",
        `Odhad ceny pro ${config.label} překračuje místní limit. Operace nebyla zahájena.`,
      );
    }

    let response: OpenRouterResponse;

    try {
      response = await options.client.request({
        path: "/chat/completions",
        body: {
          model: modelId,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          max_completion_tokens: maxOutputTokens,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: config.schemaName,
              strict: true,
              schema: config.jsonSchema,
            },
          },
          provider: { require_parameters: true },
        },
        operation: config.operation,
        model: modelId,
        estimatedMaxCostUsd,
        accept: "application/json",
        expectedContentType: "application/json",
        maxResponseBytes: LLM_RESPONSE_MAX_BYTES,
        timeoutMs,
        providerUsage: {
          requestKind: config.requestKind,
          schemaName: config.schemaName,
          inputCodeUnits,
          estimatedInputTokens:
            estimateStructuredLlmInputTokens(inputCodeUnits),
          maxOutputTokens,
          modelProfileCheckedAt: LLM_MODEL_PROFILE.checkedAt,
        },
      });
    } catch (error) {
      if (
        error instanceof OpenRouterHttpError ||
        error instanceof UsageServiceError
      ) {
        throw error;
      }

      throw new StructuredLlmError(
        502,
        "llm_request_failed",
        "Strukturovaný požadavek na OpenRouter se nepodařilo provést.",
      );
    }

    return config.parse(response);
  }

  return {
    request: (input) =>
      requestStructured(input, {
        label: "AI úpravu",
        schemaName: LLM_SCHEMA_NAME,
        jsonSchema: LLM_EDIT_JSON_SCHEMA,
        operation: LLM_OPERATION,
        requestKind: "structured_edit",
        parse: parseProviderResponse,
      }),
    requestSummary: (input) =>
      requestStructured(input, {
        label: "shrnutí",
        schemaName: SUMMARY_SCHEMA_NAME,
        jsonSchema: SUMMARY_JSON_SCHEMA,
        operation: SUMMARY_OPERATION,
        requestKind: "summary",
        parse: parseSummaryProviderResponse,
      }),
    requestTagSuggestions: (input) =>
      requestStructured(input, {
        label: "návrh tagů",
        schemaName: TAG_SUGGESTIONS_SCHEMA_NAME,
        jsonSchema: TAG_SUGGESTIONS_JSON_SCHEMA,
        operation: TAG_SUGGESTIONS_OPERATION,
        requestKind: "tag_suggestions",
        parse: parseTagSuggestionProviderResponse,
      }),
    requestTaskSuggestions: (input) =>
      requestStructured(input, {
        label: "extrakci úkolů",
        schemaName: TASK_SUGGESTIONS_SCHEMA_NAME,
        jsonSchema: TASK_SUGGESTIONS_JSON_SCHEMA,
        operation: TASK_SUGGESTIONS_OPERATION,
        requestKind: "task_suggestions",
        parse: parseTaskSuggestionProviderResponse,
      }),
  };
}

export function getStructuredLlmService(): StructuredLlmService {
  const config = loadConfig();

  ensureSupportedModel(config.openRouterLlmModel);

  return createStructuredLlmService({
    client: getOpenRouterClient(),
    modelId: config.openRouterLlmModel,
  });
}
