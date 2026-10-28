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
  createNoteService,
  createSeededNoteInTransaction,
  type NoteService,
} from "../../src/lib/notes/service";
import {
  getIndexStatuses,
  getNoteIndexStatus,
  refreshNoteChunks,
} from "../../src/lib/search/index-state";

const hasTestDatabase = Boolean(
  process.env.DATABASE_URL && process.env.TEST_DATABASE_URL,
);

describe.skipIf(!hasTestDatabase)("P35 pending chunk index state", () => {
  let connection: DatabaseConnection;
  let targets: TestDatabaseTargets;
  let notes: NoteService;

  beforeAll(() => {
    targets = assertTestDatabaseTargets();
    connection = createDatabase(targets.testUrl);
    notes = createNoteService({ db: connection.db });
  });

  beforeEach(async () => {
    await connection.pool.query("TRUNCATE TABLE notes CASCADE");
    await connection.pool.query("TRUNCATE TABLE ai_usage");
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  async function chunkRows(noteId: string) {
    const result = await connection.pool.query<{
      note_version: number;
      chunk_index: number;
      status: string;
      model: string;
      text: string;
    }>(
      "select note_version, chunk_index, status, model, text from note_chunks where note_id = $1 order by note_version, chunk_index",
      [noteId],
    );

    return result.rows;
  }

  it("creates current-version pending chunks on create and content changes", async () => {
    const note = await notes.createNote({
      title: "Chunky",
      contentMd: "První odstavec. Druhý odstavec.",
    });

    expect(await getNoteIndexStatus(connection.db, note.id)).toBe("pending");
    const firstChunks = await chunkRows(note.id);
    expect(firstChunks.length).toBeGreaterThan(0);
    expect(firstChunks.every((chunk) => chunk.note_version === 1)).toBe(true);
    expect(firstChunks.every((chunk) => chunk.status === "pending")).toBe(true);
    expect(firstChunks.every((chunk) => chunk.model === "pending")).toBe(true);

    const updated = await notes.updateNote(note.id, {
      title: "Chunky",
      contentMd: "Nový odstavec. Další text.",
      expectedVersion: 1,
    });
    expect(updated.version).toBe(2);
    expect(await getNoteIndexStatus(connection.db, note.id)).toBe("pending");
    const allChunks = await chunkRows(note.id);
    expect(allChunks.some((chunk) => chunk.note_version === 1)).toBe(true);
    expect(allChunks.filter((chunk) => chunk.note_version === 2)).not.toHaveLength(0);
  });

  it("only current-version success makes a note ready; older ready chunks never do", async () => {
    const note = await notes.createNote({
      title: "Stav",
      contentMd: "První verze.",
    });

    await connection.pool.query(
      "update note_chunks set status = 'ready', model = 'test-model' where note_id = $1 and note_version = 1",
      [note.id],
    );
    expect(await getNoteIndexStatus(connection.db, note.id)).toBe("ready");

    const updated = await notes.updateNote(note.id, {
      title: "Stav",
      contentMd: "Druhá verze.",
      expectedVersion: 1,
    });
    expect(await getNoteIndexStatus(connection.db, note.id)).toBe("pending");

    await connection.pool.query(
      "update note_chunks set status = 'ready' where note_id = $1 and note_version = $2",
      [note.id, updated.version],
    );
    expect(await getNoteIndexStatus(connection.db, note.id)).toBe("ready");

    await connection.pool.query(
      "update note_chunks set status = 'error' where note_id = $1 and note_version = $2 and chunk_index = 0",
      [note.id, updated.version],
    );
    expect(await getNoteIndexStatus(connection.db, note.id)).toBe("error");
  });

  it("reports no_content, pending pre-P35 notes and batch statuses", async () => {
    const empty = await notes.createNote({
      title: "Prázdná",
      contentMd: "",
    });
    expect(await getNoteIndexStatus(connection.db, empty.id)).toBe(
      "no_content",
    );

    const legacy = await notes.createNote({
      title: "Před P35",
      contentMd: "Existující text bez chunků.",
    });
    await connection.pool.query("delete from note_chunks where note_id = $1", [
      legacy.id,
    ]);
    expect(await getNoteIndexStatus(connection.db, legacy.id)).toBe(
      "pending",
    );

    const statuses = await getIndexStatuses(connection.db, [
      empty.id,
      legacy.id,
    ]);
    expect(statuses.get(empty.id)).toBe("no_content");
    expect(statuses.get(legacy.id)).toBe("pending");
  });

  it("keeps current-version chunk rows through metadata and voice-title version bumps", async () => {
    const note = await notes.createNote({
      title: "Původní titulek",
      contentMd: "Obsah bez změny.",
    });
    await connection.pool.query(
      "update note_chunks set status = 'ready' where note_id = $1 and note_version = 1",
      [note.id],
    );

    const tagged = await notes.updateNoteMetadata(note.id, {
      category: "Práce",
      tags: ["archiv"],
      expectedVersion: 1,
    });
    expect(await getNoteIndexStatus(connection.db, note.id)).toBe("pending");
    expect(
      (await chunkRows(note.id)).some(
        (chunk) =>
          chunk.note_version === tagged.version && chunk.status === "pending",
      ),
    ).toBe(true);

    const titled = await notes.updateNoteTitle(note.id, {
      title: "Nový titulek",
      expectedVersion: tagged.version,
    });
    expect(await getNoteIndexStatus(connection.db, note.id)).toBe("pending");
    expect(
      (await chunkRows(note.id)).some(
        (chunk) =>
          chunk.note_version === titled.version && chunk.status === "pending",
      ),
    ).toBe(true);
  });

  it("draft autosave creates pending current-version chunks and makes no AI call", async () => {
    const note = await notes.createNote({
      title: "Autosave",
      contentMd: "První verze.",
    });

    await connection.pool.query(
      "update note_chunks set status = 'ready' where note_id = $1 and note_version = 1",
      [note.id],
    );

    const draft = await notes.updateNote(note.id, {
      title: "Autosave",
      contentMd: "Rozpracovaná verze.",
      expectedVersion: 1,
      draft: true,
    });

    expect(draft.version).toBe(2);
    expect(await getNoteIndexStatus(connection.db, note.id)).toBe("pending");
    expect(
      (await chunkRows(note.id)).some(
        (chunk) =>
          chunk.note_version === 2 && chunk.status === "pending",
      ),
    ).toBe(true);

    const usage = await connection.pool.query<{ count: number }>(
      "select count(*)::int as count from ai_usage",
    );
    expect(usage.rows[0]?.count).toBe(0);
  });

  it("P07B seeded insert prepares pending chunks and survives a restart", async () => {
    const seeded = await connection.db.transaction((tx) =>
      createSeededNoteInTransaction(tx, {
        seedKey: "index-state:seed",
        title: "Seed index",
        contentMd: "Seedovaný obsah.",
        createdAt: new Date("2026-10-28T10:00:00.000Z"),
        updatedAt: new Date("2026-10-28T10:00:00.000Z"),
      }),
    );

    expect(await getNoteIndexStatus(connection.db, seeded.id)).toBe("pending");
    expect((await chunkRows(seeded.id)).length).toBeGreaterThan(0);

    const secondConnection = createDatabase(targets.testUrl);

    try {
      expect(await getNoteIndexStatus(secondConnection.db, seeded.id)).toBe(
        "pending",
      );
    } finally {
      await secondConnection.pool.end();
    }
  });

  it("refreshes current chunks without deleting older diagnostic versions", async () => {
    const note = await notes.createNote({
      title: "Diagnóza",
      contentMd: "První verze.",
    });

    await notes.updateNote(note.id, {
      title: "Diagnóza",
      contentMd: "Druhá verze.",
      expectedVersion: 1,
    });
    await refreshNoteChunks(connection.db, {
      id: note.id,
      contentMd: "Třetí verze.",
      version: 3,
    });

    const rows = await chunkRows(note.id);
    expect(new Set(rows.map((row) => row.note_version))).toEqual(
      new Set([1, 2, 3]),
    );
  });
});
