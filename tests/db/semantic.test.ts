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
  type NoteService,
} from "../../src/lib/notes/service";
import { countGraphemes } from "../../src/lib/notes/limits";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_ID,
} from "../../src/lib/search/embeddings";
import {
  SEMANTIC_EXCERPT_MAX_GRAPHEMES,
  SemanticSearchError,
  buildSemanticExcerpt,
  searchNotesSemantic,
} from "../../src/lib/search/semantic";

const hasTestDatabase = Boolean(
  process.env.DATABASE_URL && process.env.TEST_DATABASE_URL,
);

function basis(index: number, value = 1): number[] {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);

  vector[index] = value;

  return vector;
}

function literal(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

describe.skipIf(!hasTestDatabase)("P37 semantic query", () => {
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

  async function chunkRows(noteId: string, version: number) {
    const result = await connection.pool.query<{
      id: string;
      chunk_index: number;
      text: string;
    }>(
      `SELECT id, chunk_index, text
       FROM note_chunks
       WHERE note_id = $1 AND note_version = $2
       ORDER BY chunk_index`,
      [noteId, version],
    );

    return result.rows;
  }

  async function setVector(
    chunkId: string,
    vector: readonly number[],
    model = EMBEDDING_MODEL_ID,
  ): Promise<void> {
    await connection.pool.query(
      `UPDATE note_chunks
       SET status = 'ready', model = $1, embedding = $2::vector
       WHERE id = $3`,
      [model, literal(vector), chunkId],
    );
  }

  async function setPending(chunkId: string): Promise<void> {
    await connection.pool.query(
      `UPDATE note_chunks
       SET status = 'pending', model = 'pending', embedding = NULL
       WHERE id = $1`,
      [chunkId],
    );
  }

  async function readyNote(
    title: string,
    vector: readonly number[],
    content = `Poznámka ${title} o migraci databáze.`,
  ) {
    const note = await notes.createNote({
      title,
      contentMd: content,
    });
    const chunks = await chunkRows(note.id, note.version);

    for (const [index, chunk] of chunks.entries()) {
      await setVector(chunk.id, index === 0 ? vector : basis(1));
    }

    return note;
  }

  it("ranks the closest note and aggregates only its best chunk", async () => {
    const best = await readyNote("Nejlepší", basis(0));
    const middle = await readyNote("Střední", basis(1));
    const far = await readyNote("Daleká", basis(0, -1));

    const result = await searchNotesSemantic(connection.db, {
      query: "migrace",
      page: 1,
      vector: basis(0),
      modelId: EMBEDDING_MODEL_ID,
    });

    expect(result.items.map((item) => item.id)).toEqual([
      best.id,
      middle.id,
      far.id,
    ]);
    expect(result.total).toBe(3);
    expect(result.model).toBe(EMBEDDING_MODEL_ID);
    expect(result.items[0]?.excerpt).toContain("Nejlepší");
  });

  it("uses the best chunk text and one row per note when a note has several chunks", async () => {
    const note = await notes.createNote({
      title: "Více chunků",
      contentMd:
        "# První\n\nŠpatný kontext o migraci.\n\n# Druhý\n\nNejlepší kontext o migraci databáze.",
    });
    const chunks = await chunkRows(note.id, note.version);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    await setVector(chunks[0]!.id, basis(1));
    await setVector(chunks[1]!.id, basis(0));

    const result = await searchNotesSemantic(connection.db, {
      query: "migrace",
      page: 1,
      vector: basis(0),
      modelId: EMBEDDING_MODEL_ID,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe(note.id);
    expect(result.items[0]?.excerpt).toContain("Nejlepší");
  });

  it("never returns deleted, other-version or other-model chunks", async () => {
    const current = await readyNote("Aktuální", basis(0));
    const deleted = await readyNote("Smazaná", basis(0), "Smazaná poznámka.");
    const otherModel = await readyNote("Jiný model", basis(0));
    const otherVersion = await notes.createNote({
      title: "Jiná verze",
      contentMd: "Původní verze o migraci.",
    });
    const oldChunks = await chunkRows(otherVersion.id, otherVersion.version);

    await setVector(oldChunks[0]!.id, basis(0));
    const updated = await notes.updateNote(otherVersion.id, {
      title: otherVersion.title,
      contentMd: "Nová verze o migraci.",
      expectedVersion: otherVersion.version,
    });

    expect(updated.version).toBe(2);

    await notes.deleteNote(deleted.id, deleted.version);

    const otherModelChunks = await chunkRows(
      otherModel.id,
      otherModel.version,
    );

    await setVector(otherModelChunks[0]!.id, basis(0), "other/model");

    const result = await searchNotesSemantic(connection.db, {
      query: "migrace",
      page: 1,
      vector: basis(0),
      modelId: EMBEDDING_MODEL_ID,
    });

    expect(result.items.map((item) => item.id)).toEqual([current.id]);
    expect(result.total).toBe(1);
  });

  it("uses only current-version pending chunks as non-results", async () => {
    const note = await readyNote("Čeká", basis(0));
    const rows = await chunkRows(note.id, note.version);

    await setPending(rows[0]!.id);

    const result = await searchNotesSemantic(connection.db, {
      query: "migrace",
      page: 1,
      vector: basis(0),
      modelId: EMBEDDING_MODEL_ID,
    });

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("pages deterministically and reports hasNext", async () => {
    const ids: string[] = [];

    for (let index = 0; index < 12; index += 1) {
      const note = await readyNote(`Stránka ${index}`, basis(0));
      ids.push(note.id);
    }

    const first = await searchNotesSemantic(connection.db, {
      query: "migrace",
      page: 1,
      vector: basis(0),
      modelId: EMBEDDING_MODEL_ID,
    });
    const second = await searchNotesSemantic(connection.db, {
      query: "migrace",
      page: 2,
      vector: basis(0),
      modelId: EMBEDDING_MODEL_ID,
    });

    expect(first.items).toHaveLength(10);
    expect(first.total).toBe(12);
    expect(first.hasNext).toBe(true);
    expect(second.items).toHaveLength(2);
    expect(second.hasNext).toBe(false);
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(
      [...ids].sort(),
    );

    const beyond = await searchNotesSemantic(connection.db, {
      query: "migrace",
      page: 50,
      vector: basis(0),
      modelId: EMBEDDING_MODEL_ID,
    });

    expect(beyond.items).toHaveLength(0);
    expect(beyond.total).toBe(12);
    expect(beyond.hasNext).toBe(false);
  });

  it("does not write query data into note tables", async () => {
    await readyNote("Beze změny", basis(0));

    const beforeChunks = await connection.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM note_chunks",
    );
    const beforeNotes = await connection.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM notes",
    );
    const beforeUsage = await connection.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM ai_usage",
    );

    await searchNotesSemantic(connection.db, {
      query: "migrace",
      page: 1,
      vector: basis(0),
      modelId: EMBEDDING_MODEL_ID,
    });

    const afterChunks = await connection.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM note_chunks",
    );
    const afterNotes = await connection.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM notes",
    );
    const afterUsage = await connection.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM ai_usage",
    );

    expect(afterChunks.rows[0]?.count).toBe(beforeChunks.rows[0]?.count);
    expect(afterNotes.rows[0]?.count).toBe(beforeNotes.rows[0]?.count);
    expect(afterUsage.rows[0]?.count).toBe(beforeUsage.rows[0]?.count);
  });

  it("rejects a wrong query vector and an invalid page", async () => {
    await expect(
      searchNotesSemantic(connection.db, {
        query: "migrace",
        page: 1,
        vector: [1, 2, 3],
        modelId: EMBEDDING_MODEL_ID,
      }),
    ).rejects.toMatchObject({
      code: "semantic_query_dimension_mismatch",
    });

    await expect(
      searchNotesSemantic(connection.db, {
        query: "migrace",
        page: 0,
        vector: basis(0),
        modelId: EMBEDDING_MODEL_ID,
      }),
    ).rejects.toBeInstanceOf(SemanticSearchError);
  });

  it("bounds the excerpt by graphemes and preserves surrogate pairs", () => {
    const long = `${"😀".repeat(300)} konec`;
    const excerpt = buildSemanticExcerpt(long, 50);

    expect(countGraphemes(excerpt)).toBeLessThanOrEqual(51);
    expect(SEMANTIC_EXCERPT_MAX_GRAPHEMES).toBe(240);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt).not.toContain("\uFFFD");
  });
});
