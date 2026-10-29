import { sql } from "drizzle-orm";

import type { NotesExecutor } from "../notes/repository.ts";
import { countGraphemes } from "../notes/limits.ts";
import { EMBEDDING_DIMENSIONS } from "./embeddings.ts";
import { SEARCH_QUERY_MAX_GRAPHEMES } from "./fts.ts";

export const SEMANTIC_PAGE_SIZE = 10;
export const SEMANTIC_QUERY_MAX_CODE_UNITS = 2_000;
export const SEMANTIC_QUERY_APPROVAL_USD = 0.0005;
export const SEMANTIC_EXCERPT_MAX_GRAPHEMES = 240;

const excerptSegmenter = new Intl.Segmenter("cs", {
  granularity: "grapheme",
});

export class SemanticSearchError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SemanticSearchError";
    this.status = status;
    this.code = code;
  }
}

export interface SemanticSearchItem {
  readonly id: string;
  readonly title: string;
  readonly category: string | null;
  readonly tags: string[];
  readonly excerpt: string;
  readonly updatedAt: Date;
}

export interface SemanticSearchIndexInfo {
  readonly readyNotes: number;
  readonly readyChunks: number;
  readonly pendingNotes: number;
  readonly errorNotes: number;
  readonly noContentNotes: number;
}

export interface SemanticSearchResult {
  readonly query: string;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly hasNext: boolean;
  readonly items: readonly SemanticSearchItem[];
  readonly model: string;
}

export interface SemanticSearchResponse extends SemanticSearchResult {
  readonly index: SemanticSearchIndexInfo;
  readonly estimatedMaxCostUsd: number;
}

export function buildSemanticExcerpt(
  text: string,
  maxGraphemes: number = SEMANTIC_EXCERPT_MAX_GRAPHEMES,
): string {
  const normalized = text.replace(/\s+/gu, " ").trim();

  if (normalized === "") {
    return "";
  }

  const segments = Array.from(excerptSegmenter.segment(normalized));

  if (segments.length <= maxGraphemes) {
    return segments.map((segment) => segment.segment).join("");
  }

  const excerpt = segments
    .slice(0, maxGraphemes)
    .map((segment) => segment.segment)
    .join("")
    .trimEnd();

  return `${excerpt}…`;
}

function assertQueryVector(vector: readonly number[]): void {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new SemanticSearchError(
      502,
      "semantic_query_dimension_mismatch",
      `Vektor dotazu nemá ${EMBEDDING_DIMENSIONS} dimenzí. Sémantické hledání bylo zablokováno.`,
    );
  }

  if (vector.some((value) => !Number.isFinite(value))) {
    throw new SemanticSearchError(
      502,
      "semantic_query_invalid_vector",
      "Vektor dotazu obsahuje neplatnou hodnotu. Sémantické hledání bylo zablokováno.",
    );
  }
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

export async function searchNotesSemantic(
  db: NotesExecutor,
  input: {
    readonly query: string;
    readonly page: number;
    readonly vector: readonly number[];
    readonly modelId: string;
  },
): Promise<SemanticSearchResult> {
  assertQueryVector(input.vector);

  if (!Number.isSafeInteger(input.page) || input.page < 1) {
    throw new SemanticSearchError(
      400,
      "invalid_page",
      "Stránka musí být kladné číslo.",
    );
  }

  if (
    input.query.length > SEMANTIC_QUERY_MAX_CODE_UNITS ||
    countGraphemes(input.query) > SEARCH_QUERY_MAX_GRAPHEMES
  ) {
    throw new SemanticSearchError(
      400,
      "search_query_too_long",
      "Hledaný výraz je příliš dlouhý.",
    );
  }

  const offset = (input.page - 1) * SEMANTIC_PAGE_SIZE;
  const literal = vectorLiteral(input.vector);
  const result = await db.execute(sql`
    WITH ranked AS (
      SELECT
        c.note_id,
        c.text,
        c.embedding <=> ${literal}::vector AS distance,
        row_number() OVER (
          PARTITION BY c.note_id
          ORDER BY
            c.embedding <=> ${literal}::vector ASC,
            c.chunk_index ASC,
            c.id ASC
        ) AS rank_in_note
      FROM note_chunks AS c
      JOIN notes AS n ON n.id = c.note_id
      WHERE c.status = 'ready'
        AND c.model = ${input.modelId}
        AND c.note_version = n.version
        AND n.deleted_at IS NULL
        AND c.embedding IS NOT NULL
    )
    SELECT
      r.note_id AS id,
      n.title,
      n.category,
      n.updated_at,
      coalesce((
        SELECT array_agg(t.tag ORDER BY t.tag)
        FROM note_tags AS t
        WHERE t.note_id = n.id
      ), '{}') AS tags,
      r.text,
      r.distance
    FROM ranked AS r
    JOIN notes AS n ON n.id = r.note_id
    WHERE r.rank_in_note = 1
    ORDER BY r.distance ASC, r.note_id ASC
    LIMIT ${SEMANTIC_PAGE_SIZE}
    OFFSET ${offset}
  `);
  const rows = result.rows as Array<{
    id: string;
    title: string;
    category: string | null;
    tags: string[];
    updated_at: Date;
    text: string;
    distance: number | string;
  }>;
  const count = await db.execute<{ readonly total: number | string }>(sql`
    SELECT count(DISTINCT c.note_id)::int AS total
    FROM note_chunks AS c
    JOIN notes AS n ON n.id = c.note_id
    WHERE c.status = 'ready'
      AND c.model = ${input.modelId}
      AND c.note_version = n.version
      AND n.deleted_at IS NULL
      AND c.embedding IS NOT NULL
  `);
  const total = Number(count.rows[0]?.total ?? 0);

  return {
    query: input.query,
    page: input.page,
    pageSize: SEMANTIC_PAGE_SIZE,
    total,
    hasNext: offset + rows.length < total,
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      category: row.category,
      tags: row.tags,
      excerpt: buildSemanticExcerpt(row.text),
      updatedAt: row.updated_at,
    })),
    model: input.modelId,
  };
}
