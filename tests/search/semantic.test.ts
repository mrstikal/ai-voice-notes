import { describe, expect, it } from "vitest";

import type { NotesExecutor } from "../../src/lib/notes/repository";
import { countGraphemes } from "../../src/lib/notes/limits";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_ID,
} from "../../src/lib/search/embeddings";
import {
  SEMANTIC_EXCERPT_MAX_GRAPHEMES,
  SEMANTIC_QUERY_APPROVAL_USD,
  SemanticSearchError,
  buildSemanticExcerpt,
  searchNotesSemantic,
} from "../../src/lib/search/semantic";

const fakeDb = {} as NotesExecutor;

function basis(index: number): number[] {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);

  vector[index] = 1;

  return vector;
}

describe("P37 semantic query helpers", () => {
  it("bounds the excerpt by graphemes and preserves surrogate pairs", () => {
    const long = `${"😀".repeat(300)} konec`;
    const excerpt = buildSemanticExcerpt(long, 50);

    expect(countGraphemes(excerpt)).toBeLessThanOrEqual(51);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt).not.toContain("\uFFFD");
    expect(SEMANTIC_EXCERPT_MAX_GRAPHEMES).toBe(240);
  });

  it("normalizes whitespace and returns short text unchanged", () => {
    expect(buildSemanticExcerpt("  první\n\n druhý  ")).toBe("první druhý");
    expect(buildSemanticExcerpt("")).toBe("");
  });

  it("rejects a query vector with the wrong dimensions before touching the DB", async () => {
    await expect(
      searchNotesSemantic(fakeDb, {
        query: "migrace",
        page: 1,
        vector: [1, 2, 3],
        modelId: EMBEDDING_MODEL_ID,
      }),
    ).rejects.toMatchObject({
      code: "semantic_query_dimension_mismatch",
      status: 502,
    });
  });

  it("rejects a non-finite query vector before touching the DB", async () => {
    const vector = basis(0);
    vector[5] = Number.POSITIVE_INFINITY;

    await expect(
      searchNotesSemantic(fakeDb, {
        query: "migrace",
        page: 1,
        vector,
        modelId: EMBEDDING_MODEL_ID,
      }),
    ).rejects.toMatchObject({
      code: "semantic_query_invalid_vector",
      status: 502,
    });
  });

  it("rejects an invalid page before touching the DB", async () => {
    await expect(
      searchNotesSemantic(fakeDb, {
        query: "migrace",
        page: 0,
        vector: basis(0),
        modelId: EMBEDDING_MODEL_ID,
      }),
    ).rejects.toBeInstanceOf(SemanticSearchError);
  });

  it("keeps the displayed approval bound tiny but non-zero", () => {
    expect(SEMANTIC_QUERY_APPROVAL_USD).toBeGreaterThan(0);
    expect(SEMANTIC_QUERY_APPROVAL_USD).toBeLessThan(0.001);
  });
});
