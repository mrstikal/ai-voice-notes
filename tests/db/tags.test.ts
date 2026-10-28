import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  assertTestDatabaseTargets,
  type TestDatabaseTargets,
} from "../../scripts/test-db-guard";
import {
  createDatabase,
  type DatabaseConnection,
} from "../../src/lib/db/client";
import {
  NoteConflictError,
  NoteNotFoundError,
  NoteValidationError,
  createNoteService,
  type NoteService,
} from "../../src/lib/notes/service";
import {
  createRevisionService,
  type RevisionService,
} from "../../src/lib/notes/revisions";

const hasTestDatabase = Boolean(
  process.env.DATABASE_URL && process.env.TEST_DATABASE_URL,
);

describe.skipIf(!hasTestDatabase)("P30 manual tags and categories", () => {
  let connection: DatabaseConnection;
  let targets: TestDatabaseTargets;
  let notes: NoteService;
  let revisions: RevisionService;

  beforeAll(() => {
    targets = assertTestDatabaseTargets();
    connection = createDatabase(targets.testUrl);
    notes = createNoteService({ db: connection.db });
  });

  beforeEach(async () => {
    await connection.pool.query("TRUNCATE TABLE notes CASCADE");
    await connection.pool.query("TRUNCATE TABLE ai_usage");
    revisions = createRevisionService({
      db: connection.db,
      noteService: notes,
    });
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  async function createNote(contentMd = "Text poznámky.") {
    return notes.createNote({ title: "Metadata", contentMd });
  }

  async function metadataRevisionCount(noteId: string): Promise<number> {
    const result = await connection.pool.query<{ count: number }>(
      "select count(*)::int as count from note_revisions where note_id = $1 and reason = 'metadata'",
      [noteId],
    );

    return result.rows[0]?.count ?? 0;
  }

  it("normalizes accents/case, de-duplicates tags and writes one metadata revision", async () => {
    const note = await createNote();

    const updated = await notes.updateNoteMetadata(note.id, {
      category: "Práce",
      tags: [" Práce ", "práce", "#škola", "Škola", "skola"],
      expectedVersion: note.version,
    });

    expect(updated).toMatchObject({
      category: "Práce",
      tags: ["Práce", "skola", "škola"],
      version: 2,
    });
    expect(await metadataRevisionCount(note.id)).toBe(1);

    const history = await revisions.list(note.id);
    const metadata = history.revisions.find(
      (revision) => revision.reason === "metadata",
    )!;
    expect(metadata.beforeSnapshot).toEqual({
      category: null,
      contentMd: "Text poznámky.",
      tags: [],
      title: "Metadata",
    });
    expect(metadata.afterSnapshot).toEqual({
      category: "Práce",
      contentMd: "Text poznámky.",
      tags: ["Práce", "skola", "škola"],
      title: "Metadata",
    });

    const unchanged = await notes.updateNoteMetadata(note.id, {
      category: "Práce",
      tags: ["Práce", "skola", "škola"],
      expectedVersion: 2,
    });
    expect(unchanged.version).toBe(2);
    expect(await metadataRevisionCount(note.id)).toBe(1);
  });

  it("treats collation-different but semantically equal tag sets as unchanged", async () => {
    const note = await createNote();
    const first = await notes.updateNoteMetadata(note.id, {
      category: "Práce",
      tags: ["škola", "zebra"],
      expectedVersion: 1,
    });
    expect(first.tags).toEqual(["zebra", "škola"]);

    const second = await notes.updateNoteMetadata(note.id, {
      category: "Práce",
      tags: ["zebra", "škola"],
      expectedVersion: first.version,
    });

    expect(second.version).toBe(first.version);
    expect(await metadataRevisionCount(note.id)).toBe(1);
  });

  it("rejects invalid categories, tag limits and stale versions without writing", async () => {
    const note = await createNote();

    await expect(
      notes.updateNoteMetadata(note.id, {
        category: "Jiné" as never,
        tags: [],
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(NoteValidationError);

    await expect(
      notes.updateNoteMetadata(note.id, {
        category: null,
        tags: ["x".repeat(33)],
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(NoteValidationError);

    await expect(
      notes.updateNoteMetadata(note.id, {
        category: null,
        tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`),
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(NoteValidationError);

    const updated = await notes.updateNoteMetadata(note.id, {
      category: "Studium",
      tags: ["škola"],
      expectedVersion: 1,
    });
    await expect(
      notes.updateNoteMetadata(note.id, {
        category: "Osobní",
        tags: [],
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(NoteConflictError);

    expect((await notes.getNote(note.id)).tags).toEqual(["škola"]);
    expect((await notes.getNote(note.id)).version).toBe(updated.version);
    expect(await metadataRevisionCount(note.id)).toBe(1);
  });

  it("P25 restore returns exactly the earlier category and tags", async () => {
    const note = await createNote("Původní obsah.");
    const metadata = await notes.updateNoteMetadata(note.id, {
      category: "Osobní",
      tags: ["práce", "škola"],
      expectedVersion: 1,
    });
    expect(metadata.version).toBe(2);

    const content = await notes.updateNote(note.id, {
      title: "Metadata",
      contentMd: "Novější obsah.",
      expectedVersion: 2,
    });
    expect(content.version).toBe(3);

    const history = await revisions.list(note.id);
    const metadataRevision = history.revisions.find(
      (revision) => revision.reason === "metadata",
    )!;

    const restored = await revisions.restore(note.id, metadataRevision.id, {
      mode: "restore",
      expectedVersion: 3,
    });

    expect(restored).toMatchObject({
      category: "Osobní",
      contentMd: "Původní obsah.",
      tags: ["práce", "škola"],
      version: 4,
    });
  });

  it("soft deletion hides metadata while hard seed deletion cascades note_tags", async () => {
    const note = await createNote();
    await notes.updateNoteMetadata(note.id, {
      category: "Schůzky",
      tags: ["tým"],
      expectedVersion: 1,
    });

    const deleted = await notes.deleteNote(note.id, 2);
    expect(deleted.deletedAt).not.toBeNull();
    await expect(notes.getNote(note.id)).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );

    const beforeHardDelete = await connection.pool.query<{ count: number }>(
      "select count(*)::int as count from note_tags where note_id = $1",
      [note.id],
    );
    expect(beforeHardDelete.rows[0]?.count).toBe(1);

    await connection.pool.query("delete from notes where id = $1", [note.id]);
    const afterHardDelete = await connection.pool.query<{ count: number }>(
      "select count(*)::int as count from note_tags where note_id = $1",
      [note.id],
    );
    expect(afterHardDelete.rows[0]?.count).toBe(0);
  });
});
