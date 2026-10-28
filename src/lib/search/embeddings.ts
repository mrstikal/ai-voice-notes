import { z } from "zod";

import {
  OpenRouterHttpError,
  getOpenRouterClient,
  type OpenRouterClient,
  type OpenRouterResponse,
} from "../ai/openrouter.ts";
import { UsageServiceError } from "../ai/usage.ts";
import { loadConfig } from "../config.ts";
import { countCl100kTokens } from "./chunking.ts";

export const EMBEDDING_MODEL_ID = "openai/text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
export const EMBEDDING_OPERATION = "embedding_reindex";
export const EMBEDDING_BATCH_MAX_TEXTS = 20;
export const EMBEDDING_TEXT_MAX_CODE_UNITS = 8_000;
export const EMBEDDING_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const EMBEDDING_TIMEOUT_MS = 60_000;
export const EMBEDDING_MIN_ESTIMATE_USD = 0.000001;
export const EMBEDDING_USD_PER_TOKEN = 0.00000002;
export const EMBEDDING_ESTIMATE_MARGIN = 1.25;
export const EMBEDDING_LIVE_VERIFIED = true;
export const EMBEDDING_CHECKED_AT = "2026-10-28";

export class EmbeddingError extends Error {
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
    this.name = "EmbeddingError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface EmbeddingProviderStatus {
  readonly configured: boolean;
  readonly model: string;
  readonly dimensions: number;
  readonly liveStatus: "live_unverified" | "verified";
  readonly maxBatchTexts: number;
  readonly timeoutMs: number;
  readonly checkedAt: string;
  readonly blockedReason: string | null;
}

export interface EmbeddingResult {
  readonly model: string;
  readonly vectors: readonly (readonly number[])[];
  readonly promptTokens: number | null;
}

export interface EmbeddingService {
  embed(texts: readonly string[]): Promise<EmbeddingResult>;
}

const embeddingResponseSchema = z
  .object({
    model: z.string(),
    data: z
      .array(
        z
          .object({
            embedding: z.unknown(),
            index: z.number().int().nonnegative().optional(),
          })
          .passthrough(),
      )
      .min(1),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional(),
        cost: z.number().finite().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function isSupportedModel(modelId: string): boolean {
  return modelId === EMBEDDING_MODEL_ID;
}

export function getEmbeddingProviderStatus(): EmbeddingProviderStatus {
  const config = loadConfig();
  const model = config.openRouterEmbeddingModel;
  const supported = isSupportedModel(model);
  const blockedReason = !config.openRouterApiKey
    ? "OpenRouter API klíč není nakonfigurovaný. Semantické indexování zůstává vypnuté."
    : !supported
      ? "Zvolený model embeddings není ověřený pro 1536 dimenzí. Změna modelu vyžaduje novou migraci a schválený preflight."
      : null;

  return {
    configured: blockedReason === null,
    model,
    dimensions: EMBEDDING_DIMENSIONS,
    liveStatus: EMBEDDING_LIVE_VERIFIED ? "verified" : "live_unverified",
    maxBatchTexts: EMBEDDING_BATCH_MAX_TEXTS,
    timeoutMs: EMBEDDING_TIMEOUT_MS,
    checkedAt: EMBEDDING_CHECKED_AT,
    blockedReason,
  };
}

export function estimateEmbeddingMaxCostUsd(
  texts: readonly string[],
): number {
  const tokens = texts.reduce(
    (total, text) => total + countCl100kTokens(text),
    0,
  );
  const boundedTokens = Math.ceil(
    Math.max(tokens, 1) * EMBEDDING_ESTIMATE_MARGIN,
  );
  const estimate = Math.ceil(boundedTokens * EMBEDDING_USD_PER_TOKEN * 1e6) / 1e6;

  return Math.max(estimate, EMBEDDING_MIN_ESTIMATE_USD);
}

function readEmbeddingSettlement(
  bytes: Uint8Array,
): { reportedCostUsd: number | null; providerUsage: Record<string, unknown> } | null {
  let parsed: unknown;

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }

  const response = embeddingResponseSchema.safeParse(parsed);

  if (!response.success) {
    return null;
  }

  const usage = response.data.usage;
  const promptTokens =
    usage?.prompt_tokens ?? usage?.total_tokens ?? null;
  const reportedCostUsd = usage?.cost ?? null;

  return {
    reportedCostUsd,
    providerUsage: {
      requestKind: "embedding_reindex",
      dimensions: EMBEDDING_DIMENSIONS,
      encodingFormat: "float",
      returnedModel: response.data.model,
      promptTokens,
      reportedCostUsd,
    },
  };
}

function modelMatches(returned: string, requested: string): boolean {
  if (returned === requested) {
    return true;
  }

  const shortName = requested.split("/").at(-1);

  return shortName !== undefined && shortName !== "" && returned === shortName;
}

function parseEmbeddingResponse(
  response: OpenRouterResponse,
  expectedCount: number,
  modelId: string,
): EmbeddingResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(response.bytes),
    ) as unknown;
  } catch {
    throw new EmbeddingError(
      502,
      "embedding_invalid_provider_response",
      "OpenRouter nevrátil čitelnou odpověď embeddings.",
    );
  }

  const body = embeddingResponseSchema.safeParse(parsed);

  if (!body.success) {
    throw new EmbeddingError(
      502,
      "embedding_invalid_provider_response",
      "OpenRouter vrátil neočekávaný tvar odpovědi embeddings.",
    );
  }

  if (!modelMatches(body.data.model, modelId)) {
    throw new EmbeddingError(
      502,
      "embedding_contract_rejected",
      "OpenRouter použil jiný model embeddings, než byl schválený. Indexování bylo zablokováno.",
      { returnedModel: body.data.model, requestedModel: modelId },
    );
  }

  if (body.data.data.length !== expectedCount) {
    throw new EmbeddingError(
      502,
      "embedding_invalid_provider_response",
      "OpenRouter nevrátil vektor pro každý vstup. Indexování bylo zablokováno.",
      { expectedCount, returnedCount: body.data.data.length },
    );
  }

  const seen = new Set<number>();
  const ordered: (readonly number[])[] = new Array(expectedCount);

  for (const [position, item] of body.data.data.entries()) {
    const index = item.index ?? position;

    if (index < 0 || index >= expectedCount || seen.has(index)) {
      throw new EmbeddingError(
        502,
        "embedding_invalid_provider_response",
        "OpenRouter vrátil neplatné pořadí vektorů. Indexování bylo zablokováno.",
      );
    }

    seen.add(index);

    if (!Array.isArray(item.embedding)) {
      throw new EmbeddingError(
        502,
        "embedding_invalid_vector",
        "OpenRouter nevrátil číselný vektor embeddings.",
        { index },
      );
    }

    if (item.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new EmbeddingError(
        502,
        "embedding_dimension_mismatch",
        `OpenRouter vrátil vektor o ${item.embedding.length} dimenzích místo ${EMBEDDING_DIMENSIONS}. Indexování bylo zablokováno.`,
        {
          index,
          expectedDimensions: EMBEDDING_DIMENSIONS,
          returnedDimensions: item.embedding.length,
        },
      );
    }

    const vector: number[] = [];

    for (const value of item.embedding) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new EmbeddingError(
          502,
          "embedding_invalid_vector",
          "OpenRouter vrátil vektor s neplatnou číselnou hodnotou. Indexování bylo zablokováno.",
          { index },
        );
      }

      if (Object.is(value, -0)) {
        vector.push(0);
      } else {
        vector.push(value);
      }
    }

    ordered[index] = vector;
  }

  return {
    model: body.data.model,
    vectors: ordered,
    promptTokens:
      body.data.usage?.prompt_tokens ??
      body.data.usage?.total_tokens ??
      null,
  };
}

function toEmbeddingError(error: unknown): EmbeddingError {
  if (error instanceof EmbeddingError) {
    return error;
  }

  if (error instanceof OpenRouterHttpError) {
    if (
      error.providerStatus === 400 ||
      error.providerStatus === 403 ||
      error.providerStatus === 404
    ) {
      return new EmbeddingError(
        502,
        "embedding_contract_rejected",
        "OpenRouter odmítl smlouvu embeddings (model, dimensions=1536 nebo encoding_format=float). Semantické indexování je zablokované; databázová dimenze se nemění.",
        {
          providerStatus: error.providerStatus,
          providerCode: error.code,
        },
      );
    }

    return new EmbeddingError(error.status, error.code, error.message, {
      providerStatus: error.providerStatus,
    });
  }

  return new EmbeddingError(
    502,
    "embedding_request_failed",
    "Požadavek na embeddings se nepodařilo provést.",
  );
}

export function createEmbeddingService(options: {
  readonly client: Pick<OpenRouterClient, "request">;
  readonly modelId?: string;
}): EmbeddingService {
  const modelId = options.modelId ?? EMBEDDING_MODEL_ID;

  if (!isSupportedModel(modelId)) {
    throw new EmbeddingError(
      503,
      "embedding_model_unsupported",
      "Zvolený model embeddings není ověřený pro 1536 dimenzí. Indexování bylo zablokováno.",
    );
  }

  return {
    async embed(texts) {
      if (texts.length === 0) {
        throw new EmbeddingError(
          400,
          "embedding_empty_input",
          "Pro embeddings chybí vstupní text.",
        );
      }

      if (texts.length > EMBEDDING_BATCH_MAX_TEXTS) {
        throw new EmbeddingError(
          422,
          "embedding_batch_too_large",
          `Jeden požadavek může obsahovat nejvýše ${EMBEDDING_BATCH_MAX_TEXTS} textů.`,
          { count: texts.length, max: EMBEDDING_BATCH_MAX_TEXTS },
        );
      }

      for (const text of texts) {
        if (text.trim() === "") {
          throw new EmbeddingError(
            400,
            "embedding_empty_input",
            "Embeddings nelze vytvořit pro prázdný text.",
          );
        }

        if (text.length > EMBEDDING_TEXT_MAX_CODE_UNITS) {
          throw new EmbeddingError(
            422,
            "embedding_text_too_large",
            `Jeden text pro embeddings překračuje limit ${EMBEDDING_TEXT_MAX_CODE_UNITS} znaků.`,
            { length: text.length, max: EMBEDDING_TEXT_MAX_CODE_UNITS },
          );
        }
      }

      const estimatedMaxCostUsd = estimateEmbeddingMaxCostUsd(texts);

      try {
        const response = await options.client.request({
          path: "/embeddings",
          body: {
            model: modelId,
            dimensions: EMBEDDING_DIMENSIONS,
            encoding_format: "float",
            input: [...texts],
          },
          operation: EMBEDDING_OPERATION,
          model: modelId,
          estimatedMaxCostUsd,
          accept: "application/json",
          expectedContentType: "application/json",
          maxResponseBytes: EMBEDDING_RESPONSE_MAX_BYTES,
          timeoutMs: EMBEDDING_TIMEOUT_MS,
          providerUsage: {
            requestKind: "embedding_reindex",
            inputCount: texts.length,
            inputCodeUnits: texts.reduce(
              (total, text) => total + text.length,
              0,
            ),
            dimensions: EMBEDDING_DIMENSIONS,
            encodingFormat: "float",
            estimatedMaxCostUsd,
          },
          successSettlement: (bytes) => readEmbeddingSettlement(bytes),
        });

        return parseEmbeddingResponse(response, texts.length, modelId);
      } catch (error) {
        if (error instanceof UsageServiceError) {
          throw error;
        }

        throw toEmbeddingError(error);
      }
    },
  };
}

export function getEmbeddingService(): EmbeddingService {
  return createEmbeddingService({
    client: getOpenRouterClient(),
  });
}
