import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST as askRoute } from "@/app/api/ask/route";
import {
  GROUNDING_LLM_MAX_COST_USD,
  GroundingError,
} from "@/lib/search/grounding";

const APP_ORIGIN = "http://127.0.0.1:3000";
const fakeDb = {};

const askMock = vi.hoisted(() => vi.fn());
const getGroundingLlmMock = vi.hoisted(() => vi.fn());
const getEmbeddingServiceMock = vi.hoisted(() => vi.fn());
const getReindexStatusMock = vi.hoisted(() => vi.fn());
const llmStatusMock = vi.hoisted(() => vi.fn());
const embeddingStatusMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  getDb: () => fakeDb,
}));

vi.mock("@/lib/search/reindex", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/search/reindex")>();

  return { ...actual, getReindexStatus: getReindexStatusMock };
});

vi.mock("@/lib/search/embeddings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/search/embeddings")>();

  return {
    ...actual,
    getEmbeddingProviderStatus: embeddingStatusMock,
    getEmbeddingService: getEmbeddingServiceMock,
  };
});

vi.mock("@/lib/search/grounding", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/search/grounding")>();

  return {
    ...actual,
    askGroundedQuestion: askMock,
    getGroundingLlm: getGroundingLlmMock,
  };
});

vi.mock("@/lib/ai/structured", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/ai/structured")>();

  return { ...actual, getLlmProviderStatus: llmStatusMock };
});

const configuredLlm = {
  configured: true,
  model: "deepseek/deepseek-v4.1-flash-1017",
  structuredOutputs: true,
  liveStatus: "verified",
  maxInputCodeUnits: 12_000,
  maxOutputTokens: 1_200,
  timeoutMs: 20_000,
  estimatedMaxCostUsd: 0.02,
  checkedAt: "2026-10-27",
  blockedReason: null,
} as const;

const readyIndex = {
  notes: { total: 1, ready: 1, pending: 0, error: 0, noContent: 0 },
  chunks: { current: 1, ready: 1, pending: 0, error: 0 },
} as const;

const textOnlyIndex = {
  notes: { total: 1, ready: 0, pending: 1, error: 0, noContent: 0 },
  chunks: { current: 1, ready: 0, pending: 1, error: 0 },
} as const;

const answered = {
  status: "answered",
  answer: "Migrace je v sobotu.",
  retrieval: "text_only",
  claims: [
    {
      text: "Migrace je v sobotu.",
      citations: [
        {
          noteId: "11111111-1111-4111-8111-111111111111",
          chunkId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          noteTitle: "Migrace",
          noteVersion: 1,
        },
      ],
    },
  ],
  sources: [],
  cost: {
    approvedMaxCostUsd: 0.021,
    queryEmbeddingUsd: 0,
    llmUsd: 0.0001,
    totalEstimatedUsd: 0.0001,
  },
  manualFactualReview: "required",
} as const;

const insufficient = {
  ...answered,
  status: "insufficient_evidence",
  answer: "V poznámkách jsem pro tuto odpověď nenašel dostatek podkladů.",
  claims: [],
  sources: [],
  cost: {
    approvedMaxCostUsd: 0.02,
    queryEmbeddingUsd: 0,
    llmUsd: 0,
    totalEstimatedUsd: 0,
  },
} as const;

function postRequest(body: unknown): Request {
  return new Request(`${APP_ORIGIN}/api/ask`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: APP_ORIGIN,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("P39 ask API", () => {
  beforeEach(() => {

    askMock.mockReset();
    getGroundingLlmMock.mockReset();
    getEmbeddingServiceMock.mockReset();
    getReindexStatusMock.mockReset();
    llmStatusMock.mockReset();
    embeddingStatusMock.mockReset();

    llmStatusMock.mockReturnValue(configuredLlm);
    embeddingStatusMock.mockReturnValue({
      configured: true,
      model: "openai/text-embedding-3-small",
      dimensions: 1536,
      liveStatus: "verified",
      maxBatchTexts: 20,
      timeoutMs: 60_000,
      checkedAt: "2026-10-28",
      blockedReason: null,
    });
    getReindexStatusMock.mockResolvedValue(readyIndex);
    getEmbeddingServiceMock.mockReturnValue({
      embed: vi.fn(),
    });
    getGroundingLlmMock.mockReturnValue({ request: vi.fn() });
    askMock.mockResolvedValue(answered);
  });

  it("requires explicit cost approval and passes both paid services", async () => {
    const response = await askRoute(
      postRequest({
        question: "Kdy je migrace?",
        confirmCost: true,
        approvedMaxCostUsd: 0.021,
      }),
    );

    expect(response.status).toBe(200);
    expect(getEmbeddingServiceMock).toHaveBeenCalledWith({
      operation: "embedding_query",
      requestKind: "embedding_query",
    });
    expect(askMock).toHaveBeenCalledWith(
      {
        db: fakeDb,
        embedder: { embed: expect.any(Function) },
        llm: { request: expect.any(Function) },
        semanticAvailable: true,
      },
      {
        question: "Kdy je migrace?",
        approvedMaxCostUsd: 0.021,
      },
    );

    const body = (await response.json()) as {
      approvalCeilingUsd: number;
      status: string;
    };

    expect(body.status).toBe("answered");
    expect(body.approvalCeilingUsd).toBeGreaterThan(
      GROUNDING_LLM_MAX_COST_USD,
    );
    expect(body.approvalCeilingUsd).toBeLessThan(
      GROUNDING_LLM_MAX_COST_USD + 0.001,
    );
  });

  it("uses text-only retrieval without an embedder when no vectors are ready", async () => {
    getReindexStatusMock.mockResolvedValue(textOnlyIndex);

    const response = await askRoute(
      postRequest({
        question: "Kdy je migrace?",
        confirmCost: true,
        approvedMaxCostUsd: 0.021,
      }),
    );

    expect(response.status).toBe(200);
    expect(getEmbeddingServiceMock).not.toHaveBeenCalled();
    expect(askMock).toHaveBeenCalledWith(
      expect.objectContaining({
        embedder: null,
        semanticAvailable: false,
      }),
      expect.anything(),
    );
  });

  it("falls back to text-only retrieval when the embedding provider is blocked", async () => {
    embeddingStatusMock.mockReturnValue({
      configured: false,
      model: "openai/text-embedding-3-small",
      dimensions: 1536,
      liveStatus: "verified",
      maxBatchTexts: 20,
      timeoutMs: 60_000,
      checkedAt: "2026-10-28",
      blockedReason: "Embedding model není nakonfigurovaný.",
    });

    const response = await askRoute(
      postRequest({
        question: "Kdy je migrace?",
        confirmCost: true,
        approvedMaxCostUsd: 0.021,
      }),
    );

    expect(response.status).toBe(200);
    expect(getEmbeddingServiceMock).not.toHaveBeenCalled();
    expect(askMock).toHaveBeenCalledWith(
      expect.objectContaining({
        embedder: null,
        semanticAvailable: false,
      }),
      expect.anything(),
    );
  });

  it("makes no service call without confirmation or with a lower approval", async () => {
    const unconfirmed = await askRoute(
      postRequest({
        question: "Kdy je migrace?",
        confirmCost: false,
      }),
    );

    expect(unconfirmed.status).toBe(400);
    expect(await unconfirmed.json()).toMatchObject({
      error: { code: "ask_cost_not_confirmed" },
    });

    const underApproved = await askRoute(
      postRequest({
        question: "Kdy je migrace?",
        confirmCost: true,
        approvedMaxCostUsd: 0,
      }),
    );

    expect(underApproved.status).toBe(409);
    expect(await underApproved.json()).toMatchObject({
      error: { code: "ask_cost_not_approved" },
    });
    expect(askMock).not.toHaveBeenCalled();
    expect(getEmbeddingServiceMock).not.toHaveBeenCalled();
  });

  it("blocks with a Czech state when the LLM is not configured", async () => {
    llmStatusMock.mockReturnValue({
      ...configuredLlm,
      configured: false,
      blockedReason: "OpenRouter API klíč není nakonfigurovaný.",
    });

    const response = await askRoute(
      postRequest({
        question: "Kdy je migrace?",
        confirmCost: true,
        approvedMaxCostUsd: 0.021,
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: {
        code: "grounding_not_configured",
        message: "OpenRouter API klíč není nakonfigurovaný.",
      },
    });
    expect(askMock).not.toHaveBeenCalled();
  });

  it("rejects an empty or overlong question without a service call", async () => {
    const empty = await askRoute(
      postRequest({ question: "   ", confirmCost: true, approvedMaxCostUsd: 1 }),
    );

    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({
      error: { code: "ask_question_empty" },
    });

    const long = await askRoute(
      postRequest({
        question: "a".repeat(301),
        confirmCost: true,
        approvedMaxCostUsd: 1,
      }),
    );

    expect(long.status).toBe(400);
    expect(await long.json()).toMatchObject({
      error: { code: "ask_question_too_long" },
    });
    expect(askMock).not.toHaveBeenCalled();
  });

  it("returns the exact insufficient-evidence answer as a valid state", async () => {
    askMock.mockResolvedValue(insufficient);

    const response = await askRoute(
      postRequest({
        question: "Kdy je migrace?",
        confirmCost: true,
        approvedMaxCostUsd: 0.021,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "insufficient_evidence",
      answer: "V poznámkách jsem pro tuto odpověď nenašel dostatek podkladů.",
      claims: [],
      sources: [],
    });
  });

  it("maps grounding and provider failures without returning an answer", async () => {
    askMock.mockRejectedValue(
      new GroundingError(
        409,
        "grounding_sources_stale",
        "Poznámky se během odpovědi změnily. Položte otázku znovu.",
      ),
    );

    const response = await askRoute(
      postRequest({
        question: "Kdy je migrace?",
        confirmCost: true,
        approvedMaxCostUsd: 0.021,
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "grounding_sources_stale" },
    });
  });
});
