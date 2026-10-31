import { sql } from "drizzle-orm";

import { countGraphemes } from "../notes/limits.ts";
import type { NotesExecutor } from "../notes/repository.ts";

export const SEARCH_PAGE_SIZE = 10;
export const SEARCH_QUERY_MAX_GRAPHEMES = 200;

const SEARCH_VECTOR_EXPRESSION = sql`
  CASE
    WHEN notes.deleted_at IS NULL THEN
      setweight(to_tsvector('simple', unaccent(coalesce(notes.title, ''))), 'A') ||
      setweight(to_tsvector('simple', unaccent(coalesce(notes.content_plain, ''))), 'B') ||
      setweight(to_tsvector('simple', unaccent(coalesce((
        SELECT string_agg(note_tags.tag, ' ' ORDER BY note_tags.tag)
        FROM note_tags
        WHERE note_tags.note_id = notes.id
      ), ''))), 'C')
    ELSE NULL
  END
`;

export async function refreshNoteSearch(
  db: NotesExecutor,
  noteId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE notes
    SET search_vector = ${SEARCH_VECTOR_EXPRESSION}
    WHERE id = ${noteId}
  `);
}

export interface SearchResultItem {
  readonly id: string;
  readonly title: string;
  readonly category: string | null;
  readonly tags: string[];
  readonly snippet: string;
  readonly updatedAt: Date;
  readonly version?: number;
}

export interface SearchResult {
  readonly query: string;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly hasNext: boolean;
  readonly items: readonly SearchResultItem[];
  readonly empty: boolean;
}

export class SearchQueryError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SearchQueryError";
    this.status = status;
    this.code = code;
  }
}

export function normalizeSearchQuery(value: string): string {
  const query = value.trim();

  if (countGraphemes(query) > SEARCH_QUERY_MAX_GRAPHEMES) {
    throw new SearchQueryError(
      400,
      "search_query_too_long",
      `Hledaný výraz může mít nejvýše ${SEARCH_QUERY_MAX_GRAPHEMES} znaků.`,
    );
  }

  return query;
}

export function emptySearchResult(query: string, page = 1): SearchResult {
  return {
    empty: true,
    hasNext: false,
    items: [],
    page,
    pageSize: SEARCH_PAGE_SIZE,
    query,
    total: 0,
  };
}

function isQuoted(query: string): boolean {
  return (
    (query.startsWith('"') && query.endsWith('"') && query.length >= 2) ||
    (query.startsWith("„") && query.endsWith("“") && query.length >= 2) ||
    (query.startsWith("“") && query.endsWith("”") && query.length >= 2)
  );
}

function phraseText(query: string): string {
  if (query.startsWith('"') && query.endsWith('"')) {
    return query.slice(1, -1).trim();
  }

  if (query.startsWith("„") && query.endsWith("“")) {
    return query.slice(1, -1).trim();
  }

  if (query.startsWith("“") && query.endsWith("”")) {
    return query.slice(1, -1).trim();
  }

  return query;
}

function foldSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("cs")
    .replace(/ø/gu, "o")
    .replace(/ł/gu, "l")
    .replace(/đ/gu, "d")
    .replace(/ð/gu, "d")
    .replace(/þ/gu, "th")
    .replace(/ß/gu, "ss")
    .replace(/æ/gu, "ae")
    .replace(/œ/gu, "oe")
    .replace(/ı/gu, "i")
    .replace(/ħ/gu, "h")
    .replace(/ŋ/gu, "n")
    .replace(/ŧ/gu, "t")
    .replace(/ς/gu, "σ");
}

function foldWithMap(value: string): {
  readonly folded: string;
  readonly map: readonly number[];
} {
  let folded = "";
  const map: number[] = [];
  let originalIndex = 0;

  for (const character of value) {
    const foldedCharacter = foldSearch(character);
    folded += foldedCharacter;

    for (let index = 0; index < foldedCharacter.length; index += 1) {
      map.push(originalIndex);
    }

    originalIndex += character.length;
  }

  return { folded, map };
}

function snippetNeedle(query: string): string {
  if (isQuoted(query)) {
    return phraseText(query).trim();
  }

  const words = query.match(/[\p{L}\p{N}]+/gu) ?? [];

  return words.sort((left, right) => right.length - left.length)[0] ?? "";
}

export function buildSearchSnippet(
  contentPlain: string,
  query: string,
  maxLength = 180,
): string {
  const needle = snippetNeedle(query);
  const foldedNeedle = foldSearch(needle);

  if (needle === "" || foldedNeedle === "") {
    return contentPlain.slice(0, maxLength);
  }

  const { folded, map } = foldWithMap(contentPlain);
  const position = folded.indexOf(foldedNeedle);

  if (position === -1) {
    return contentPlain.slice(0, maxLength);
  }

  const matchStart = map[position] ?? 0;
  const lastMatchIndex =
    map[position + foldedNeedle.length - 1] ?? matchStart;
  const lastCodePoint = contentPlain.codePointAt(lastMatchIndex) ?? 0;
  const matchEnd =
    lastMatchIndex + (lastCodePoint > 0xffff ? 2 : 1);
  let start = Math.max(0, matchStart - 70);
  let end = Math.min(contentPlain.length, matchEnd + 70);

  if (
    start > 0 &&
    start < contentPlain.length &&
    contentPlain.charCodeAt(start) >= 0xdc00 &&
    contentPlain.charCodeAt(start) <= 0xdfff &&
    contentPlain.charCodeAt(start - 1) >= 0xd800 &&
    contentPlain.charCodeAt(start - 1) <= 0xdbff
  ) {
    start -= 1;
  }

  if (
    end > 0 &&
    end < contentPlain.length &&
    contentPlain.charCodeAt(end) >= 0xdc00 &&
    contentPlain.charCodeAt(end) <= 0xdfff &&
    contentPlain.charCodeAt(end - 1) >= 0xd800 &&
    contentPlain.charCodeAt(end - 1) <= 0xdbff
  ) {
    end += 1;
  }

  const before = contentPlain.slice(start, matchStart);
  const match = contentPlain.slice(matchStart, matchEnd);
  const after = contentPlain.slice(matchEnd, end);

  return `${before}[[[${match}]]]${after}`;
}

export async function searchNotesFullText(
  db: NotesExecutor,
  input: { readonly query: string; readonly page: number },
): Promise<SearchResult> {
  const query = normalizeSearchQuery(input.query);

  if (query === "") {
    return emptySearchResult(query, input.page);
  }

  if (!Number.isSafeInteger(input.page) || input.page < 1) {
    throw new SearchQueryError(400, "invalid_page", "Stránka musí být kladné číslo.");
  }

  const phrase = isQuoted(query);
  const text = phrase ? phraseText(query) : query;
  const tsQuery = phrase
    ? sql`phraseto_tsquery('simple', unaccent(${text}))`
    : sql`plainto_tsquery('simple', unaccent(${text}))`;
  const offset = (input.page - 1) * SEARCH_PAGE_SIZE;
  const result = await db.execute(sql`
    WITH q AS (SELECT ${tsQuery} AS query)
    SELECT
      n.id,
      n.title,
      n.category,
      n.updated_at,
      n.version,
      coalesce((
        SELECT array_agg(t.tag ORDER BY t.tag)
        FROM note_tags AS t
        WHERE t.note_id = n.id
      ), '{}') AS tags,
      n.content_plain,
      count(*) OVER() AS total
    FROM notes AS n
    CROSS JOIN q
    WHERE n.deleted_at IS NULL
      AND n.search_vector @@ q.query
    ORDER BY ts_rank(n.search_vector, q.query) DESC, n.id ASC
    LIMIT ${SEARCH_PAGE_SIZE}
    OFFSET ${offset}
  `);
  const rows = result.rows as Array<{
    id: string;
    title: string;
    category: string | null;
    tags: string[];
    content_plain: string;
    updated_at: Date;
    version: number;
    total: number | string;
  }>;
  const total = rows[0] === undefined ? 0 : Number(rows[0].total);

  return {
    empty: false,
    hasNext: offset + rows.length < total,
    items: rows.map((row) => ({
      category: row.category,
      id: row.id,
      snippet: buildSearchSnippet(row.content_plain, query),
      tags: row.tags,
      title: row.title,
      updatedAt: row.updated_at,
      version: row.version,
    })),
    page: input.page,
    pageSize: SEARCH_PAGE_SIZE,
    query,
    total,
  };
}
