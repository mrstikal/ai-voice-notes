import type { SearchResultItem } from "./fts.ts";
import type { SemanticSearchItem } from "./semantic.ts";

import { readEnvInt } from "../env-limits.ts";

export const HYBRID_COMPONENT_LIMIT = readEnvInt(
  "HYBRID_COMPONENT_LIMIT",
  20,
);
export const HYBRID_RESULT_LIMIT = readEnvInt("HYBRID_RESULT_LIMIT", 20);
export const RRF_K = 60;

export interface HybridSearchResponse {
  readonly mode: "hybrid";
  readonly query: string;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly hasNext: boolean;
  readonly items: readonly HybridFusedItem[];
  readonly model: string;
  readonly estimatedMaxCostUsd: number;
  readonly components: {
    readonly textCandidates: number;
    readonly semanticCandidates: number;
  };
  readonly index: {
    readonly readyNotes: number;
    readonly readyChunks: number;
    readonly pendingNotes: number;
    readonly errorNotes: number;
    readonly noContentNotes: number;
  };
}

export interface HybridFusedItem {
  readonly id: string;
  readonly title: string;
  readonly category: string | null;
  readonly tags: readonly string[];
  readonly excerpt: string;
  readonly updatedAt: Date;
  readonly score: number;
  readonly textRank: number | null;
  readonly semanticRank: number | null;
}

export function stripSearchMarkers(value: string): string {
  return value.replaceAll("[[[", "").replaceAll("]]]", "");
}

interface Accumulator {
  readonly id: string;
  textItem: SearchResultItem | null;
  semanticItem: SemanticSearchItem | null;
  textRank: number | null;
  semanticRank: number | null;
  score: number;
}

function compareIds(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

export function fuseHybridResults(
  textItems: readonly SearchResultItem[],
  semanticItems: readonly SemanticSearchItem[],
  limit: number = HYBRID_RESULT_LIMIT,
): HybridFusedItem[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("Limit hybridního hledání musí být kladné celé číslo.");
  }

  const byId = new Map<string, Accumulator>();

  function accumulator(id: string): Accumulator {
    const existing = byId.get(id);

    if (existing) {
      return existing;
    }

    const created: Accumulator = {
      id,
      textItem: null,
      semanticItem: null,
      textRank: null,
      semanticRank: null,
      score: 0,
    };

    byId.set(id, created);

    return created;
  }

  for (const [index, item] of textItems
    .slice(0, HYBRID_COMPONENT_LIMIT)
    .entries()) {
    const rank = index + 1;
    const entry = accumulator(item.id);

    entry.textItem ??= item;
    entry.textRank ??= rank;
    entry.score += 1 / (RRF_K + rank);
  }

  for (const [index, item] of semanticItems
    .slice(0, HYBRID_COMPONENT_LIMIT)
    .entries()) {
    const rank = index + 1;
    const entry = accumulator(item.id);

    entry.semanticItem ??= item;
    entry.semanticRank ??= rank;
    entry.score += 1 / (RRF_K + rank);
  }

  return [...byId.values()]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return compareIds(left.id, right.id);
    })
    .slice(0, limit)
    .map((entry) => {
      const meta = entry.textItem ?? entry.semanticItem;

      if (!meta) {
        throw new Error("Hybridní kandidát nemá metadata.");
      }

      return {
        id: entry.id,
        title: meta.title,
        category: meta.category,
        tags: meta.tags,
        excerpt: entry.textItem
          ? stripSearchMarkers(entry.textItem.snippet)
          : (entry.semanticItem?.excerpt ?? ""),
        updatedAt: meta.updatedAt,
        score: entry.score,
        textRank: entry.textRank,
        semanticRank: entry.semanticRank,
      };
    });
}
