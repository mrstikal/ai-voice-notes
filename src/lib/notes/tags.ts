import { publicEnvInt } from "../env-limits.ts";
import { countGraphemes } from "./limits.ts";

export const NOTE_CATEGORIES = [
  "Práce",
  "Osobní",
  "Studium",
  "Schůzky",
  "Ostatní",
] as const;

export type NoteCategory = (typeof NOTE_CATEGORIES)[number];

export const NOTE_TAGS_MAX = publicEnvInt(
  process.env.NEXT_PUBLIC_NOTE_TAGS_MAX,
  "NEXT_PUBLIC_NOTE_TAGS_MAX",
  20,
);
export const NOTE_TAG_MAX_GRAPHEMES = publicEnvInt(
  process.env.NEXT_PUBLIC_NOTE_TAG_MAX_GRAPHEMES,
  "NEXT_PUBLIC_NOTE_TAG_MAX_GRAPHEMES",
  32,
);

export class NoteMetadataError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NoteMetadataError";
    this.code = code;
  }
}

export function isNoteCategory(value: unknown): value is NoteCategory {
  return (
    typeof value === "string" &&
    (NOTE_CATEGORIES as readonly string[]).includes(value)
  );
}

export function normalizeCategory(value: unknown): NoteCategory | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (!isNoteCategory(value)) {
    throw new NoteMetadataError(
      "invalid_category",
      "Neplatná kategorie. Vyberte jednu z povolených českých kategorií.",
    );
  }

  return value;
}

function normalizeTag(raw: string): string {
  const withoutHash = raw.replace(/^\s*#+/u, "");
  const tag = withoutHash.normalize("NFC").replace(/\s+/gu, " ").trim();

  if (tag === "") {
    throw new NoteMetadataError(
      "invalid_tag",
      "Tag nesmí být prázdný.",
    );
  }

  if (countGraphemes(tag) > NOTE_TAG_MAX_GRAPHEMES) {
    throw new NoteMetadataError(
      "invalid_tag",
      `Tag může mít nejvýše ${NOTE_TAG_MAX_GRAPHEMES} znaků.`,
    );
  }

  if (/[\p{Cc}\p{Cf}]/u.test(tag)) {
    throw new NoteMetadataError(
      "invalid_tag",
      "Tag obsahuje neplatné řídicí znaky.",
    );
  }

  return tag;
}

export function sortTags(tags: readonly string[]): string[] {
  return [...tags].sort();
}

export function normalizeTags(input: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const raw of input) {
    const tag = normalizeTag(raw);
    const comparison = tag.toLocaleLowerCase("cs-CZ");

    if (seen.has(comparison)) {
      continue;
    }

    seen.add(comparison);
    normalized.push(tag);
  }

  if (normalized.length > NOTE_TAGS_MAX) {
    throw new NoteMetadataError(
      "too_many_tags",
      `Poznámka může mít nejvýše ${NOTE_TAGS_MAX} tagů.`,
    );
  }

  return sortTags(normalized);
}

export function tagsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((tag, index) => tag === right[index]);
}

export function normalizeNoteMetadata(
  category: unknown,
  tags: readonly string[],
): { readonly category: NoteCategory | null; readonly tags: string[] } {
  return {
    category: normalizeCategory(category),
    tags: normalizeTags(tags),
  };
}
