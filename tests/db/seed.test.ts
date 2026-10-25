import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  assertTestDatabaseTargets,
  type TestDatabaseTargets,
} from "../../scripts/test-db-guard";
import { SEED_FIXTURES, SEED_KEY_PREFIX } from "../../scripts/seed-fixtures";
import {
  createDatabase,
  type DatabaseConnection,
} from "../../src/lib/db/client";
import {
  createNoteService,
  type NoteService,
} from "../../src/lib/notes/service";

const hasTestDatabase = Boolean(
  process.env.DATABASE_URL && process.env.TEST_DATABASE_URL,
);

const NOW = new Date(Date.UTC(2026, 9, 25, 12, 0, 0));
const NOW_MS = NOW.getTime();
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
const RANDOM_SEED = "12345";

interface SeedRow {
  id: string;
  seed_key: string;
  title: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface SeedRevisionRow {
  note_id: string;
  note_version: number;
  reason: string;
  created_at: Date;
}

interface NoteRow {
  id: string;
  title: string;
  content_md: string;
  content_plain: string;
  seed_key: string | null;
  version: number;
  deleted_at: Date | null;
}

describe.skipIf(!hasTestDatabase)("seed CLI", () => {
  let targets: TestDatabaseTargets;
  let connection: DatabaseConnection;
  let service: NoteService;

  beforeAll(() => {
    targets = assertTestDatabaseTargets();
    connection = createDatabase(targets.testUrl);
    service = createNoteService({ db: connection.db });
  });

  beforeEach(async () => {
    await connection.pool.query("TRUNCATE TABLE notes CASCADE");
    await connection.pool.query("TRUNCATE TABLE ai_usage");
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  function spawnSeed(
    overrides: Record<string, string | undefined> = {},
    args: string[] = [],
  ) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: targets.devUrl,
      TEST_DATABASE_URL: targets.testUrl,
      SEED_TEST_NOW_MS: String(NOW_MS),
      SEED_TEST_RANDOM_SEED: RANDOM_SEED,
    };

    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete env[name];
      } else {
        env[name] = value;
      }
    }

    return spawnSync(
      process.execPath,
      [join(process.cwd(), "scripts", "seed-notes.ts"), ...args],
      {
        env,
        encoding: "utf8",
        timeout: 60_000,
      },
    );
  }

  async function getSeedRows(): Promise<SeedRow[]> {
    const result = await connection.pool.query<SeedRow>(
      "SELECT id, seed_key, title, created_at, updated_at, deleted_at FROM notes WHERE seed_key LIKE $1 ORDER BY seed_key",
      [`${SEED_KEY_PREFIX}%`],
    );
    return result.rows;
  }

  async function getSeedRevisions(): Promise<SeedRevisionRow[]> {
    const result = await connection.pool.query<SeedRevisionRow>(
      "SELECT r.note_id, r.note_version, r.reason, r.created_at FROM note_revisions r JOIN notes n ON n.id = r.note_id WHERE n.seed_key LIKE $1 ORDER BY r.note_id",
      [`${SEED_KEY_PREFIX}%`],
    );
    return result.rows;
  }

  async function countNotesByIds(ids: string[]): Promise<number> {
    const result = await connection.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM notes WHERE id = ANY($1::uuid[])",
      [ids],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function countRevisionsByIds(ids: string[]): Promise<number> {
    const result = await connection.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM note_revisions WHERE note_id = ANY($1::uuid[])",
      [ids],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function getNoteRow(id: string): Promise<NoteRow | undefined> {
    const result = await connection.pool.query<NoteRow>(
      "SELECT id, title, content_md, content_plain, seed_key, version, deleted_at FROM notes WHERE id = $1",
      [id],
    );
    return result.rows[0];
  }

  async function getDevCounts(): Promise<{ notes: number; seed: number; revisions: number }> {
    const devConnection = createDatabase(targets.devUrl);

    try {
      const notesCount = await devConnection.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM notes",
      );
      const seedCount = await devConnection.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM notes WHERE seed_key LIKE $1",
        [`${SEED_KEY_PREFIX}%`],
      );
      const revisionCount = await devConnection.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM note_revisions",
      );

      return {
        notes: notesCount.rows[0]?.count ?? 0,
        seed: seedCount.rows[0]?.count ?? 0,
        revisions: revisionCount.rows[0]?.count ?? 0,
      };
    } finally {
      await devConnection.pool.end();
    }
  }

  async function insertOtherNamespaceNote(): Promise<string> {
    const result = await connection.pool.query<{ id: string }>(
      "INSERT INTO notes (seed_key, title, content_md, content_plain) VALUES ('demo-v2:D99', 'Jiný seed', 'Text', 'Text') RETURNING id",
    );
    const id = result.rows[0]?.id;

    if (!id) {
      throw new Error("Poznámku jiného seed namespace se nepodařilo vložit.");
    }

    return id;
  }

  it("seeds 20 active notes with contract dates, matching revisions, and intact user notes", async () => {
    const userNote = await service.createNote({
      title: "Uživatelská poznámka",
      contentMd: "**Text**",
    });

    const run = spawnSeed();
    expect(run.status, run.stderr).toBe(0);

    const rows = await getSeedRows();
    expect(rows).toHaveLength(20);
    expect(rows.every((row) => row.deleted_at === null)).toBe(true);
    expect(rows.map((row) => row.seed_key).sort()).toEqual(
      SEED_FIXTURES.map((fixture) => fixture.key).sort(),
    );
    expect(rows.map((row) => row.title).sort()).toEqual(
      SEED_FIXTURES.map((fixture) => fixture.title).sort(),
    );

    const windowStart = NOW_MS - THIRTY_DAYS_MS;

    for (const row of rows) {
      const created = row.created_at.getTime();
      expect(created).toBeLessThanOrEqual(NOW_MS);
      expect(created).toBeGreaterThanOrEqual(windowStart);
      expect(row.updated_at.getTime()).toBe(created);
    }

    const d01 = rows.find(
      (row) => row.seed_key === `${SEED_KEY_PREFIX}D01`,
    );

    if (!d01) {
      throw new Error("Chybí seedovaná poznámka D01.");
    }

    const startOfUtcDay = Date.UTC(
      NOW.getUTCFullYear(),
      NOW.getUTCMonth(),
      NOW.getUTCDate(),
    );
    expect(d01.created_at.getTime()).toBeGreaterThanOrEqual(startOfUtcDay);
    expect(d01.created_at.getTime()).toBeLessThanOrEqual(NOW_MS);

    const distinctDays = new Set(
      rows.map((row) => row.created_at.toISOString().slice(0, 10)),
    );
    expect(distinctDays.size).toBeGreaterThanOrEqual(5);

    const revisions = await getSeedRevisions();
    expect(revisions).toHaveLength(20);

    const rowsById = new Map(rows.map((row) => [row.id, row]));

    for (const revision of revisions) {
      expect(revision.note_version).toBe(1);
      expect(revision.reason).toBe("initial");
      expect(revision.created_at.getTime()).toBe(
        rowsById.get(revision.note_id)?.created_at.getTime(),
      );
    }

    const userAfter = await getNoteRow(userNote.id);
    expect(userAfter).toMatchObject({
      id: userNote.id,
      title: "Uživatelská poznámka",
      content_md: "**Text**",
      seed_key: null,
      version: 1,
      deleted_at: null,
    });
  });

  it("leaves the dev database unchanged on a successful test-mode seed", async () => {
    const before = await getDevCounts();
    const run = spawnSeed();
    expect(run.status, run.stderr).toBe(0);
    const after = await getDevCounts();

    expect(after).toEqual(before);
    expect(await getSeedRows()).toHaveLength(20);
  });

  it("reruns replace only demo-v1 rows after edits and deletes while preserving other notes", async () => {
    const userNote = await service.createNote({
      title: "Uživatelská poznámka",
      contentMd: "Text",
    });
    const otherId = await insertOtherNamespaceNote();

    const firstRun = spawnSeed();
    expect(firstRun.status, firstRun.stderr).toBe(0);

    const firstRows = await getSeedRows();
    const firstIds = firstRows.map((row) => row.id);
    const editId = firstIds[0];
    const deleteId = firstIds[1];

    if (!editId || !deleteId) {
      throw new Error("Chybí seedované poznámky pro úpravu a smazání.");
    }

    await connection.pool.query(
      "UPDATE notes SET title = 'Ruční úprava', content_md = 'Ruční', version = version + 1 WHERE id = $1",
      [editId],
    );
    await connection.pool.query(
      "UPDATE notes SET deleted_at = now() WHERE id = $1",
      [deleteId],
    );

    const secondRun = spawnSeed();
    expect(secondRun.status, secondRun.stderr).toBe(0);

    const secondRows = await getSeedRows();
    const secondIds = secondRows.map((row) => row.id);

    expect(secondRows).toHaveLength(20);
    expect(secondRows.every((row) => row.deleted_at === null)).toBe(true);
    expect(secondRows.map((row) => row.title).sort()).toEqual(
      SEED_FIXTURES.map((fixture) => fixture.title).sort(),
    );
    expect(secondIds.every((id) => !firstIds.includes(id))).toBe(true);
    expect(await countNotesByIds(firstIds)).toBe(0);
    expect(await countRevisionsByIds(firstIds)).toBe(0);

    const userAfter = await getNoteRow(userNote.id);
    expect(userAfter).toMatchObject({
      title: "Uživatelská poznámka",
      seed_key: null,
      version: 1,
      deleted_at: null,
    });

    const otherAfter = await getNoteRow(otherId);
    expect(otherAfter).toMatchObject({
      title: "Jiný seed",
      seed_key: "demo-v2:D99",
      deleted_at: null,
    });
  });

  it("rolls back to the previous set when an injected insert fails", async () => {
    const userNote = await service.createNote({
      title: "Uživatelská poznámka",
      contentMd: "Text",
    });

    const firstRun = spawnSeed();
    expect(firstRun.status, firstRun.stderr).toBe(0);

    const beforeRows = await getSeedRows();
    const beforeIds = beforeRows.map((row) => row.id).sort();
    const beforeRevisions = await getSeedRevisions();

    const failedRun = spawnSeed({ SEED_TEST_FAIL_AFTER_INSERTS: "5" });
    expect(failedRun.status).not.toBe(0);
    expect(failedRun.stderr).toContain("Testovací selhání seedu.");

    const afterRows = await getSeedRows();
    expect(afterRows.map((row) => row.id).sort()).toEqual(beforeIds);
    expect(await getSeedRevisions()).toHaveLength(beforeRevisions.length);

    const userAfter = await getNoteRow(userNote.id);
    expect(userAfter).toMatchObject({
      title: "Uživatelská poznámka",
      seed_key: null,
      version: 1,
      deleted_at: null,
    });
  });

  it("rejects a missing or invalid TEST_DATABASE_URL without touching the dev database", async () => {
    const devConnection = createDatabase(targets.devUrl);

    try {
      const beforeNotes = await devConnection.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM notes",
      );
      const beforeSeed = await devConnection.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM notes WHERE seed_key LIKE $1",
        [`${SEED_KEY_PREFIX}%`],
      );

      const missing = spawnSeed({ TEST_DATABASE_URL: "" });
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toMatch(/TEST_DATABASE_URL/);

      const invalid = spawnSeed({ TEST_DATABASE_URL: "not-a-url" });
      expect(invalid.status).not.toBe(0);
      expect(invalid.stderr).toMatch(/TEST_DATABASE_URL/);

      const afterNotes = await devConnection.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM notes",
      );
      const afterSeed = await devConnection.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM notes WHERE seed_key LIKE $1",
        [`${SEED_KEY_PREFIX}%`],
      );

      expect(afterNotes.rows[0]?.count).toBe(beforeNotes.rows[0]?.count);
      expect(afterSeed.rows[0]?.count).toBe(beforeSeed.rows[0]?.count);
      expect(await getSeedRows()).toHaveLength(0);
    } finally {
      await devConnection.pool.end();
    }
  });

  it("uses a fresh injected RNG draw for each invocation", async () => {
    const firstRun = spawnSeed({ SEED_TEST_RANDOM_SEED: "12345" });
    expect(firstRun.status, firstRun.stderr).toBe(0);

    const firstDates = (await getSeedRows())
      .map((row) => `${row.seed_key}:${row.created_at.toISOString()}`)
      .sort();

    const secondRun = spawnSeed({ SEED_TEST_RANDOM_SEED: "54321" });
    expect(secondRun.status, secondRun.stderr).toBe(0);

    const secondDates = (await getSeedRows())
      .map((row) => `${row.seed_key}:${row.created_at.toISOString()}`)
      .sort();

    expect(secondDates).not.toEqual(firstDates);
    expect(await getSeedRows()).toHaveLength(20);
  });

  it("rejects raw database arguments and refuses non-loopback targets", async () => {
    const argumentRun = spawnSeed(
      {},
      ["--database-url", "postgresql://user:password@127.0.0.1:5432/notes"],
    );
    expect(argumentRun.status).not.toBe(0);
    expect(argumentRun.stderr).toContain("nepřijímá");

    const nonLoopbackRun = spawnSeed({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://user:password@db.example.com:5432/notes",
    });
    expect(nonLoopbackRun.status).not.toBe(0);
    expect(nonLoopbackRun.stderr).toMatch(/loopback/);

    expect(await getSeedRows()).toHaveLength(0);
  });
});
