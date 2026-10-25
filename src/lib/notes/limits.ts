export const TITLE_MAX_GRAPHEMES = 160;
export const CONTENT_MAX_GRAPHEMES = 20_000;

const graphemeSegmenter = new Intl.Segmenter("cs", { granularity: "grapheme" });

export type NoteLimitField = "title" | "content";

export interface NoteGraphemeLimits {
  readonly title: number;
  readonly content: number;
}

export const DEFAULT_NOTE_GRAPHEME_LIMITS = {
  title: TITLE_MAX_GRAPHEMES,
  content: CONTENT_MAX_GRAPHEMES,
} as const satisfies NoteGraphemeLimits;

export class NoteLimitError extends Error {
  readonly field: NoteLimitField;
  readonly limit: number;
  readonly actual: number;

  constructor(field: NoteLimitField, limit: number, actual: number) {
    super(
      field === "title"
        ? `Název může mít nejvýše ${limit} viditelných znaků. Aktuálně má ${actual}.`
        : `Poznámka může mít nejvýše ${limit} viditelných znaků. Aktuálně má ${actual}.`,
    );
    this.name = "NoteLimitError";
    this.field = field;
    this.limit = limit;
    this.actual = actual;
  }
}

function assertValidLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("Limit musí být kladné celé číslo.");
  }
}

export function countGraphemes(value: string): number {
  return Array.from(graphemeSegmenter.segment(value)).length;
}

export function assertTitleGraphemeLimit(
  title: string,
  limit: number = TITLE_MAX_GRAPHEMES,
): number {
  assertValidLimit(limit);

  const actual = countGraphemes(title);
  if (actual > limit) {
    throw new NoteLimitError("title", limit, actual);
  }

  return actual;
}

export function assertContentGraphemeLimit(
  actual: number,
  limit: number = CONTENT_MAX_GRAPHEMES,
): void {
  assertValidLimit(limit);

  if (!Number.isInteger(actual) || actual < 0) {
    throw new RangeError("Počet grafémů musí být nezáporné celé číslo.");
  }

  if (actual > limit) {
    throw new NoteLimitError("content", limit, actual);
  }
}

export function validateNoteGraphemeLimits(
  title: string,
  contentGraphemeCount: number,
  limits: NoteGraphemeLimits = DEFAULT_NOTE_GRAPHEME_LIMITS,
): { titleGraphemes: number; contentGraphemes: number } {
  const titleGraphemes = assertTitleGraphemeLimit(title, limits.title);
  assertContentGraphemeLimit(contentGraphemeCount, limits.content);

  return { titleGraphemes, contentGraphemes: contentGraphemeCount };
}
