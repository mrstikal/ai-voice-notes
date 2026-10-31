import { describe, expect, it } from "vitest";

import {
  readStoredDraft,
  syncStoredDraft,
  writeStoredDraft,
} from "../../src/lib/notes/draft";

class FakeStorage implements Storage {
  readonly items = new Map<string, string>();
  failSetItem = false;

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.failSetItem) {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    }

    this.items.set(key, value);
  }
}

const noteId = "11111111-1111-4111-8111-111111111111";

describe("note draft recovery safety", () => {
  it("keeps an older draft when the replacement write exceeds quota", () => {
    const storage = new FakeStorage();

    writeStoredDraft(
      {
        noteId,
        baseVersion: 1,
        contentMd: "Původní koncept",
        savedAt: "2026-10-31T10:00:00.000Z",
      },
      storage,
    );
    storage.failSetItem = true;

    writeStoredDraft(
      {
        noteId,
        baseVersion: 2,
        contentMd: "Novější koncept",
        savedAt: "2026-10-31T10:05:00.000Z",
      },
      storage,
    );

    expect(readStoredDraft(noteId, storage)?.contentMd).toBe("Původní koncept");
  });

  it("does not clear recovery drafts when visual serialization returns null", () => {
    const storage = new FakeStorage();

    writeStoredDraft(
      {
        noteId,
        baseVersion: 3,
        contentMd: "Rozpracované změny",
        savedAt: "2026-10-31T10:00:00.000Z",
      },
      storage,
    );

    syncStoredDraft({
      acknowledgedContentMd: "Uložený text",
      baseVersion: 4,
      currentContentMd: null,
      noteId,
      storage,
    });

    expect(readStoredDraft(noteId, storage)?.contentMd).toBe(
      "Rozpracované změny",
    );
  });
});
