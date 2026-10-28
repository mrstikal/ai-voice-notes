import { describe, expect, it } from "vitest";

import {
  NOTE_CATEGORIES,
  NOTE_TAGS_MAX,
  NOTE_TAG_MAX_GRAPHEMES,
  NoteMetadataError,
  normalizeCategory,
  normalizeNoteMetadata,
  normalizeTags,
  sortTags,
  tagsEqual,
} from "../../src/lib/notes/tags";
import {
  getNoteTags,
  type NotesExecutor,
} from "../../src/lib/notes/repository";

describe("P30 tag normalization", () => {
  it("uses one canonical order independent of input and database collation", () => {
    expect(normalizeTags(["škola", "zebra"])).toEqual(["zebra", "škola"]);
    expect(normalizeTags(["zebra", "škola"])).toEqual(["zebra", "škola"]);
    expect(sortTags(["škola", "zebra"])).toEqual(["zebra", "škola"]);
    expect(tagsEqual(["zebra", "škola"], ["zebra", "škola"])).toBe(true);
    expect(tagsEqual(["škola", "zebra"], ["zebra", "škola"])).toBe(false);
  });

  it("de-duplicates case-insensitively, preserves accents and strips leading hashes", () => {
    expect(
      normalizeTags([" Práce ", "práce", "#škola", "Škola", "skola"]),
    ).toEqual(["Práce", "skola", "škola"]);
  });

  it("accepts exactly the five Czech categories or null", () => {
    expect(NOTE_CATEGORIES).toEqual([
      "Práce",
      "Osobní",
      "Studium",
      "Schůzky",
      "Ostatní",
    ]);
    expect(normalizeCategory("Práce")).toBe("Práce");
    expect(normalizeCategory("")).toBeNull();
    expect(normalizeCategory(null)).toBeNull();
    expect(() => normalizeCategory("Jiné")).toThrow(NoteMetadataError);
  });

  it("rejects empty, oversized and over-limit tags", () => {
    expect(() => normalizeTags(["  "])).toThrow(NoteMetadataError);
    expect(() =>
      normalizeTags(["a".repeat(NOTE_TAG_MAX_GRAPHEMES + 1)]),
    ).toThrow(NoteMetadataError);
    expect(() =>
      normalizeTags(
        Array.from({ length: NOTE_TAGS_MAX + 1 }, (_, index) => `tag-${index}`),
      ),
    ).toThrow(NoteMetadataError);
    expect(
      normalizeNoteMetadata("Osobní", ["  #práce  "]),
    ).toEqual({ category: "Osobní", tags: ["práce"] });
  });
});

describe("P30 tag read-path wiring", () => {
  it("canonicalizes tags returned from the database regardless of DB order", async () => {
    const rows = [{ tag: "škola" }, { tag: "zebra" }];
    const executor = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: async () => rows,
          }),
        }),
      }),
    } as unknown as NotesExecutor;

    await expect(getNoteTags(executor, "note-id")).resolves.toEqual([
      "zebra",
      "škola",
    ]);
  });
});
