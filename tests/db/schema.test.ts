import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  assertTestDatabaseTargets,
  TestDatabaseGuardError,
  type TestDatabaseTargets,
} from "../../scripts/test-db-guard";
import { createDatabase, closeDb, getPool, type DatabaseConnection } from "../../src/lib/db/client";
import {
  aiBudget,
  aiUsage,
  noteChunks,
  noteRevisions,
  noteTags,
  notes,
  type NoteSnapshot,
} from "../../src/lib/db/schema";

const DEV_URL = "postgresql://user:password@127.0.0.1:5432/ai_voice_notes";
const TEST_URL = "postgresql://user:password@127.0.0.1:5433/ai_voice_notes_test";

describe("test database guard", () => {
  it("accepts a distinct loopback test target", () => {
    const targets = assertTestDatabaseTargets({
      DATABASE_URL: DEV_URL,
      TEST_DATABASE_URL: TEST_URL,
    });

    expect(targets).toMatchObject({
      devUrl: DEV_URL,
      testUrl: TEST_URL,
      testDatabaseName: "ai_voice_notes_test",
      testHost: "127.0.0.1",
    });
  });

  it("accepts localhost and IPv6 loopback test hosts", () => {
    expect(
      assertTestDatabaseTargets({
        DATABASE_URL: DEV_URL,
        TEST_DATABASE_URL:
          "postgresql://user:password@localhost:5433/ai_voice_notes_test",
      }).testHost,
    ).toBe("localhost");

    expect(
      assertTestDatabaseTargets({
        DATABASE_URL: DEV_URL,
        TEST_DATABASE_URL:
          "postgresql://user:password@[::1]:5433/ai_voice_notes_test",
      }).testHost,
    ).toBe("[::1]");
  });

  it("rejects missing, malformed, or non-PostgreSQL URLs", () => {
    expect(() => assertTestDatabaseTargets({})).toThrow(TestDatabaseGuardError);
    expect(() =>
      assertTestDatabaseTargets({ DATABASE_URL: DEV_URL }),
    ).toThrow(/TEST_DATABASE_URL/);
    expect(() =>
      assertTestDatabaseTargets({
        DATABASE_URL: DEV_URL,
        TEST_DATABASE_URL: "not-a-url",
      }),
    ).toThrow(TestDatabaseGuardError);
    expect(() =>
      assertTestDatabaseTargets({
        DATABASE_URL: DEV_URL,
        TEST_DATABASE_URL: "mysql://user:password@127.0.0.1:3306/ai_voice_notes_test",
      }),
    ).toThrow(TestDatabaseGuardError);
    expect(() =>
      assertTestDatabaseTargets({
        DATABASE_URL: DEV_URL,
        TEST_DATABASE_URL: "postgresql://127.0.0.1:5433",
      }),
    ).toThrow(TestDatabaseGuardError);
  });

  it("rejects the same configured target", () => {
    expect(() =>
      assertTestDatabaseTargets({
        DATABASE_URL: TEST_URL,
        TEST_DATABASE_URL: TEST_URL,
      }),
    ).toThrow(TestDatabaseGuardError);
  });

  it("rejects a test database name without the _test suffix", () => {
    expect(() =>
      assertTestDatabaseTargets({
        DATABASE_URL: DEV_URL,
        TEST_DATABASE_URL:
          "postgresql://user:password@127.0.0.1:5433/ai_voice_notes",
      }),
    ).toThrow(/končícím na _test/);
  });

  it("rejects a non-loopback test host", () => {
    expect(() =>
      assertTestDatabaseTargets({
        DATABASE_URL: DEV_URL,
        TEST_DATABASE_URL:
          "postgresql://user:password@db.example.com:5433/ai_voice_notes_test",
      }),
    ).toThrow(/loopback/);
  });

  it("rejects a test URL without an explicit port", () => {
    expect(() =>
      assertTestDatabaseTargets({
        DATABASE_URL: DEV_URL,
        TEST_DATABASE_URL:
          "postgresql://user:password@127.0.0.1/ai_voice_notes_test",
      }),
    ).toThrow(/explicitní port/);
  });

  it("rejects query parameters that could override the test target", () => {
    expect(() =>
      assertTestDatabaseTargets({
        DATABASE_URL: DEV_URL,
        TEST_DATABASE_URL:
          "postgresql://user:password@127.0.0.1:5433/ai_voice_notes_test?host=db.example.com",
      }),
    ).toThrow(/query parametrech/);
  });

  it("rejects the same database name on different ports", () => {
    expect(() =>
      assertTestDatabaseTargets({
        DATABASE_URL:
          "postgresql://user:password@127.0.0.1:5432/ai_voice_notes_test",
        TEST_DATABASE_URL:
          "postgresql://user:password@127.0.0.1:5433/ai_voice_notes_test",
      }),
    ).toThrow(/jiný název/);
  });
});

const hasTestDatabase = Boolean(
  process.env.DATABASE_URL && process.env.TEST_DATABASE_URL,
);

const defaultSnapshot: NoteSnapshot = {
  title: "Testovací poznámka",
  contentMd: "**Test**",
  category: null,
  tags: [],
};

describe.skipIf(!hasTestDatabase)("isolated database schema", () => {
  let connection: DatabaseConnection;
  let targets: TestDatabaseTargets;

  beforeAll(() => {
    targets = assertTestDatabaseTargets();
    connection = createDatabase(targets.testUrl);
  });

  beforeEach(async () => {
    await connection.pool.query("TRUNCATE TABLE notes CASCADE");
    await connection.pool.query("TRUNCATE TABLE ai_usage");
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  async function insertNote(
    overrides: Partial<typeof notes.$inferInsert> = {},
  ): Promise<typeof notes.$inferSelect> {
    const rows = await connection.db
      .insert(notes)
      .values({
        title: "Testovací poznámka",
        contentMd: "**Test**",
        contentPlain: "Test",
        ...overrides,
      })
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error("Poznámka nebyla vložena.");
    }

    return row;
  }

  async function insertRevision(
    noteId: string,
    noteVersion = 1,
    reason = "initial",
    beforeSnapshot: NoteSnapshot = defaultSnapshot,
    afterSnapshot: NoteSnapshot = defaultSnapshot,
  ): Promise<typeof noteRevisions.$inferSelect> {
    const rows = await connection.db
      .insert(noteRevisions)
      .values({
        noteId,
        noteVersion,
        reason,
        beforeSnapshot,
        afterSnapshot,
      })
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error("Revize nebyla vložena.");
    }

    return row;
  }

  async function insertTag(noteId: string, tag = "test"): Promise<void> {
    await connection.db.insert(noteTags).values({ noteId, tag });
  }

  async function insertChunk(
    noteId: string,
    chunkIndex = 0,
    embedding: number[] | null = null,
  ): Promise<typeof noteChunks.$inferSelect> {
    const rows = await connection.db
      .insert(noteChunks)
      .values({
        noteId,
        noteVersion: 1,
        chunkIndex,
        text: "Testovací chunk",
        embedding,
        model: "test-model",
        status: "ready",
      })
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error("Chunk nebyl vložen.");
    }

    return row;
  }

  it("creates the required extensions and tables", async () => {
    const extensions = await connection.pool.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = ANY($1::text[]) ORDER BY extname",
      [["vector", "unaccent", "pg_trgm"]],
    );
    expect(extensions.rows.map((row) => row.extname)).toEqual([
      "pg_trgm",
      "unaccent",
      "vector",
    ]);

    const tables = await connection.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name",
      [
        [
          "ai_budget",
          "ai_usage",
          "edit_proposals",
          "note_chunks",
          "note_revisions",
          "note_tags",
          "notes",
        ],
      ],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "ai_budget",
      "ai_usage",
      "edit_proposals",
      "note_chunks",
      "note_revisions",
      "note_tags",
      "notes",
    ]);
  });

  it("creates the documented indexes, including the partial active-note index", async () => {
    const expectedIndexes = [
      "ai_usage_started_at_idx",
      "ai_usage_status_idx",
      "edit_proposals_note_status_expires_idx",
      "edit_proposals_status_expires_idx",
      "note_chunks_note_version_chunk_unique",
      "note_chunks_note_version_idx",
      "note_revisions_note_created_at_idx",
      "note_revisions_note_version_unique",
      "note_tags_tag_idx",
      "notes_active_created_at_id_idx",
      "notes_deleted_at_idx",
    ].sort();

    const indexes = await connection.pool.query<{
      indexname: string;
      indexdef: string;
    }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[]) ORDER BY indexname",
      [expectedIndexes],
    );

    expect(indexes.rows.map((row) => row.indexname)).toEqual(expectedIndexes);
    expect(
      indexes.rows.find((row) => row.indexname === "notes_active_created_at_id_idx")
        ?.indexdef,
    ).toContain("WHERE");
  });

  it("applies note defaults and allows nullable unique seed keys", async () => {
    const first = await insertNote();
    const second = await insertNote({ seedKey: null });

    expect(first.version).toBe(1);
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.createdAt).toBeInstanceOf(Date);
    expect(first.updatedAt).toBeInstanceOf(Date);
    expect(first.deletedAt).toBeNull();
    expect(first.seedKey).toBeNull();
    expect(second.seedKey).toBeNull();
  });

  it("enforces edit-proposal status, hash and JSON constraints", async () => {
    const note = await insertNote();
    const insert = (status: string, hash: string) =>
      connection.pool.query(
        `INSERT INTO edit_proposals
          (note_id, note_title, expected_version, original_hash, operation,
           before_md, after_md, status, confirmation_nonce_hash, expires_at)
         VALUES ($1, 'Návrh', 1, $2, '{}'::jsonb, 'Před', 'Po', $3, $2, now() + interval '5 minutes')`,
        [note.id, hash, status],
      );

    await expect(insert("bogus", "a".repeat(64))).rejects.toMatchObject({
      code: "23514",
    });
    await expect(insert("pending", "not-hex")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      connection.pool.query(
        `INSERT INTO edit_proposals
          (note_id, note_title, expected_version, original_hash, operation,
           before_md, after_md, status, confirmation_nonce_hash, expires_at)
         VALUES ($1, 'Návrh', 1, $2, '[]'::jsonb, 'Před', 'Po', 'pending', $2, now() + interval '5 minutes')`,
        [note.id, "a".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces unique seed keys and the positive note version", async () => {
    const note = await insertNote({ seedKey: "seed-1" });

    await expect(
      connection.pool.query(
        "INSERT INTO notes (seed_key, title, content_md, content_plain) VALUES ($1, $2, $3, $4)",
        ["seed-1", "Duplikát", "Duplikát", "Duplikát"],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      connection.pool.query("UPDATE notes SET version = 0 WHERE id = $1", [
        note.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps soft-deleted notes and their data until explicitly purged", async () => {
    const note = await insertNote();
    const deletedAt = new Date();

    const rows = await connection.db
      .update(notes)
      .set({ deletedAt })
      .where(eq(notes.id, note.id))
      .returning();
    expect(rows[0]?.deletedAt).toBeInstanceOf(Date);

    const count = await connection.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM notes WHERE id = $1",
      [note.id],
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it("cascades revision, tag, and chunk deletion with the note", async () => {
    const note = await insertNote();
    await insertRevision(note.id);
    await insertTag(note.id);
    await insertChunk(note.id);

    await connection.db.delete(notes).where(eq(notes.id, note.id));

    for (const table of ["note_revisions", "note_tags", "note_chunks"]) {
      const count = await connection.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${table} WHERE note_id = $1`,
        [note.id],
      );
      expect(count.rows[0]?.count).toBe(0);
    }
  });

  it("stores revision snapshots and enforces revision constraints", async () => {
    const note = await insertNote();
    const beforeSnapshot: NoteSnapshot = {
      title: "Před",
      contentMd: "**Před**",
      category: null,
      tags: ["před"],
    };
    const afterSnapshot: NoteSnapshot = {
      title: "Po",
      contentMd: "**Po**",
      category: "práce",
      tags: ["po"],
    };

    const revision = await insertRevision(
      note.id,
      1,
      "manual",
      beforeSnapshot,
      afterSnapshot,
    );
    expect(revision.beforeSnapshot).toEqual(beforeSnapshot);
    expect(revision.afterSnapshot).toEqual(afterSnapshot);

    await expect(
      connection.pool.query(
        "INSERT INTO note_revisions (note_id, note_version, reason, before_snapshot, after_snapshot) VALUES ($1, 1, 'manual', '{}'::jsonb, '{}'::jsonb)",
        [note.id],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      connection.pool.query(
        "INSERT INTO note_revisions (note_id, note_version, reason, before_snapshot, after_snapshot) VALUES ($1, 2, 'bogus', '{}'::jsonb, '{}'::jsonb)",
        [note.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      connection.pool.query(
        "INSERT INTO note_revisions (note_id, note_version, reason, before_snapshot, after_snapshot) VALUES ($1, 3, 'manual', '[]'::jsonb, '{}'::jsonb)",
        [note.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces the tag primary key", async () => {
    const note = await insertNote();
    await insertTag(note.id, "práce");

    await expect(
      connection.pool.query(
        "INSERT INTO note_tags (note_id, tag) VALUES ($1, $2)",
        [note.id, "práce"],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("stores 1536-dimensional vectors and enforces chunk constraints", async () => {
    const note = await insertNote();
    const embedding = Array.from({ length: 1536 }, (_, index) => index / 1536);
    const chunk = await insertChunk(note.id, 0, embedding);

    expect(chunk.embedding).toHaveLength(1536);
    expect(chunk.embedding?.[0]).toBeCloseTo(0);

    await expect(
      connection.pool.query(
        "INSERT INTO note_chunks (note_id, note_version, chunk_index, text, model, status) VALUES ($1, 1, 0, 'duplikát', 'test', 'ready')",
        [note.id],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      connection.pool.query(
        "INSERT INTO note_chunks (note_id, note_version, chunk_index, text, model, status) VALUES ($1, 0, 1, 'verze', 'test', 'ready')",
        [note.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      connection.pool.query(
        "INSERT INTO note_chunks (note_id, note_version, chunk_index, text, model, status) VALUES ($1, 1, -1, 'index', 'test', 'ready')",
        [note.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      connection.db.insert(noteChunks).values({
        noteId: note.id,
        noteVersion: 1,
        chunkIndex: 1,
        text: "špatná dimenze",
        embedding: Array.from({ length: 1535 }, () => 0),
        model: "test",
        status: "ready",
      }),
    ).rejects.toThrow();
  });

  it("keeps one non-negative budget row", async () => {
    const rows = await connection.db.select().from(aiBudget);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(1);
    expect(rows[0]?.budgetUsd).toBe("2.000000");

    await expect(
      connection.pool.query(
        "INSERT INTO ai_budget (id, budget_usd) VALUES (2, 1.00)",
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      connection.pool.query(
        "UPDATE ai_budget SET budget_usd = -1 WHERE id = 1",
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces AI usage status and non-negative cost checks", async () => {
    const usage = await connection.db
      .insert(aiUsage)
      .values({
        operation: "embedding",
        provider: "test",
        model: "test-model",
        status: "started",
        reservedCostUsd: "0.010000",
      })
      .returning();

    expect(usage[0]?.startedAt).toBeInstanceOf(Date);
    expect(usage[0]?.settledAt).toBeNull();

    await expect(
      connection.pool.query(
        "INSERT INTO ai_usage (operation, provider, model, status, reserved_cost_usd) VALUES ('test', 'test', 'test', 'bogus', 0)",
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      connection.pool.query(
        "INSERT INTO ai_usage (operation, provider, model, status, reserved_cost_usd) VALUES ('test', 'test', 'test', 'started', -1)",
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      connection.pool.query(
        "INSERT INTO ai_usage (operation, provider, model, status, reserved_cost_usd, reported_cost_usd) VALUES ('test', 'test', 'test', 'settled', 0, -1)",
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("preserves rows when a new database connection is opened", async () => {
    const note = await insertNote({ title: "Persistentní poznámka" });
    const otherConnection = createDatabase(targets.testUrl);

    try {
      const result = await otherConnection.pool.query<{ title: string }>(
        "SELECT title FROM notes WHERE id = $1",
        [note.id],
      );
      expect(result.rows[0]?.title).toBe("Persistentní poznámka");
    } finally {
      await otherConnection.pool.end();
    }
  });

  it("uses the guarded test URL for the lazy client in test mode", async () => {
    const pool = getPool();
    const result = await pool.query<{ database: string }>(
      "SELECT current_database() AS database",
    );

    expect(result.rows[0]?.database).toBe(targets.testDatabaseName);
    await closeDb();
  });
});
