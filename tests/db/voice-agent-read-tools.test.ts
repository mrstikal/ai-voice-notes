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
import { parseNoteMarkdown } from "../../src/lib/notes/markdown";
import { searchNotesFullText } from "../../src/lib/search/fts";
import {
  READ_TOOL_NOTE_MAX_GRAPHEMES,
  createReadServices,
} from "../../src/lib/voice-agent/read-services";

const hasTestDatabase = Boolean(
  process.env.DATABASE_URL && process.env.TEST_DATABASE_URL,
);

describe.skipIf(!hasTestDatabase)("P47 voice read services", () => {
  let connection: DatabaseConnection;
  let targets: TestDatabaseTargets;
  let notes: NoteService;
  let services: ReturnType<typeof createReadServices>;

  beforeAll(() => {
    targets = assertTestDatabaseTargets();
    connection = createDatabase(targets.testUrl);
    notes = createNoteService({ db: connection.db });
    services = createReadServices({
      getNote: (noteId) => notes.getNote(noteId),
      searchNotes: (query) =>
        searchNotesFullText(connection.db, { page: 1, query }),
    });
  });

  beforeEach(async () => {
    await connection.pool.query("TRUNCATE TABLE notes CASCADE");
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  it("searches an active note, reads it and leaves the version unchanged", async () => {
    const created = await notes.createNote({
      title: "Nákupní seznam",
      contentMd: "Koupit mléko a chleba.",
    });

    const found = await services.searchNotes({ query: "mléko", maxResults: 3 });

    expect(found).toMatchObject({
      empty: false,
      total: 1,
    });
    expect(found.results[0]).toMatchObject({
      noteId: created.id,
      title: "Nákupní seznam",
    });
    expect(found.results[0]?.preview).toContain("mléko");

    const detail = await services.getNote({ noteId: created.id });

    expect(detail).toMatchObject({
      content: "Koupit mléko a chleba.",
      empty: false,
      noteId: created.id,
      title: "Nákupní seznam",
      truncated: false,
      version: created.version,
    });

    await expect(notes.getNote(created.id)).resolves.toMatchObject({
      version: created.version,
    });
  });

  it("caps results at five and the read at 1,200 graphemes", async () => {
    for (let index = 0; index < 7; index += 1) {
      await notes.createNote({
        title: `Poznámka ${index}`,
        contentMd: `Společný výraz a obsah číslo ${index}.`,
      });
    }

    const found = await services.searchNotes({
      maxResults: 5,
      query: "společný",
    });

    expect(found.total).toBe(7);
    expect(found.results).toHaveLength(5);

    const long = await notes.createNote({
      title: "Dlouhá",
      contentMd: "x".repeat(READ_TOOL_NOTE_MAX_GRAPHEMES + 100),
    });
    const detail = await services.getNote({ noteId: long.id });

    expect(detail.content).toHaveLength(READ_TOOL_NOTE_MAX_GRAPHEMES);
    expect(detail.truncated).toBe(true);
  });

  it("reads bounded sections from the saved note without changing it", async () => {
    const contentMd = [
      "# Migrace",
      "",
      "První odstavec o databázi.",
      "",
      "- [ ] Ověřit kompatibilitu",
      "",
      "Poslední odstavec o API.",
    ].join("\n");
    const created = await notes.createNote({
      title: "Sekce migrace",
      contentMd,
    });
    const plainText = parseNoteMarkdown(contentMd).plainText;
    const start = plainText.indexOf("První odstavec");
    const end = start + "První odstavec o databázi.".length;

    await expect(
      services.readNoteSection({ noteId: created.id, section: "last_paragraph" }),
    ).resolves.toMatchObject({
      noteId: created.id,
      section: "last_paragraph",
      status: "ok",
      text: "Poslední odstavec o API.",
      title: "Sekce migrace",
      version: created.version,
    });

    await expect(
      services.readNoteSection({ noteId: created.id, section: "tasks" }),
    ).resolves.toMatchObject({ status: "ok", text: "Ověřit kompatibilitu" });

    await expect(
      services.readNoteSection({
        noteId: created.id,
        section: "selection",
        selection: { end, start },
      }),
    ).resolves.toMatchObject({ status: "ok", text: "První odstavec o databázi." });

    await expect(
      services.readNoteSection({ noteId: created.id, section: "selection" }),
    ).resolves.toMatchObject({ status: "ambiguous", text: "" });

    await expect(notes.getNote(created.id)).resolves.toMatchObject({
      contentMd,
      version: created.version,
    });
  });

  it("does not return a deleted note", async () => {
    const created = await notes.createNote({
      title: "Smazaná",
      contentMd: "Tato poznámka bude smazaná.",
    });

    await notes.deleteNote(created.id, created.version);

    await expect(
      services.getNote({ noteId: created.id }),
    ).rejects.toMatchObject({ code: "note_not_found" });

    const found = await services.searchNotes({ query: "smazaná" });
    expect(found.empty).toBe(true);
  });
});
