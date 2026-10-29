import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  GET as searchGetRoute,
  POST as searchPostRoute,
} from "@/app/api/search/route";
import { EmbeddingError } from "@/lib/search/embeddings";

const APP_ORIGIN = "http://127.0.0.1:3000";
const fakeDb = {};

const embedMock = vi.hoisted(() => vi.fn());
const searchMock = vi.hoisted(() => vi.fn());
const fullTextMock = vi.hoisted(() => vi.fn());
const providerStatusMock = vi.hoisted(() => vi.fn());
const reindexStatusMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  getDb: () => fakeDb,
}));

vi.mock("@/lib/search/fts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/search/fts")>();

  return {
    ...actual,
    searchNotesFullText: fullTextMock,
  };
});

vi.mock("@/lib/search/embeddings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/search/embeddings")>();

  return {
    ...actual,
    getEmbeddingProviderStatus: providerStatusMock,
    getEmbeddingService: () => ({ embed: embedMock }),
  };
});

vi.mock("@/lib/search/reindex", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/search/reindex")>();

  return {
    ...actual,
    getReindexStatus: reindexStatusMock,
  };
});

vi.mock("@/lib/search/semantic", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/search/semantic")>();

  return {
    ...actual,
    searchNotesSemantic: searchMock,
  };
});

const configuredProvider = {
  configured: true,
  model: "openai/text-embedding-3-small",
  dimensions: 1536,
  liveStatus: "verified",
  maxBatchTexts: 20,
  timeoutMs: 60_000,
  checkedAt: "2026-10-28",
  blockedReason: null,
} as const;

const readyIndex = {
  notes: { total: 3, ready: 3, pending: 2, error: 1, noContent: 0 },
  chunks: { current: 8, ready: 5, pending: 2, error: 1 },
} as const;

function vector(): number[] {
  return Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
}

function postRequest(body: unknown): Request {
  return new Request(`${APP_ORIGIN}/api/search`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: APP_ORIGIN,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function getRequest(path: string): Request {
  return new Request(`${APP_ORIGIN}/api/search${path}`, {
    headers: {
      host: "127.0.0.1:3000",
      origin: APP_ORIGIN,
    },
  });
}

describe("P37 semantic search API", () => {
  beforeEach(() => {
    embedMock.mockReset();
    searchMock.mockReset();
    fullTextMock.mockReset();
    providerStatusMock.mockReset();
    reindexStatusMock.mockReset();

    providerStatusMock.mockReturnValue(configuredProvider);
    reindexStatusMock.mockResolvedValue(readyIndex);
    embedMock.mockResolvedValue({
      model: "openai/text-embedding-3-small",
      vectors: [vector()],
      promptTokens: 5,
    });
    searchMock.mockResolvedValue({
      query: "migrace",
      page: 1,
      pageSize: 10,
      total: 1,
      hasNext: false,
      model: "openai/text-embedding-3-small",
      items: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          title: "Migrace",
          category: null,
          tags: [],
          excerpt: "Text o migraci.",
          updatedAt: new Date("2026-10-28T12:00:00.000Z"),
        },
      ],
    });
  });

  it("embeds a confirmed bounded query exactly once and composes index info", async () => {
    const response = await searchPostRoute(
      postRequest({
        mode: "semantic",
        q: "  migrace  ",
        confirmCost: true,
        approvedMaxCostUsd: 0.0001,
      }),
    );

    expect(response.status).toBe(200);
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(embedMock).toHaveBeenCalledWith(["migrace"]);
    expect(searchMock).toHaveBeenCalledWith(fakeDb, {
      query: "migrace",
      page: 1,
      vector: vector(),
      modelId: "openai/text-embedding-3-small",
    });

    const body = (await response.json()) as {
      estimatedMaxCostUsd: number;
      index: Record<string, number>;
      items: unknown[];
    };

    expect(body.items).toHaveLength(1);
    expect(body.estimatedMaxCostUsd).toBeGreaterThan(0);
    expect(body.index).toEqual({
      readyNotes: 3,
      readyChunks: 5,
      pendingNotes: 2,
      errorNotes: 1,
      noContentNotes: 0,
    });
  });

  it("makes no billable call for GET, an unconfirmed POST or an under-approved POST", async () => {
    const getResponse = await searchGetRoute(
      getRequest("?mode=semantic&q=migrace"),
    );

    expect(getResponse.status).toBe(400);
    expect(await getResponse.json()).toMatchObject({
      error: { code: "semantic_requires_post" },
    });

    const hybridGet = await searchGetRoute(
      getRequest("?mode=hybrid&q=migrace"),
    );

    expect(hybridGet.status).toBe(400);
    expect(await hybridGet.json()).toMatchObject({
      error: { code: "hybrid_requires_post" },
    });

    const unconfirmed = await searchPostRoute(
      postRequest({
        mode: "semantic",
        q: "migrace",
        confirmCost: false,
      }),
    );

    expect(unconfirmed.status).toBe(400);
    expect(await unconfirmed.json()).toMatchObject({
      error: { code: "semantic_cost_not_confirmed" },
    });

    const underApproved = await searchPostRoute(
      postRequest({
        mode: "semantic",
        q: "migrace",
        confirmCost: true,
        approvedMaxCostUsd: 0,
      }),
    );

    expect(underApproved.status).toBe(409);
    expect(await underApproved.json()).toMatchObject({
      error: { code: "semantic_cost_not_approved" },
    });
    expect(embedMock).not.toHaveBeenCalled();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("returns an empty query state without embedding or a fake success", async () => {
    const response = await searchPostRoute(
      postRequest({
        mode: "semantic",
        q: "   ",
        confirmCost: true,
        approvedMaxCostUsd: 0.0001,
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "semantic_query_empty" },
    });
    expect(embedMock).not.toHaveBeenCalled();
  });

  it("reports an empty index distinctly and skips the paid call", async () => {
    reindexStatusMock.mockResolvedValue({
      notes: { total: 1, ready: 0, pending: 1, error: 0, noContent: 0 },
      chunks: { current: 1, ready: 0, pending: 1, error: 0 },
    });

    const response = await searchPostRoute(
      postRequest({
        mode: "semantic",
        q: "migrace",
        confirmCost: true,
        approvedMaxCostUsd: 0.0001,
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "semantic_index_empty" },
    });
    expect(embedMock).not.toHaveBeenCalled();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("keeps full-text search usable when the provider is missing", async () => {
    providerStatusMock.mockReturnValue({
      ...configuredProvider,
      configured: false,
      blockedReason: "OpenRouter API klíč není nakonfigurovaný.",
    });
    fullTextMock.mockResolvedValue({
      query: "migrace",
      page: 1,
      pageSize: 10,
      total: 0,
      hasNext: false,
      empty: false,
      items: [],
    });

    const semantic = await searchPostRoute(
      postRequest({
        mode: "semantic",
        q: "migrace",
        confirmCost: true,
        approvedMaxCostUsd: 0.0001,
      }),
    );

    expect(semantic.status).toBe(503);
    expect(await semantic.json()).toMatchObject({
      error: {
        code: "embedding_not_configured",
        message: "OpenRouter API klíč není nakonfigurovaný.",
      },
    });
    expect(embedMock).not.toHaveBeenCalled();

    const fulltext = await searchGetRoute(
      getRequest("?mode=fulltext&q=migrace"),
    );

    expect(fulltext.status).toBe(200);
    expect(fullTextMock).toHaveBeenCalledWith(fakeDb, {
      page: 1,
      query: "migrace",
    });
  });

  it("fuses top text and semantic notes once with component ranks", async () => {
    const noteA = "11111111-1111-4111-8111-111111111111";
    const noteB = "22222222-2222-4222-8222-222222222222";
    const noteC = "33333333-3333-4333-8333-333333333333";
    const updatedAt = new Date("2026-10-28T12:00:00.000Z");

    fullTextMock.mockResolvedValue({
      query: "migrace",
      page: 1,
      pageSize: 10,
      total: 2,
      hasNext: false,
      empty: false,
      items: [
        {
          id: noteA,
          title: "Textová A",
          category: null,
          tags: [],
          snippet: "Text [[[migrace]]] A",
          updatedAt,
        },
        {
          id: noteB,
          title: "Textová B",
          category: null,
          tags: [],
          snippet: "Text B",
          updatedAt,
        },
      ],
    });
    searchMock.mockResolvedValue({
      query: "migrace",
      page: 1,
      pageSize: 10,
      total: 2,
      hasNext: false,
      model: "openai/text-embedding-3-small",
      items: [
        {
          id: noteA,
          title: "Významová A",
          category: null,
          tags: [],
          excerpt: "Význam A",
          updatedAt,
        },
        {
          id: noteC,
          title: "Významová C",
          category: null,
          tags: [],
          excerpt: "Význam C",
          updatedAt,
        },
      ],
    });

    const response = await searchPostRoute(
      postRequest({
        mode: "hybrid",
        q: "migrace",
        confirmCost: true,
        approvedMaxCostUsd: 0.0005,
      }),
    );

    expect(response.status).toBe(200);
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(embedMock).toHaveBeenCalledWith(["migrace"]);
    expect(fullTextMock).toHaveBeenCalledWith(fakeDb, {
      page: 1,
      query: "migrace",
    });
    expect(searchMock).toHaveBeenCalledWith(fakeDb, {
      query: "migrace",
      page: 1,
      vector: vector(),
      modelId: "openai/text-embedding-3-small",
    });

    const body = (await response.json()) as {
      mode: string;
      total: number;
      items: Array<{
        id: string;
        excerpt: string;
        textRank: number | null;
        semanticRank: number | null;
      }>;
      components: { textCandidates: number; semanticCandidates: number };
    };

    expect(body.mode).toBe("hybrid");
    expect(body.total).toBe(3);
    expect(body.items.map((item) => item.id)).toEqual([noteA, noteB, noteC]);
    expect(body.items[0]).toMatchObject({
      id: noteA,
      excerpt: "Text migrace A",
      textRank: 1,
      semanticRank: 1,
    });
    expect(body.items[1]).toMatchObject({
      id: noteB,
      textRank: 2,
      semanticRank: null,
    });
    expect(body.items[2]).toMatchObject({
      id: noteC,
      textRank: null,
      semanticRank: 2,
    });
    expect(body.components).toEqual({
      textCandidates: 2,
      semanticCandidates: 2,
    });
  });

  it("maps an embedding failure to an error instead of an empty success", async () => {
    embedMock.mockRejectedValue(
      new EmbeddingError(
        502,
        "embedding_contract_rejected",
        "OpenRouter odmítl smlouvu embeddings.",
      ),
    );

    const response = await searchPostRoute(
      postRequest({
        mode: "semantic",
        q: "migrace",
        confirmCost: true,
        approvedMaxCostUsd: 0.0001,
      }),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "embedding_contract_rejected" },
    });
    expect(searchMock).not.toHaveBeenCalled();
  });
});
