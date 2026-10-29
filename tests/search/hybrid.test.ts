import { describe, expect, it } from "vitest";

import { SEED_FIXTURES } from "../../scripts/seed-fixtures";
import type { SearchResultItem } from "../../src/lib/search/fts";
import type { SemanticSearchItem } from "../../src/lib/search/semantic";
import {
  HYBRID_COMPONENT_LIMIT,
  HYBRID_RESULT_LIMIT,
  RRF_K,
  fuseHybridResults,
  stripSearchMarkers,
} from "../../src/lib/search/hybrid";
import { fuseHybridEvaluation } from "../../scripts/eval-search";
import {
  CZECH_SEARCH_EVALUATION_QUERIES,
  CZECH_SEARCH_EVALUATION_QUERY_COUNT,
} from "../fixtures/czech-search";

const UPDATED_AT = new Date("2026-10-28T12:00:00.000Z");

function textItem(
  id: string,
  snippet = `text ${id}`,
  title = `Text ${id}`,
): SearchResultItem {
  return {
    id,
    title,
    category: null,
    tags: [],
    snippet,
    updatedAt: UPDATED_AT,
  };
}

function semanticItem(
  id: string,
  excerpt = `význam ${id}`,
  title = `Význam ${id}`,
): SemanticSearchItem {
  return {
    id,
    chunkId: `chunk-${id}`,
    noteVersion: 1,
    title,
    category: null,
    tags: [],
    excerpt,
    updatedAt: UPDATED_AT,
  };
}

describe("P38 reciprocal rank fusion", () => {
  it("dedupes a note present in both lists and exposes both component ranks", () => {
    const fused = fuseHybridResults(
      [textItem("a"), textItem("b")],
      [semanticItem("b"), semanticItem("a")],
    );

    expect(fused).toHaveLength(2);
    expect(fused.map((item) => item.id)).toEqual(["a", "b"]);

    const a = fused[0]!;
    const b = fused[1]!;

    expect(a).toMatchObject({
      textRank: 1,
      semanticRank: 2,
      excerpt: "text a",
    });
    expect(b).toMatchObject({
      textRank: 2,
      semanticRank: 1,
      excerpt: "text b",
    });
    expect(a.score).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2));
    expect(b.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1));
  });

  it("scores sum(1/(60+rank)) and orders by score then stable id", () => {
    const fused = fuseHybridResults(
      [textItem("a"), textItem("b"), textItem("c")],
      [semanticItem("c"), semanticItem("a"), semanticItem("d")],
    );

    expect(fused.map((item) => item.id)).toEqual(["a", "c", "b", "d"]);
    expect(fused[0]?.score).toBeCloseTo(
      1 / (RRF_K + 1) + 1 / (RRF_K + 2),
    );
    expect(fused[1]?.score).toBeCloseTo(
      1 / (RRF_K + 3) + 1 / (RRF_K + 1),
    );
    expect(fused[2]?.score).toBeCloseTo(1 / (RRF_K + 2));
    expect(fused[3]?.score).toBeCloseTo(1 / (RRF_K + 3));
  });

  it("breaks equal scores by ascending note id", () => {
    const fused = fuseHybridResults(
      [textItem("b")],
      [semanticItem("a")],
    );

    expect(fused).toHaveLength(2);
    expect(fused.map((item) => item.id)).toEqual(["a", "b"]);
    expect(fused[0]?.score).toBeCloseTo(fused[1]?.score ?? 0);
  });

  it("uses only the top 20 items from each component and the result limit", () => {
    const text = Array.from({ length: 25 }, (_, index) =>
      textItem(`text-${String(index).padStart(2, "0")}`),
    );
    const semantic = Array.from({ length: 25 }, (_, index) =>
      semanticItem(`semantic-${String(index).padStart(2, "0")}`),
    );

    const fused = fuseHybridResults(text, semantic);

    expect(fused).toHaveLength(HYBRID_RESULT_LIMIT);
    expect(fused.some((item) => item.id === "text-20")).toBe(false);
    expect(fused.some((item) => item.id === "semantic-20")).toBe(false);
    expect(HYBRID_COMPONENT_LIMIT).toBe(20);

    const limited = fuseHybridResults(text, semantic, 5);

    expect(limited).toHaveLength(5);
  });

  it("keeps semantic excerpt for a semantic-only note and strips text markers", () => {
    const fused = fuseHybridResults(
      [textItem("a", "Před [[[dotaz]]] po")],
      [semanticItem("b", "Významový výňatek")],
    );

    const a = fused.find((item) => item.id === "a");
    const b = fused.find((item) => item.id === "b");

    expect(a?.excerpt).toBe("Před dotaz po");
    expect(a?.semanticRank).toBeNull();
    expect(b?.excerpt).toBe("Významový výňatek");
    expect(b?.textRank).toBeNull();
    expect(stripSearchMarkers("[[[x]]] y")).toBe("x y");
  });

  it("fuses the full component lists before filtering to seed results", () => {
    const seedKeyById = new Map([
      ["seed-a", "demo-v1:D01"],
      ["seed-c", "demo-v1:D02"],
    ]);
    const fused = fuseHybridEvaluation(
      [textItem("outside"), textItem("seed-a"), textItem("seed-c")],
      [semanticItem("seed-a")],
      seedKeyById,
    );

    expect(fused.map((item) => item.id)).toEqual(["seed-a", "seed-c"]);
    expect(fused[0]).toMatchObject({
      textRank: 2,
      semanticRank: 1,
    });
    expect(fused[1]).toMatchObject({
      textRank: 3,
      semanticRank: null,
    });
  });

  it("rejects an invalid result limit", () => {
    expect(() => fuseHybridResults([], [], 0)).toThrow(RangeError);
    expect(() => fuseHybridResults([], [], 1.5)).toThrow(RangeError);
  });
});

describe("P38 20-query fixture relationships", () => {
  it("ships exactly 20 literal Czech query -> seed_key relationships", () => {
    const seedKeys = new Set(SEED_FIXTURES.map((fixture) => fixture.key));

    expect(CZECH_SEARCH_EVALUATION_QUERY_COUNT).toBe(20);
    expect(CZECH_SEARCH_EVALUATION_QUERIES).toHaveLength(20);

    const ids = new Set<string>();
    const queries = new Set<string>();
    const expectedKeys = new Set<string>();

    for (const fixture of CZECH_SEARCH_EVALUATION_QUERIES) {
      expect(fixture.id).toMatch(/^Q\d{2}$/u);
      expect(ids.has(fixture.id)).toBe(false);
      ids.add(fixture.id);

      expect(fixture.query.trim()).toBe(fixture.query);
      expect(fixture.query.length).toBeGreaterThan(0);
      expect(queries.has(fixture.query)).toBe(false);
      queries.add(fixture.query);

      expect(fixture.expectedSeedKeys.length).toBeGreaterThan(0);

      for (const key of fixture.expectedSeedKeys) {
        expect(key.startsWith("demo-v1:")).toBe(true);
        expect(seedKeys.has(key)).toBe(true);
        expectedKeys.add(key);
      }
    }

    expect(expectedKeys.size).toBe(SEED_FIXTURES.length);
  });
});
