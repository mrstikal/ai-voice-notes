import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertTestDatabaseTargets,
  type TestDatabaseTargets,
} from "../../scripts/test-db-guard";
import {
  createDatabase,
  type DatabaseConnection,
} from "../../src/lib/db/client";
import { noteRevisions, notes } from "../../src/lib/db/schema";
import { countGraphemes } from "../../src/lib/notes/limits";
import {
  EMPTY_NOTE_SNAPSHOT,
  InvalidNoteIdError,
  InvalidPageError,
  NoteConflictError,
  NoteNotFoundError,
  NoteTooLargeError,
  NoteValidationError,
  createNoteService,
  type NoteService,
} from "../../src/lib/notes/service";

const hasTestDatabase = Boolean(
  process.env.DATABASE_URL && process.env.TEST_DATABASE_URL,
);

describe.skipIf(!hasTestDatabase)("note service", () => {
  let connection: DatabaseConnection;
  let targets: TestDatabaseTargets;
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

  async function createNote(
    title = "Testovací poznámka",
    contentMd = "**Test**",
  ) {
    return service.createNote({ title, contentMd });
  }

  async function getNoteRow(id: string) {
    const rows = await connection.db
      .select()
      .from(notes)
      .where(eq(notes.id, id))
      .limit(1);
    return rows[0];
  }

  async function getRevisions(noteId: string) {
    return connection.db
      .select()
      .from(noteRevisions)
      .where(eq(noteRevisions.noteId, noteId))
      .orderBy(noteRevisions.noteVersion);
  }

  it("creates a Czech note with derived plain text and an initial revision", async () => {
    const note = await service.createNote({
      title: "Příliš žluťoučký kůň",
      contentMd: "**Ahoj** světe",
    });

    expect(note.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(note.title).toBe("Příliš žluťoučký kůň");
    expect(note.contentMd).toBe("**Ahoj** světe");
    expect(note.contentPlain).toBe("Ahoj světe");
    expect(note.version).toBe(1);
    expect(note.category).toBeNull();
    expect(note.tags).toEqual([]);
    expect(note.deletedAt).toBeNull();
    expect(note.createdAt).toBeInstanceOf(Date);
    expect(note.updatedAt).toBeInstanceOf(Date);

    const revisions = await getRevisions(note.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.noteVersion).toBe(1);
    expect(revisions[0]?.reason).toBe("initial");
    expect(revisions[0]?.beforeSnapshot).toEqual(EMPTY_NOTE_SNAPSHOT);
    expect(revisions[0]?.afterSnapshot).toEqual({
      title: note.title,
      contentMd: note.contentMd,
      category: null,
      tags: [],
    });
  });

  it("paginates ten active notes per page and uses id descending as the tie-break", async () => {
    const created = [];

    for (let index = 1; index <= 11; index += 1) {
      created.push(await createNote(`Poznámka ${index}`, `Obsah ${index}`));
    }

    await connection.pool.query(
      "UPDATE notes SET created_at = $1",
      [new Date("2026-01-01T00:00:00.000Z")],
    );

    const firstPage = await service.listActiveNotes(1);
    const secondPage = await service.listActiveNotes(2);

    expect(firstPage.page).toBe(1);
    expect(firstPage.pageSize).toBe(10);
    expect(firstPage.items).toHaveLength(10);
    expect(firstPage.hasNext).toBe(true);
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.hasNext).toBe(false);

    const returnedIds = [...firstPage.items, ...secondPage.items].map(
      (item) => item.id,
    );
    const expectedIds = created
      .map((item) => item.id)
      .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));

    expect(returnedIds).toEqual(expectedIds);
    expect(new Set(returnedIds).size).toBe(11);

    const thirdPage = await service.listActiveNotes(3);
    expect(thirdPage.items).toEqual([]);
    expect(thirdPage.hasNext).toBe(false);
  });

  it("rejects invalid page numbers", async () => {
    await expect(service.listActiveNotes(0)).rejects.toBeInstanceOf(
      InvalidPageError,
    );
    await expect(service.listActiveNotes(1.5)).rejects.toBeInstanceOf(
      InvalidPageError,
    );
    await expect(service.listActiveNotes(-1)).rejects.toBeInstanceOf(
      InvalidPageError,
    );
  });

  it("reads active notes by UUID and returns 404 semantics for missing or deleted notes", async () => {
    const note = await createNote("Čitelná", "Text");
    const fetched = await service.getNote(note.id);

    expect(fetched.title).toBe("Čitelná");
    expect(fetched.contentPlain).toBe("Text");

    await expect(service.getNote("not-a-uuid")).rejects.toBeInstanceOf(
      InvalidNoteIdError,
    );
    await expect(service.getNote(randomUUID())).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );

    await service.deleteNote(note.id, 1);
    await expect(service.getNote(note.id)).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );
  });

  it("updates with CAS, creates a manual revision, and turns a repeated manual save into a named checkpoint", async () => {
    const note = await createNote("Původní", "**Původní** text");

    const updated = await service.updateNote(note.id, {
      title: "Nový",
      contentMd: "**Nový** text",
      expectedVersion: 1,
    });

    expect(updated.version).toBe(2);
    expect(updated.title).toBe("Nový");
    expect(updated.contentPlain).toBe("Nový text");

    const revisions = await getRevisions(note.id);
    expect(revisions).toHaveLength(2);
    expect(revisions[1]?.noteVersion).toBe(2);
    expect(revisions[1]?.reason).toBe("manual");
    expect(revisions[1]?.beforeSnapshot).toEqual({
      title: "Původní",
      contentMd: "**Původní** text",
      category: null,
      tags: [],
    });
    expect(revisions[1]?.afterSnapshot).toEqual({
      title: "Nový",
      contentMd: "**Nový** text",
      category: null,
      tags: [],
    });

    const staleError = await service
      .updateNote(note.id, {
        title: "Stale",
        contentMd: "Stale",
        expectedVersion: 1,
      })
      .catch((error: unknown) => error);

    expect(staleError).toBeInstanceOf(NoteConflictError);
    expect(staleError).toMatchObject({ latestVersion: 2 });

    const afterStale = await getNoteRow(note.id);
    expect(afterStale?.version).toBe(2);
    expect(afterStale?.contentMd).toBe("**Nový** text");

    const checkpoint = await service.updateNote(note.id, {
      title: "Nový",
      contentMd: "**Nový** text",
      expectedVersion: 2,
    });
    expect(checkpoint.version).toBe(3);

    const revisionsAfterCheckpoint = await getRevisions(note.id);
    expect(revisionsAfterCheckpoint).toHaveLength(3);
    expect(revisionsAfterCheckpoint[2]?.reason).toBe("manual");
    expect(revisionsAfterCheckpoint[2]?.noteVersion).toBe(3);
    expect(revisionsAfterCheckpoint[2]?.beforeSnapshot).toEqual(
      revisionsAfterCheckpoint[2]?.afterSnapshot,
    );
  });

  it("creates a voice revision for a confirmed dictated title", async () => {
    const note = await createNote("Původní", "Text poznámky");

    const updated = await service.updateNoteTitle(note.id, {
      title: "Nadiktovaný název",
      expectedVersion: note.version,
    });

    expect(updated.version).toBe(2);
    expect(updated.title).toBe("Nadiktovaný název");
    expect(updated.contentMd).toBe("Text poznámky");

    const revisions = await getRevisions(note.id);
    expect(revisions).toHaveLength(2);
    expect(revisions[1]?.reason).toBe("voice");
    expect(revisions[1]?.afterSnapshot).toMatchObject({
      title: "Nadiktovaný název",
      contentMd: "Text poznámky",
    });
  });

  it("persists draft saves without revisions and creates a named checkpoint on explicit save", async () => {
    const note = await createNote("Draft", "Původní");

    const firstDraft = await service.updateNote(note.id, {
      title: "Draft 1",
      contentMd: "Draft 1",
      expectedVersion: 1,
      draft: true,
    });
    expect(firstDraft.version).toBe(2);
    expect(await getRevisions(note.id)).toHaveLength(1);

    const secondDraft = await service.updateNote(note.id, {
      title: "Draft 2",
      contentMd: "Draft 2",
      expectedVersion: 2,
      draft: true,
    });
    expect(secondDraft.version).toBe(3);
    expect(await getRevisions(note.id)).toHaveLength(1);

    const unchangedDraft = await service.updateNote(note.id, {
      title: "Draft 2",
      contentMd: "Draft 2",
      expectedVersion: 3,
      draft: true,
    });
    expect(unchangedDraft.version).toBe(3);
    expect(await getRevisions(note.id)).toHaveLength(1);

    const checkpoint = await service.updateNote(note.id, {
      title: "Draft 2",
      contentMd: "Draft 2",
      expectedVersion: 3,
    });
    expect(checkpoint.version).toBe(4);

    const revisions = await getRevisions(note.id);
    expect(revisions).toHaveLength(2);
    expect(revisions[1]?.reason).toBe("manual");
    expect(revisions[1]?.noteVersion).toBe(4);
    expect(revisions[1]?.beforeSnapshot).toEqual(revisions[1]?.afterSnapshot);
    expect(revisions[1]?.afterSnapshot).toMatchObject({
      title: "Draft 2",
      contentMd: "Draft 2",
    });
  });

  it("soft-deletes, excludes from active reads and lists, and restores with version increments", async () => {
    const note = await createNote("Koš", "Text");
    const deleted = await service.deleteNote(note.id, 1);

    expect(deleted.version).toBe(2);
    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect((await service.listActiveNotes(1)).items).toEqual([]);

    await expect(service.getNote(note.id)).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );
    await expect(service.deleteNote(note.id, 2)).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );

    const restored = await service.restoreNote(note.id, 2);
    expect(restored.version).toBe(3);
    expect(restored.deletedAt).toBeNull();
    expect((await service.getNote(note.id)).version).toBe(3);

    const revisionsAfterRestore = await getRevisions(note.id);
    expect(revisionsAfterRestore).toHaveLength(2);
    expect(revisionsAfterRestore[1]?.reason).toBe("restore");
    expect(revisionsAfterRestore[1]?.noteVersion).toBe(3);
    expect(revisionsAfterRestore[1]?.beforeSnapshot).toEqual(
      revisionsAfterRestore[1]?.afterSnapshot,
    );

    await expect(service.restoreNote(note.id, 3)).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );

    const staleNote = await createNote("Stale restore", "Text");
    await service.deleteNote(staleNote.id, 1);
    await expect(service.restoreNote(staleNote.id, 1)).rejects.toBeInstanceOf(
      NoteConflictError,
    );

    const staleDeleteNote = await createNote("Stale delete", "Text");
    await service.updateNote(staleDeleteNote.id, {
      title: "Stale delete 2",
      contentMd: "Text 2",
      expectedVersion: 1,
    });
    await expect(
      service.deleteNote(staleDeleteNote.id, 1),
    ).rejects.toBeInstanceOf(NoteConflictError);
  });

  it("lists only deleted notes for the Trash view", async () => {
    const active = await createNote("Aktivní", "A");
    const first = await createNote("Smazaná 1", "1");
    const second = await createNote("Smazaná 2", "2");

    await service.deleteNote(first.id, 1);
    await service.deleteNote(second.id, 1);

    const page = await service.listDeletedNotes(1);
    const ids = page.items.map((item) => item.id).sort();

    expect(ids).toEqual([first.id, second.id].sort());
    expect(page.items.every((item) => item.deletedAt instanceof Date)).toBe(true);
    expect(page.items.some((item) => item.id === active.id)).toBe(false);
  });

  it("permanently empties the trash and keeps active notes", async () => {
    const active = await createNote("Aktivní", "A");
    const first = await createNote("Smazaná 1", "1");
    const second = await createNote("Smazaná 2", "2");

    await service.deleteNote(first.id, 1);
    await service.deleteNote(second.id, 1);

    const result = await service.emptyTrash();

    expect(result.purgedCount).toBe(2);
    expect((await service.listDeletedNotes(1)).items).toEqual([]);
    expect(
      (await service.listActiveNotes(1)).items.map((item) => item.id),
    ).toEqual([active.id]);
    await expect(service.getNote(first.id)).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );
    await expect(service.getNote(second.id)).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );
    expect(await getRevisions(first.id)).toEqual([]);
    expect(await getRevisions(second.id)).toEqual([]);
  });

  it("lets exactly one of two concurrent writers win the CAS race", async () => {
    const note = await createNote("Souběh", "Původní");

    const results = await Promise.allSettled([
      service.updateNote(note.id, {
        title: "Writer A",
        contentMd: "A",
        expectedVersion: 1,
      }),
      service.updateNote(note.id, {
        title: "Writer B",
        contentMd: "B",
        expectedVersion: 1,
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(NoteConflictError);
    expect(rejected[0]?.reason).toMatchObject({ latestVersion: 2 });

    const row = await getNoteRow(note.id);
    expect(row?.version).toBe(2);
    expect(await getRevisions(note.id)).toHaveLength(2);
    expect(
      (await getRevisions(note.id)).filter(
        (revision) => revision.reason === "manual",
      ),
    ).toHaveLength(1);
  });

  it("saves a 20,000-grapheme emoji note below 1 MiB", async () => {
    const contentMd = "😀".repeat(20_000);

    expect(countGraphemes(contentMd)).toBe(20_000);
    expect(Buffer.byteLength(contentMd, "utf8")).toBeLessThan(1_048_576);

    const note = await service.createNote({
      title: "Emoji poznámka",
      contentMd,
    });

    expect(countGraphemes(note.contentPlain)).toBe(20_000);
    expect(Buffer.byteLength(note.contentMd, "utf8")).toBeLessThan(1_048_576);
  });

  it("rejects 20,001 graphemes without changing the note or revisions", async () => {
    const note = await createNote("Limit", "Text");
    const before = await getNoteRow(note.id);
    const revisionsBefore = await getRevisions(note.id);

    await expect(
      service.updateNote(note.id, {
        title: "Příliš dlouhé",
        contentMd: "😀".repeat(20_001),
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(NoteValidationError);

    const after = await getNoteRow(note.id);
    expect(after?.version).toBe(before?.version);
    expect(after?.contentMd).toBe(before?.contentMd);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
    expect(await getRevisions(note.id)).toHaveLength(revisionsBefore.length);

    await expect(
      service.createNote({
        title: "Příliš dlouhé",
        contentMd: "😀".repeat(20_001),
      }),
    ).rejects.toBeInstanceOf(NoteValidationError);

    const count = await connection.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM notes",
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it("pins the exact 1 MiB byte boundary", async () => {
    const grapheme = `á${"\u0301".repeat(51)}`;
    const atLimit = grapheme.repeat(10_000) + " ".repeat(8_576);
    const overLimit = grapheme.repeat(10_000) + " ".repeat(8_577);

    expect(Buffer.byteLength(atLimit, "utf8")).toBe(1_048_576);
    expect(Buffer.byteLength(overLimit, "utf8")).toBe(1_048_577);
    expect(countGraphemes(atLimit)).toBe(18_576);
    expect(countGraphemes(overLimit)).toBe(18_577);

    const note = await service.createNote({
      title: "Přesná hranice",
      contentMd: atLimit,
    });
    expect(Buffer.byteLength(note.contentMd, "utf8")).toBe(1_048_576);

    await expect(
      service.createNote({ title: "Přes limit", contentMd: overLimit }),
    ).rejects.toBeInstanceOf(NoteTooLargeError);

    const count = await connection.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM notes",
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it("rejects a 1 MiB+1-byte note without changing the note or revisions", async () => {
    const note = await createNote("Velikost", "Text");
    const before = await getNoteRow(note.id);
    const revisionsBefore = await getRevisions(note.id);
    const combiningGrapheme = `a${"\u0301".repeat(100)}`;
    const contentMd = combiningGrapheme.repeat(10_000);

    expect(countGraphemes(contentMd)).toBeLessThanOrEqual(20_000);
    expect(Buffer.byteLength(contentMd, "utf8")).toBeGreaterThan(1_048_576);

    await expect(
      service.updateNote(note.id, {
        title: "Velká",
        contentMd,
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(NoteTooLargeError);

    const after = await getNoteRow(note.id);
    expect(after?.version).toBe(before?.version);
    expect(after?.contentMd).toBe(before?.contentMd);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
    expect(await getRevisions(note.id)).toHaveLength(revisionsBefore.length);

    await expect(
      service.createNote({ title: "Velká", contentMd }),
    ).rejects.toBeInstanceOf(NoteTooLargeError);
  });

  it("keeps a successful note edit when the TTS cache purge fails", async () => {
    const failingCache = {
      purgeNote: vi.fn().mockRejectedValue(new Error("cache unavailable")),
    };
    const serviceWithCache = createNoteService({
      db: connection.db,
      ttsCache: failingCache,
    });
    const note = await serviceWithCache.createNote({
      title: "Cache purge",
      contentMd: "Původní text",
    });

    const updated = await serviceWithCache.updateNote(note.id, {
      title: note.title,
      contentMd: "Nový text",
      expectedVersion: note.version,
    });

    expect(updated.contentMd).toBe("Nový text");
    expect(updated.version).toBe(2);
    expect(failingCache.purgeNote).toHaveBeenCalledWith(note.id);
  });

  it("rejects invalid UUIDs for every note operation", async () => {
    await expect(service.getNote("bad-id")).rejects.toBeInstanceOf(
      InvalidNoteIdError,
    );
    await expect(
      service.updateNote("bad-id", {
        title: "T",
        contentMd: "C",
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(InvalidNoteIdError);
    await expect(service.deleteNote("bad-id", 1)).rejects.toBeInstanceOf(
      InvalidNoteIdError,
    );
    await expect(service.restoreNote("bad-id", 1)).rejects.toBeInstanceOf(
      InvalidNoteIdError,
    );
  });
});
