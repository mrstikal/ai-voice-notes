import { describe, expect, it, vi } from "vitest";

import {
  OpenRouterHttpError,
  type OpenRouterClient,
  type OpenRouterRequestOptions,
} from "../../src/lib/ai/openrouter";
import { BudgetExceededError } from "../../src/lib/ai/usage";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_ID,
  EmbeddingError,
  createEmbeddingService,
  estimateEmbeddingMaxCostUsd,
  getEmbeddingProviderStatus,
} from "../../src/lib/search/embeddings";

function vector(length = EMBEDDING_DIMENSIONS): number[] {
  return Array.from({ length }, (_, index) => (index + 1) / length);
}

function jsonResponse(body: unknown): {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly generationId: null;
  readonly status: number;
} {
  return {
    bytes: new TextEncoder().encode(JSON.stringify(body)),
    contentType: "application/json",
    generationId: null,
    status: 200,
  };
}

function validBody(options: {
  readonly count?: number;
  readonly cost?: number;
  readonly model?: string;
} = {}) {
  const count = options.count ?? 1;

  return {
    object: "list",
    model: options.model ?? EMBEDDING_MODEL_ID,
    data: Array.from({ length: count }, (_, index) => ({
      object: "embedding",
      index,
      embedding: vector(),
    })),
    usage: {
      prompt_tokens: 12 * count,
      total_tokens: 12 * count,
      ...(options.cost === undefined ? {} : { cost: options.cost }),
    },
  };
}

function fakeClient(
  response: unknown,
): {
  readonly client: Pick<OpenRouterClient, "request">;
  readonly request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async () => jsonResponse(response));

  return { client: { request } as Pick<OpenRouterClient, "request">, request };
}

describe("P36 OpenRouter embeddings adapter", () => {
  it("requests the frozen model, 1536 dimensions and float encoding", async () => {
    const { client, request } = fakeClient(validBody({ count: 2 }));
    const embeddings = createEmbeddingService({ client });

    const result = await embeddings.embed(["První text", "Druhý text"]);

    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).not.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);

    const options = request.mock.calls[0]![0] as OpenRouterRequestOptions;

    expect(options.path).toBe("/embeddings");
    expect(options.body).toEqual({
      model: EMBEDDING_MODEL_ID,
      dimensions: EMBEDDING_DIMENSIONS,
      encoding_format: "float",
      input: ["První text", "Druhý text"],
    });
    expect(options.operation).toBe("embedding_reindex");
    expect(options.model).toBe(EMBEDDING_MODEL_ID);
    expect(options.expectedContentType).toBe("application/json");
    expect(options.estimatedMaxCostUsd).toBeGreaterThan(0);
  });

  it("uses the semantic query operation and request kind when configured", async () => {
    const body = validBody();
    const { client, request } = fakeClient(body);
    const embeddings = createEmbeddingService({
      client,
      operation: "embedding_query",
      requestKind: "embedding_query",
    });

    await embeddings.embed(["migrace"]);
    const options = request.mock.calls[0]![0] as OpenRouterRequestOptions;
    const settlement = options.successSettlement?.(
      new TextEncoder().encode(JSON.stringify(body)),
    );

    expect(options.operation).toBe("embedding_query");
    expect(options.providerUsage?.requestKind).toBe("embedding_query");
    expect(settlement?.providerUsage?.requestKind).toBe("embedding_query");
  });

  it("preserves provider order by index and settles a reported cost", async () => {
    const body = validBody({ count: 2, cost: 0.000004 });
    body.data = [body.data[1]!, body.data[0]!];
    const { client, request } = fakeClient(body);
    const embeddings = createEmbeddingService({ client });

    const result = await embeddings.embed(["a", "b"]);
    const options = request.mock.calls[0]![0] as OpenRouterRequestOptions;
    const settlement = options.successSettlement?.(new Uint8Array());

    expect(result.vectors[0]?.[0]).toBeCloseTo(1 / EMBEDDING_DIMENSIONS);
    expect(result.vectors[1]?.[0]).toBeCloseTo(2 / EMBEDDING_DIMENSIONS);
    expect(options.successSettlement).toBeTypeOf("function");
    expect(settlement).toBeNull();
  });

  it("reports the provider cost from a successful response body", async () => {
    const body = validBody({ cost: 0.000004 });
    const { client, request } = fakeClient(body);
    const embeddings = createEmbeddingService({ client });

    await embeddings.embed(["a"]);
    const options = request.mock.calls[0]![0] as OpenRouterRequestOptions;
    const settlement = options.successSettlement?.(
      new TextEncoder().encode(JSON.stringify(body)),
    );

    expect(settlement?.reportedCostUsd).toBe(0.000004);
    expect(settlement?.providerUsage?.returnedModel).toBe(EMBEDDING_MODEL_ID);
  });

  it("keeps the charge unknown when the provider omits usage.cost", async () => {
    const body = validBody({ cost: undefined });
    const { client, request } = fakeClient(body);
    const embeddings = createEmbeddingService({ client });

    await embeddings.embed(["a"]);
    const options = request.mock.calls[0]![0] as OpenRouterRequestOptions;
    const settlement = options.successSettlement?.(
      new TextEncoder().encode(JSON.stringify(body)),
    );

    expect(settlement?.reportedCostUsd).toBeNull();
    expect(settlement?.providerUsage?.promptTokens).toBe(12);
  });

  it("rejects a wrong vector length", async () => {
    const body = validBody();
    body.data[0]!.embedding = vector(EMBEDDING_DIMENSIONS - 1);
    const { client } = fakeClient(body);
    const embeddings = createEmbeddingService({ client });

    await expect(embeddings.embed(["a"])).rejects.toMatchObject({
      code: "embedding_dimension_mismatch",
      status: 502,
    });
  });

  it("rejects a non-finite vector value even when JSON is syntactically valid", async () => {
    const { client } = fakeClient({});
    const request = vi.fn(async () => ({
      bytes: new TextEncoder().encode(
        `{"model":"${EMBEDDING_MODEL_ID}","data":[{"index":0,"embedding":[1e999,${vector()
          .slice(1)
          .join(",")}]}]}`,
      ),
      contentType: "application/json",
      generationId: null,
      status: 200,
    }));

    client.request = request as unknown as OpenRouterClient["request"];
    const embeddings = createEmbeddingService({ client });

    await expect(embeddings.embed(["a"])).rejects.toMatchObject({
      code: "embedding_invalid_vector",
      status: 502,
    });
  });

  it("rejects null vector entries", async () => {
    const body = validBody();
    (body.data[0]!.embedding as unknown[])[4] = null;
    const { client } = fakeClient(body);
    const embeddings = createEmbeddingService({ client });

    await expect(embeddings.embed(["a"])).rejects.toMatchObject({
      code: "embedding_invalid_vector",
    });
  });

  it("accepts the documented upstream short model name for the requested model", async () => {
    const { client } = fakeClient(
      validBody({ model: "text-embedding-3-small" }),
    );
    const embeddings = createEmbeddingService({ client });

    const result = await embeddings.embed(["a"]);

    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("rejects a different returned model instead of trusting its dimension", async () => {
    const body = validBody({ model: "other/embedding-model" });
    const { client } = fakeClient(body);
    const embeddings = createEmbeddingService({ client });

    await expect(embeddings.embed(["a"])).rejects.toMatchObject({
      code: "embedding_contract_rejected",
      details: { returnedModel: "other/embedding-model" },
    });
  });

  it("rejects a missing vector for one of the inputs", async () => {
    const { client } = fakeClient(validBody({ count: 1 }));
    const embeddings = createEmbeddingService({ client });

    await expect(embeddings.embed(["a", "b"])).rejects.toMatchObject({
      code: "embedding_invalid_provider_response",
    });
  });

  it("maps a provider contract rejection to a blocking error", async () => {
    const { client } = fakeClient({});
    client.request = vi.fn(async () => {
      throw new OpenRouterHttpError(
        502,
        "openrouter_error",
        "OpenRouter požadavek odmítl.",
        400,
      );
    }) as unknown as OpenRouterClient["request"];
    const embeddings = createEmbeddingService({ client });

    await expect(embeddings.embed(["a"])).rejects.toMatchObject({
      code: "embedding_contract_rejected",
      details: { providerStatus: 400 },
    });
  });

  it("propagates a P12 budget denial instead of hiding it as a provider error", async () => {
    const { client } = fakeClient({});
    client.request = vi.fn(async () => {
      throw new BudgetExceededError({
        budgetUsd: "2.000000",
        committedUsd: "2.000000",
        requestedUsd: "0.000001",
      });
    }) as unknown as OpenRouterClient["request"];
    const embeddings = createEmbeddingService({ client });

    await expect(embeddings.embed(["a"])).rejects.toMatchObject({
      status: 402,
      code: "budget_exceeded",
    });
  });

  it("rejects empty input, empty text and an oversized batch without a provider call", async () => {
    const { client, request } = fakeClient(validBody());
    const embeddings = createEmbeddingService({ client });

    await expect(embeddings.embed([])).rejects.toBeInstanceOf(EmbeddingError);
    await expect(embeddings.embed(["   "])).rejects.toMatchObject({
      code: "embedding_empty_input",
    });
    await expect(
      embeddings.embed(Array.from({ length: 21 }, () => "text")),
    ).rejects.toMatchObject({ code: "embedding_batch_too_large" });
    expect(request).not.toHaveBeenCalled();
  });

  it("blocks a model other than the frozen embedding model", () => {
    expect(() =>
      createEmbeddingService({
        client: { request: vi.fn() } as unknown as Pick<OpenRouterClient, "request">,
        modelId: "other/model",
      }),
    ).toThrow(EmbeddingError);
  });

  it("estimates a positive conservative cost that grows with input size", () => {
    const small = estimateEmbeddingMaxCostUsd(["krátký text"]);
    const large = estimateEmbeddingMaxCostUsd(
      Array.from({ length: 20 }, () => "delší český text ".repeat(200)),
    );

    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThan(1);
  });

  it("reports a Czech blocked reason without a provider key", () => {
    const status = getEmbeddingProviderStatus();

    expect(status.model).toBe(EMBEDDING_MODEL_ID);
    expect(status.dimensions).toBe(1536);
    expect(status.configured).toBe(false);
    expect(status.blockedReason).toMatch(/OpenRouter API klíč/u);
  });
});
