import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  assertTestDatabaseTargets,
  type TestDatabaseTargets,
} from "../../scripts/test-db-guard";
import {
  createDatabase,
  type DatabaseConnection,
} from "../../src/lib/db/client";
import type { LlmOperation } from "../../src/lib/ai/schemas";
import {
  createEditProposalService,
  type EditProposalService,
} from "../../src/lib/notes/proposals";
import {
  createRevisionService,
  type RevisionService,
} from "../../src/lib/notes/revisions";
import {
  createNoteService,
  createSeededNoteInTransaction,
  type NoteService,
} from "../../src/lib/notes/service";
import { searchNotesFullText } from "../../src/lib/search/fts";

const hasTestDatabase = Boolean(
  process.env.DATABASE_URL && process.env.TEST_DATABASE_URL,
);

describe.skipIf(!hasTestDatabase)("P33 materialized full-text index", () => {
  let connection: DatabaseConnection;
  let targets: TestDatabaseTargets;
  let notes: NoteService;
  let proposals: EditProposalService;
  let revisions: RevisionService;

  beforeAll(() => {
    targets = assertTestDatabaseTargets();
    connection = createDatabase(targets.testUrl);
    notes = createNoteService({ db: connection.db });
  });

  beforeEach(async () => {
    await connection.pool.query("TRUNCATE TABLE notes CASCADE");
    await connection.pool.query("TRUNCATE TABLE ai_usage");
    proposals = createEditProposalService({
      db: connection.db,
      noteService: notes,
      nonceFactory: () => "search-nonce-0123456789",
    });
    revisions = createRevisionService({
      db: connection.db,
      noteService: notes,
    });
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  async function vector(noteId: string): Promise<string | null> {
    const result = await connection.pool.query<{ vector: string | null }>(
      "select search_vector::text as vector from notes where id = $1",
      [noteId],
    );

    return result.rows[0]?.vector ?? null;
  }

  async function matches(noteId: string, query: string): Promise<boolean> {
    const result = await connection.pool.query<{ match: boolean }>(
      "select coalesce(search_vector @@ plainto_tsquery('simple', unaccent($2)), false) as match from notes where id = $1",
      [noteId, query],
    );

    return result.rows[0]?.match === true;
  }

  async function rank(noteId: string, query: string): Promise<number> {
    const result = await connection.pool.query<{ rank: number }>(
      "select ts_rank(search_vector, plainto_tsquery('simple', unaccent($2))) as rank from notes where id = $1",
      [noteId, query],
    );

    return result.rows[0]?.rank ?? 0;
  }

  async function contentMd(noteId: string): Promise<string> {
    const result = await connection.pool.query<{ content_md: string }>(
      "select content_md from notes where id = $1",
      [noteId],
    );

    return result.rows[0]?.content_md ?? "";
  }

  it("indexes accent variants and weights title above body", async () => {
    const titleNote = await notes.createNote({
      title: "Databáze",
      contentMd: "Jiný text.",
    });
    const bodyNote = await notes.createNote({
      title: "Jiný text",
      contentMd: "Databáze.",
    });

    expect(await vector(titleNote.id)).not.toBeNull();
    expect(await matches(titleNote.id, "databaze")).toBe(true);
    expect(await matches(bodyNote.id, "DATABÁZE")).toBe(true);
    expect(await rank(titleNote.id, "databaze")).toBeGreaterThan(
      await rank(bodyNote.id, "databaze"),
    );
  });

  it("refreshes body/title changes, tag changes and keeps Markdown exact", async () => {
    const note = await notes.createNote({
      title: "Původní titulek",
      contentMd: "Původní text.",
    });

    expect(await matches(note.id, "původní")).toBe(true);

    const updated = await notes.updateNote(note.id, {
      title: "Nový titulek",
      contentMd: "Nový text.",
      expectedVersion: 1,
    });
    expect(updated.version).toBe(2);
    expect(await matches(note.id, "původní")).toBe(false);
    expect(await matches(note.id, "nový")).toBe(true);
    expect(await contentMd(note.id)).toBe("Nový text.");

    const tagged = await notes.updateNoteMetadata(note.id, {
      category: "Práce",
      tags: ["archiv"],
      expectedVersion: 2,
    });
    expect(await matches(note.id, "archiv")).toBe(true);
    expect((await notes.getNote(note.id)).tags).toEqual(["archiv"]);
    expect(await contentMd(note.id)).toBe("Nový text.");

    const untagged = await notes.updateNoteMetadata(note.id, {
      category: "Práce",
      tags: [],
      expectedVersion: tagged.version,
    });
    expect(await matches(note.id, "archiv")).toBe(false);
    expect(untagged.version).toBe(4);
  });

  it("nulls the vector on soft delete, restores it, and indexes seed inserts", async () => {
    const note = await notes.createNote({
      title: "Smazatelná",
      contentMd: "Text pro koš.",
    });
    expect(await matches(note.id, "smazatelná")).toBe(true);

    const deleted = await notes.deleteNote(note.id, 1);
    expect(deleted.deletedAt).not.toBeNull();
    expect(await vector(note.id)).toBeNull();
    expect(await matches(note.id, "smazatelná")).toBe(false);

    const restored = await notes.restoreNote(note.id, deleted.version);
    expect(restored.deletedAt).toBeNull();
    expect(await vector(note.id)).not.toBeNull();
    expect(await matches(note.id, "smazatelná")).toBe(true);

    const seeded = await connection.db.transaction((tx) =>
      createSeededNoteInTransaction(tx, {
        seedKey: "search-test:1",
        title: "Seedovaná poznámka",
        contentMd: "Obsah seedu.",
        createdAt: new Date("2026-10-28T10:00:00.000Z"),
        updatedAt: new Date("2026-10-28T10:00:00.000Z"),
      }),
    );
    expect(await matches(seeded.id, "seedovaná")).toBe(true);
  });

  it("serves accent/case/quote/tag/pagination queries and excludes deleted notes without SQL injection", async () => {
    const migration = await notes.createNote({
      title: "Plán migrace PostgreSQL",
      contentMd: "Plán migrace databáze a testování.",
    });
    const tagged = await notes.createNote({
      title: "Archiv",
      contentMd: "Text bez hledaného výrazu.",
    });
    await notes.updateNoteMetadata(tagged.id, {
      category: "Práce",
      tags: ["archiv"],
      expectedVersion: 1,
    });

    const accent = await searchNotesFullText(connection.db, {
      page: 1,
      query: "databaze",
    });
    expect(accent.items.map((item) => item.id)).toContain(migration.id);
    expect(accent.items[0]?.snippet).toContain("[[[databáze]]]");

    const caseQuery = await searchNotesFullText(connection.db, {
      page: 1,
      query: "DATABÁZE",
    });
    expect(caseQuery.items.map((item) => item.id)).toContain(migration.id);

    const phrase = await searchNotesFullText(connection.db, {
      page: 1,
      query: '"plán migrace"',
    });
    expect(phrase.items.map((item) => item.id)).toContain(migration.id);
    expect(
      phrase.items.find((item) => item.id === migration.id)?.snippet,
    ).toContain("[[[Plán migrace]]]");
    const reversed = await searchNotesFullText(connection.db, {
      page: 1,
      query: '"migrace plán"',
    });
    expect(reversed.items.map((item) => item.id)).not.toContain(migration.id);

    const tagQuery = await searchNotesFullText(connection.db, {
      page: 1,
      query: "archiv",
    });
    expect(tagQuery.items.map((item) => item.id)).toContain(tagged.id);
    expect(tagQuery.items.find((item) => item.id === tagged.id)?.tags).toEqual([
      "archiv",
    ]);

    for (let index = 0; index < 11; index += 1) {
      await notes.createNote({
        title: `Hledaný termín ${index}`,
        contentMd: "Stejný text.",
      });
    }

    const firstPage = await searchNotesFullText(connection.db, {
      page: 1,
      query: "hledany",
    });
    expect(firstPage.items).toHaveLength(10);
    expect(firstPage.total).toBe(11);
    expect(firstPage.hasNext).toBe(true);
    expect(firstPage.items.map((item) => item.id)).toEqual(
      [...firstPage.items.map((item) => item.id)].sort(),
    );

    const secondPage = await searchNotesFullText(connection.db, {
      page: 2,
      query: "hledany",
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.hasNext).toBe(false);
    expect(
      [...firstPage.items, ...secondPage.items].map((item) => item.id),
    ).toHaveLength(11);

    await notes.deleteNote(migration.id, 1);
    const deleted = await searchNotesFullText(connection.db, {
      page: 1,
      query: "databaze",
    });
    expect(deleted.items.map((item) => item.id)).not.toContain(migration.id);

    const sqlLike = await searchNotesFullText(connection.db, {
      page: 1,
      query: "'; drop table notes; --",
    });
    expect(sqlLike.items).toEqual([]);
    expect(await notes.listActiveNotes(1)).toBeTruthy();
  });

  it("refreshes after P24 proposal apply and P25 Undo without changing unrelated Markdown", async () => {
    const note = await notes.createNote({
      title: "Návrh",
      contentMd: "První věta. Druhá věta.",
    });
    const operation: LlmOperation = {
      type: "replace_sentence",
      target: { startPhrase: "První", endPhrase: "věta" },
      text: "Nová věta.",
    };

    const created = await proposals.create(note.id, {
      operation,
      expectedVersion: 1,
    });
    const applied = await proposals.confirm(note.id, created.id, {
      confirmationNonce: created.confirmationNonce,
      expectedVersion: 1,
    });
    expect(applied.note.contentMd).toBe("Nová věta. Druhá věta.");
    expect(await matches(note.id, "nová")).toBe(true);
    expect(await matches(note.id, "první")).toBe(false);

    const history = await revisions.list(note.id);
    expect(history.canUndo).toBe(true);
    const undone = await revisions.restore(
      note.id,
      history.undoRevisionId!,
      {
        expectedVersion: applied.note.version,
        mode: "undo",
      },
    );
    expect(undone.contentMd).toBe("První věta. Druhá věta.");
    expect(await matches(note.id, "nová")).toBe(false);
    expect(await matches(note.id, "první")).toBe(true);
    expect(await contentMd(note.id)).toBe("První věta. Druhá věta.");
  });
});
