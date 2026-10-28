import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertTestDatabaseTargets,
  type TestDatabaseTargets,
} from "../../scripts/test-db-guard";
import {
  OpenRouterClient,
  type OpenRouterTransportRequest,
} from "../../src/lib/ai/openrouter";
import { createUsageService } from "../../src/lib/ai/usage";
import {
  createDatabase,
  type DatabaseConnection,
} from "../../src/lib/db/client";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_ID,
  EmbeddingError,
  createEmbeddingService,
  type EmbeddingService,
} from "../../src/lib/search/embeddings";
import {
  applyReindexEmbeddings,
  getReindexStatus,
  prepareReindexBatch,
  resetReindexInFlightForTests,
  runReindex,
} from "../../src/lib/search/reindex";
import {
  createNoteService,
  type NoteService,
} from "../../src/lib/notes/service";
import { searchNotesFullText } from "../../src/lib/search/fts";

const hasTestDatabase = Boolean(
  process.env.DATABASE_URL && process.env.TEST_DATABASE_URL,
);

function vector(seed = 1): number[] {
  return Array.from(
    { length: EMBEDDING_DIMENSIONS },
    (_, index) => Math.sin(seed + index / EMBEDDING_DIMENSIONS),
  );
}

function vectors(count: number): number[][] {
  return Array.from({ length: count }, (_, index) => vector(index + 1));
}

function fakeEmbeddingTransport(options: {
  readonly cost?: number;
  readonly fail?: boolean;
}) {
  const requests: unknown[] = [];

  return {
    requests,
    transport: {
      async fetch(request: OpenRouterTransportRequest) {
        if (options.fail) {
          return new Response(
            JSON.stringify({ error: { code: 500, message: "provider down" } }),
            {
              status: 500,
              headers: { "content-type": "application/json" },
            },
          );
        }

        const body = JSON.parse(request.body) as { input: string[] };
        requests.push(body);

        return new Response(
          JSON.stringify({
            object: "list",
            model: EMBEDDING_MODEL_ID,
            data: body.input.map((_, index) => ({
              object: "embedding",
              index,
              embedding: vector(index + 1),
            })),
            usage: {
              prompt_tokens: body.input.length * 12,
              total_tokens: body.input.length * 12,
              ...(options.cost === undefined ? {} : { cost: options.cost }),
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    },
  };
}

const failingEmbedder: EmbeddingService = {
  async embed() {
    throw new EmbeddingError(
      502,
      "embedding_request_failed",
      "Poskytovatel embeddings selhal.",
    );
  },
};

describe.skipIf(!hasTestDatabase)("P36 bounded explicit reindex", () => {
  let connection: DatabaseConnection;
  let targets: TestDatabaseTargets;
  let notes: NoteService;

  beforeAll(() => {
    targets = assertTestDatabaseTargets();
    connection = createDatabase(targets.testUrl);
    notes = createNoteService({ db: connection.db });
  });

  beforeEach(async () => {
    await connection.pool.query("TRUNCATE TABLE notes CASCADE");
    await connection.pool.query("TRUNCATE TABLE ai_usage");
    resetReindexInFlightForTests();
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  function realEmbedder(
    options: { readonly cost?: number | null } = {},
  ): { readonly embedder: EmbeddingService; readonly requests: unknown[] } {
    const fake = fakeEmbeddingTransport({
      cost:
        options.cost === null
          ? undefined
          : (options.cost ?? 0.0000005),
    });
    const usage = createUsageService({
      db: connection.db,
      budgetUsd: 2,
    });
    const client = new OpenRouterClient({
      apiKey: "test-only-openrouter",
      usage,
      transport: fake.transport,
    });

    return {
      embedder: createEmbeddingService({ client }),
      requests: fake.requests,
    };
  }

  async function chunkRows(noteId: string) {
    const result = await connection.pool.query<{
      note_version: number;
      chunk_index: number;
      status: string;
      model: string;
      embedding_dims: number | null;
      text: string;
    }>(
      `SELECT note_version, chunk_index, status, model,
              vector_dims(embedding) AS embedding_dims, text
       FROM note_chunks
       WHERE note_id = $1
       ORDER BY note_version, chunk_index`,
      [noteId],
    );

    return result.rows;
  }

  async function usageRows() {
    const result = await connection.pool.query<{
      operation: string;
      provider: string;
      model: string;
      status: string;
      reported_cost_usd: string | null;
    }>(
      `SELECT operation, provider, model, status, reported_cost_usd::text
       FROM ai_usage
       ORDER BY started_at`,
    );

    return result.rows;
  }

  const longText = (label: string) =>
    `${label} popisuje databázový plán. `.repeat(40).trim();

  it("prepares missing chunks for an older note and makes it ready after one approved reindex", async () => {
    const note = await notes.createNote({
      title: "Starší poznámka",
      contentMd: longText("První odstavec"),
    });

    await connection.pool.query("DELETE FROM note_chunks WHERE note_id = $1", [
      note.id,
    ]);

    const preP35Status = await getReindexStatus(
      connection.db,
      EMBEDDING_MODEL_ID,
    );

    expect(preP35Status.notes).toMatchObject({
      total: 1,
      ready: 0,
      pending: 1,
      error: 0,
      noContent: 0,
    });

    const estimate = await runReindex({
      db: connection.db,
      embedder: failingEmbedder,
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: false,
    });

    expect(estimate.status).toBe("estimate");

    if (estimate.status !== "estimate") {
      throw new Error("expected estimate");
    }

    expect(estimate.preparedNotes).toBe(1);
    expect(estimate.candidateNotes).toBe(1);
    expect(estimate.candidateChunks).toBe(1);
    expect(estimate.estimatedMaxCostUsd).toBeGreaterThan(0);

    const { embedder, requests } = realEmbedder();
    const completed = await runReindex({
      db: connection.db,
      embedder,
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: true,
      approvedMaxCostUsd: estimate.estimatedMaxCostUsd,
    });

    expect(completed.status).toBe("completed");

    if (completed.status !== "completed") {
      throw new Error("expected completion");
    }

    expect(completed.readyChunks).toBe(1);
    expect(completed.staleChunks).toBe(0);
    expect(requests).toHaveLength(1);

    const rows = await chunkRows(note.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      note_version: 1,
      status: "ready",
      model: EMBEDDING_MODEL_ID,
      embedding_dims: EMBEDDING_DIMENSIONS,
    });

    const status = await getReindexStatus(connection.db, EMBEDDING_MODEL_ID);

    expect(status.notes).toMatchObject({ total: 1, ready: 1, pending: 0, error: 0 });
    expect(status.chunks).toMatchObject({ current: rows.length, ready: rows.length });

    const usage = await usageRows();

    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      operation: "embedding_reindex",
      provider: "openrouter",
      model: EMBEDDING_MODEL_ID,
      status: "settled",
      reported_cost_usd: "0.000001",
    });
  });

  it("skips the provider when current-version chunks are ready for the same model", async () => {
    const note = await notes.createNote({
      title: "Hotová poznámka",
      contentMd: longText("Druhý odstavec"),
    });
    const { embedder } = realEmbedder();
    const estimate = await runReindex({
      db: connection.db,
      embedder,
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: false,
    });

    if (estimate.status !== "estimate") {
      throw new Error("expected estimate");
    }

    await runReindex({
      db: connection.db,
      embedder,
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: true,
      approvedMaxCostUsd: estimate.estimatedMaxCostUsd,
    });

    const forbidden = vi.fn(async () => {
      throw new Error("provider must not be called");
    });
    const skipped = await runReindex({
      db: connection.db,
      embedder: { embed: forbidden },
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: true,
      approvedMaxCostUsd: 1,
    });

    expect(skipped.status).toBe("skipped");

    if (skipped.status !== "skipped") {
      throw new Error("expected skip");
    }

    expect(skipped.reason).toBe("ready");
    expect(forbidden).not.toHaveBeenCalled();

    const status = await connection.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM ai_usage",
    );

    expect(status.rows[0]?.count).toBe("1");
    expect(await chunkRows(note.id)).toHaveLength(1);
  });

  it("keeps the charge unknown when the provider reports no cost", async () => {
    await notes.createNote({
      title: "Neznámá cena",
      contentMd: longText("Jedenáctý odstavec"),
    });
    const { embedder } = realEmbedder({ cost: null });
    const estimate = await runReindex({
      db: connection.db,
      embedder,
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: false,
    });

    if (estimate.status !== "estimate") {
      throw new Error("expected estimate");
    }

    const completed = await runReindex({
      db: connection.db,
      embedder,
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: true,
      approvedMaxCostUsd: estimate.estimatedMaxCostUsd,
    });

    expect(completed.status).toBe("completed");

    const usage = await usageRows();

    expect(usage[0]).toMatchObject({
      operation: "embedding_reindex",
      status: "unknown",
      reported_cost_usd: null,
    });
  });

  it("re-embeds ready chunks whose stored model no longer matches", async () => {
    const note = await notes.createNote({
      title: "Starý model",
      contentMd: longText("Dvanáctý odstavec"),
    });
    const { embedder } = realEmbedder();
    const estimate = await runReindex({
      db: connection.db,
      embedder,
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: false,
    });

    if (estimate.status !== "estimate") {
      throw new Error("expected estimate");
    }

    await runReindex({
      db: connection.db,
      embedder,
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: true,
      approvedMaxCostUsd: estimate.estimatedMaxCostUsd,
    });

    await connection.pool.query(
      "UPDATE note_chunks SET model = 'older/embedding-model' WHERE note_id = $1",
      [note.id],
    );

    const again = await runReindex({
      db: connection.db,
      embedder,
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: false,
    });

    expect(again.status).toBe("estimate");

    if (again.status !== "estimate") {
      throw new Error("expected estimate");
    }

    expect(again.candidateChunks).toBeGreaterThan(0);

    await runReindex({
      db: connection.db,
      embedder,
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: true,
      approvedMaxCostUsd: again.estimatedMaxCostUsd,
    });

    expect(
      (await chunkRows(note.id)).every(
        (row) => row.model === EMBEDDING_MODEL_ID && row.status === "ready",
      ),
    ).toBe(true);
  });

  it("rejects a second concurrent confirmed batch in the same process", async () => {
    await notes.createNote({
      title: "Souběh",
      contentMd: longText("Třináctý odstavec"),
    });
    const estimate = await runReindex({
      db: connection.db,
      embedder: failingEmbedder,
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: false,
    });

    if (estimate.status !== "estimate") {
      throw new Error("expected estimate");
    }

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowEmbedder: EmbeddingService = {
      async embed(texts) {
        await gate;

        return {
          model: EMBEDDING_MODEL_ID,
          vectors: vectors(texts.length),
          promptTokens: 1,
        };
      },
    };
    const first = runReindex({
      db: connection.db,
      embedder: slowEmbedder,
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: true,
      approvedMaxCostUsd: estimate.estimatedMaxCostUsd,
    });

    await expect(
      runReindex({
        db: connection.db,
        embedder: failingEmbedder,
        modelId: EMBEDDING_MODEL_ID,
        confirmCost: true,
        approvedMaxCostUsd: estimate.estimatedMaxCostUsd,
      }),
    ).rejects.toMatchObject({ code: "reindex_in_progress" });

    release?.();
    await expect(first).resolves.toMatchObject({ status: "completed" });
  });

  it("marks chunks error when applying a successful provider response fails", async () => {
    const note = await notes.createNote({
      title: "Selhání zápisu",
      contentMd: longText("Čtrnáctý odstavec"),
    });
    const estimate = await runReindex({
      db: connection.db,
      embedder: failingEmbedder,
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: false,
    });

    if (estimate.status !== "estimate") {
      throw new Error("expected estimate");
    }

    const brokenApply: EmbeddingService = {
      async embed() {
        return {
          model: EMBEDDING_MODEL_ID,
          vectors: [],
          promptTokens: 5,
        };
      },
    };

    await expect(
      runReindex({
        db: connection.db,
        embedder: brokenApply,
        modelId: EMBEDDING_MODEL_ID,
        confirmCost: true,
        approvedMaxCostUsd: estimate.estimatedMaxCostUsd,
      }),
    ).rejects.toMatchObject({ code: "embedding_invalid_provider_response" });

    const rows = await chunkRows(note.id);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.status === "error")).toBe(true);
    expect(rows.every((row) => row.embedding_dims === null)).toBe(true);
  });

  it("marks affected chunks error on provider failure and allows a manual retry", async () => {
    const note = await notes.createNote({
      title: "Selhání a opakování",
      contentMd: longText("Třetí odstavec"),
    });
    const estimate = await runReindex({
      db: connection.db,
      embedder: failingEmbedder,
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: false,
    });

    if (estimate.status !== "estimate") {
      throw new Error("expected estimate");
    }

    await expect(
      runReindex({
        db: connection.db,
        embedder: failingEmbedder,
        modelId: EMBEDDING_MODEL_ID,
        confirmCost: true,
        approvedMaxCostUsd: estimate.estimatedMaxCostUsd,
      }),
    ).rejects.toMatchObject({ code: "embedding_request_failed" });

    const failed = await chunkRows(note.id);

    expect(failed.every((row) => row.status === "error")).toBe(true);

    const retryEstimate = await runReindex({
      db: connection.db,
      embedder: failingEmbedder,
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: false,
    });

    if (retryEstimate.status !== "estimate") {
      throw new Error("expected retry estimate");
    }

    const { embedder } = realEmbedder();
    const retried = await runReindex({
      db: connection.db,
      embedder,
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: true,
      approvedMaxCostUsd: retryEstimate.estimatedMaxCostUsd,
    });

    expect(retried.status).toBe("completed");

    const ready = await chunkRows(note.id);

    expect(ready.every((row) => row.status === "ready")).toBe(true);
  });

  it("discards results for a note edited during the flight and never marks the old version ready", async () => {
    const note = await notes.createNote({
      title: "Změna během letu",
      contentMd: longText("Čtvrtý odstavec"),
    });
    const batch = await prepareReindexBatch(connection.db, EMBEDDING_MODEL_ID);

    expect(batch.chunks.length).toBeGreaterThan(0);

    await notes.updateNote(note.id, {
      title: note.title,
      contentMd: longText("Změněný odstavec"),
      expectedVersion: note.version,
    });

    const applied = await applyReindexEmbeddings(
      connection.db,
      batch,
      vectors(batch.chunks.length),
      EMBEDDING_MODEL_ID,
    );

    expect(applied.readyChunks).toBe(0);
    expect(applied.staleNotes).toBe(1);
    expect(applied.staleChunks).toBe(batch.chunks.length);

    const rows = await chunkRows(note.id);
    const oldVersionRows = rows.filter(
      (row) => row.note_version === batch.notes[0]!.noteVersion,
    );
    const currentRows = rows.filter((row) => row.note_version === 2);

    expect(oldVersionRows.length).toBeGreaterThan(0);
    expect(oldVersionRows.every((row) => row.status === "error")).toBe(true);
    expect(currentRows.length).toBeGreaterThan(0);
    expect(currentRows.every((row) => row.status === "pending")).toBe(true);
  });

  it("keeps another note readable and searchable while indexing fails", async () => {
    const first = await notes.createNote({
      title: "Selhávající index",
      contentMd: longText("Pátý odstavec"),
    });
    const second = await notes.createNote({
      title: "Čitelná poznámka",
      contentMd: longText("Šestý odstavec"),
    });
    const estimate = await runReindex({
      db: connection.db,
      embedder: failingEmbedder,
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: false,
    });

    if (estimate.status !== "estimate") {
      throw new Error("expected estimate");
    }

    await expect(
      runReindex({
        db: connection.db,
        embedder: failingEmbedder,
        modelId: EMBEDDING_MODEL_ID,
        confirmCost: true,
        approvedMaxCostUsd: estimate.estimatedMaxCostUsd,
      }),
    ).rejects.toBeInstanceOf(EmbeddingError);

    const readable = await notes.getNote(second.id);

    expect(readable.title).toBe("Čitelná poznámka");

    const search = await searchNotesFullText(connection.db, {
      page: 1,
      query: "Čitelná",
    });

    expect(search.items.map((item) => item.id)).toContain(second.id);
    expect(await notes.getNote(first.id)).toMatchObject({
      title: "Selhávající index",
    });
  });

  it("refuses a confirmation whose price was not approved for the current range", async () => {
    const first = await notes.createNote({
      title: "První rozsah",
      contentMd: longText("Sedmý odstavec"),
    });
    const estimate = await runReindex({
      db: connection.db,
      embedder: failingEmbedder,
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: false,
    });

    if (estimate.status !== "estimate") {
      throw new Error("expected estimate");
    }

    await notes.createNote({
      title: "Druhý rozsah",
      contentMd: longText("Osmý odstavec"),
    });

    const { embedder } = realEmbedder();

    await expect(
      runReindex({
        db: connection.db,
        embedder,
        modelId: EMBEDDING_MODEL_ID,
        confirmCost: true,
        approvedMaxCostUsd: estimate.estimatedMaxCostUsd,
      }),
    ).rejects.toMatchObject({ code: "reindex_cost_changed" });

    expect(
      (await chunkRows(first.id)).every((row) => row.status !== "ready"),
    ).toBe(true);
  });

  it("caps one request at three notes and twenty chunks", async () => {
    for (let index = 0; index < 4; index += 1) {
      await notes.createNote({
        title: `Dávka ${index}`,
        contentMd: longText(`Odstavec ${index}`),
      });
    }

    const estimate = await runReindex({
      db: connection.db,
      embedder: failingEmbedder,
      modelId: EMBEDDING_MODEL_ID,
      confirmCost: false,
    });

    if (estimate.status !== "estimate") {
      throw new Error("expected estimate");
    }

    expect(estimate.candidateNotes).toBe(3);
    expect(estimate.candidateChunks).toBeLessThanOrEqual(20);
    expect(estimate.remainingChunks).toBeGreaterThan(0);
  });

  it("reports a no-content note separately from a pending index", async () => {
    const empty = await notes.createNote({
      title: "Bez textu",
      contentMd: "",
    });
    const pending = await notes.createNote({
      title: "Čeká na vektory",
      contentMd: longText("Desátý odstavec"),
    });
    const status = await getReindexStatus(connection.db, EMBEDDING_MODEL_ID);

    expect(status.notes).toMatchObject({
      total: 2,
      ready: 0,
      pending: 1,
      error: 0,
      noContent: 1,
    });
    expect(status.chunks.pending).toBeGreaterThan(0);
    expect(empty.id).not.toBe(pending.id);
  });

  it("requires an explicit approved cost before any provider call", async () => {
    await notes.createNote({
      title: "Bez potvrzení",
      contentMd: longText("Devátý odstavec"),
    });
    const forbidden = vi.fn(async () => {
      throw new Error("provider must not be called");
    });

    await expect(
      runReindex({
        db: connection.db,
        embedder: { embed: forbidden },
        modelId: EMBEDDING_MODEL_ID,
        confirmCost: true,
      }),
    ).rejects.toMatchObject({ code: "reindex_cost_not_approved" });

    expect(forbidden).not.toHaveBeenCalled();
  });
});
