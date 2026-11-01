import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
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
  meetingSaves,
  noteRevisions,
  notes,
} from "../../src/lib/db/schema";
import { countGraphemes } from "../../src/lib/notes/limits";
import { parseNoteMarkdown } from "../../src/lib/notes/markdown";
import {
  MeetingSaveConflictError,
  MeetingTitleTooLongError,
  MeetingTranscriptEmptyError,
  MeetingTranscriptTooLongError,
  createNoteService,
  planMeetingSave,
  type NoteService,
} from "../../src/lib/notes/service";
import { MEETING_SAVE_MAX_BYTES } from "../../src/lib/meetings/save-shared";
import {
  isSavedMeetingNote,
  listSavedMeetingNotes,
} from "../../src/lib/meetings/suggestions";
import { createMeetingSaveHandler } from "../../src/app/api/meetings/save/route";

const hasTestDatabase = Boolean(
  process.env.DATABASE_URL && process.env.TEST_DATABASE_URL,
);

const APP_ORIGIN = "http://127.0.0.1:3000";

describe("meeting save canonicalization", () => {
  it("turns reviewed speaker labels into plain Markdown text", () => {
    const plan = planMeetingSave({
      title: "Zápis ze schůzky",
      segments: [
        { label: "Petra", text: "Dobrý den." },
        { label: "Jan", text: "Ahoj." },
      ],
    });

    expect(plan.parts).toHaveLength(1);
    expect(plan.parts[0]?.title).toBe("Zápis ze schůzky");
    expect(plan.parts[0]?.contentMd).toBe(
      "**Petra:** Dobrý den.\n\n**Jan:** Ahoj.",
    );
    expect(plan.parts[0]?.contentPlain).toBe(
      "Petra: Dobrý den.\n\nJan: Ahoj.",
    );
    expect(plan.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("escapes Markdown so reviewed literal text is preserved", () => {
    const literal = [
      "# Nadpis",
      "**Tlusté** [odkaz](https://example.com) <b>html</b> &amp; 1. položka",
    ].join("\n\n");
    const plan = planMeetingSave({ title: "Zápis", text: literal });
    const part = plan.parts[0]!;

    expect(part.contentPlain).toBe(literal);
    expect(parseNoteMarkdown(part.contentMd).plainText).toBe(literal);
    expect(parseNoteMarkdown(part.contentMd).sourceOnly).toBe(false);
    expect(part.contentMd).toContain("\\# Nadpis");
    expect(part.contentMd).toContain("\\*\\*Tlusté\\*\\*");
    expect(part.contentMd).toContain("\\[odkaz\\](https://example.com)");
    expect(part.contentMd).toContain("\\<b\\>html\\</b\\>");
  });

  it("splits long reviewed text at paragraph boundaries within the part limit", () => {
    const paragraphs = Array.from({ length: 4 }, (_, index) =>
      `Odstavec ${index + 1}: ${"slovo ".repeat(1_400)}`.trim(),
    );
    const plan = planMeetingSave({
      title: "Dlouhý zápis",
      text: paragraphs.join("\n\n"),
    });

    expect(plan.parts.length).toBeGreaterThan(1);
    expect(plan.parts.length).toBeLessThanOrEqual(3);
    expect(plan.parts[0]?.title).toMatch(/ – část 1\//u);
    expect(plan.parts[1]?.title).toMatch(/ – část 2\//u);

    for (const part of plan.parts) {
      expect(countGraphemes(part.contentPlain)).toBeLessThanOrEqual(20_000);
    }

    const joined = plan.parts
      .map((part) => part.contentPlain)
      .join("\n\n");

    for (const paragraph of paragraphs) {
      expect(joined).toContain(paragraph);
    }
  });

  it("uses exactly three parts when each paragraph fills one part", () => {
    const paragraphs = Array.from({ length: 3 }, (_, index) =>
      `Část ${index + 1}: ${"x".repeat(11_000)}`,
    );
    const plan = planMeetingSave({
      title: "Třídílný zápis",
      text: paragraphs.join("\n\n"),
    });

    expect(plan.parts).toHaveLength(3);
    expect(plan.parts.map((part) => part.title)).toEqual([
      "Třídílný zápis – část 1/3",
      "Třídílný zápis – část 2/3",
      "Třídílný zápis – část 3/3",
    ]);
    for (const part of plan.parts) {
      expect(countGraphemes(part.contentPlain)).toBeLessThanOrEqual(20_000);
    }
  });

  it("refuses more than three parts without truncation", () => {
    const segments = Array.from({ length: 4 }, (_, index) => ({
      label: `Mluvčí ${index + 1}`,
      text: "x".repeat(19_000),
    }));

    expect(() =>
      planMeetingSave({ title: "Dlouhý zápis", segments }),
    ).toThrowError(MeetingTranscriptTooLongError);

    try {
      planMeetingSave({ title: "Dlouhý zápis", segments });
    } catch (error) {
      expect(error).toMatchObject({
        status: 422,
        code: "meeting_transcript_too_long",
        details: { reason: "too_many_parts", maxParts: 3 },
      });
    }
  });

  it("refuses a single paragraph larger than one note", () => {
    expect(() =>
      planMeetingSave({ title: "Zápis", text: "x".repeat(20_001) }),
    ).toThrowError(MeetingTranscriptTooLongError);
  });

  it("refuses an empty reviewed transcript", () => {
    expect(() =>
      planMeetingSave({ title: "Zápis", segments: [{ label: "Petra", text: "  " }] }),
    ).toThrowError(MeetingTranscriptEmptyError);
  });

  it("enforces the advertised 100-grapheme title cap on the server", () => {
    expect(() =>
      planMeetingSave({ title: "a".repeat(101), text: "Text." }),
    ).toThrowError(MeetingTitleTooLongError);

    expect(
      planMeetingSave({ title: "a".repeat(100), text: "Text." }).parts[0]
        ?.title,
    ).toBe("a".repeat(100));
  });
});

describe.skipIf(!hasTestDatabase)("meeting save service", () => {
  let connection: DatabaseConnection;
  let targets: TestDatabaseTargets;
  let service: NoteService;

  beforeAll(() => {
    targets = assertTestDatabaseTargets();
    connection = createDatabase(targets.testUrl);
    service = createNoteService({
      db: connection.db,
      limits: { title: 160, content: 50 },
    });
  });

  beforeEach(async () => {
    await connection.pool.query("TRUNCATE TABLE meeting_saves");
    await connection.pool.query("TRUNCATE TABLE notes CASCADE");
    await connection.pool.query("TRUNCATE TABLE ai_usage");
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  function uniqueRequestId(): string {
    return randomUUID();
  }

  async function noteCount(): Promise<number> {
    const rows = await connection.db.select().from(notes);
    return rows.length;
  }

  async function saveRows() {
    return connection.db.select().from(meetingSaves);
  }

  it("creates one note with an initial revision and records the save", async () => {
    const requestId = uniqueRequestId();
    const result = await service.saveMeeting({
      requestId,
      title: "Zápis ze schůzky",
      segments: [
        { label: "Petra", text: "Dobrý den." },
        { label: "Jan", text: "Ahoj." },
      ],
    });

    expect(result).toMatchObject({
      requestId,
      count: 1,
      duplicate: false,
    });
    expect(result.noteIds).toHaveLength(1);

    const note = await service.getNote(result.noteIds[0]!);
    expect(note.title).toBe("Zápis ze schůzky");
    expect(note.contentMd).toBe(
      "**Petra:** Dobrý den.\n\n**Jan:** Ahoj.",
    );
    expect(note.contentPlain).toBe("Petra: Dobrý den.\n\nJan: Ahoj.");
    expect(note.version).toBe(1);

    const revisions = await connection.db
      .select()
      .from(noteRevisions)
      .where(eq(noteRevisions.noteId, note.id));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.reason).toBe("initial");
    expect(revisions[0]?.noteVersion).toBe(1);

    const rows = await saveRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestId).toBe(requestId);
    expect(rows[0]?.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.noteIds).toEqual(result.noteIds);
  });

  it("creates numbered parts when the transcript exceeds one note", async () => {
    const result = await service.saveMeeting({
      requestId: uniqueRequestId(),
      title: "Zápis",
      segments: [
        { label: "Petra", text: "x".repeat(40) },
        { label: "Jan", text: "y".repeat(40) },
      ],
    });

    expect(result.count).toBe(2);
    expect(result.noteIds).toHaveLength(2);

    const first = await service.getNote(result.noteIds[0]!);
    const second = await service.getNote(result.noteIds[1]!);

    expect(first.title).toBe("Zápis – část 1/2");
    expect(second.title).toBe("Zápis – část 2/2");
    expect(countGraphemes(first.contentPlain)).toBeLessThanOrEqual(50);
    expect(countGraphemes(second.contentPlain)).toBeLessThanOrEqual(50);

    const revisions = await connection.db
      .select()
      .from(noteRevisions)
      .where(eq(noteRevisions.noteId, first.id));
    expect(revisions[0]?.reason).toBe("initial");
    expect(await noteCount()).toBe(2);
  });

  it("creates exactly three numbered notes with initial revisions", async () => {
    const result = await service.saveMeeting({
      requestId: uniqueRequestId(),
      title: "Třídílný zápis",
      segments: [
        { label: "Mluvi 1", text: "a".repeat(40) },
        { label: "Mluvi 2", text: "b".repeat(40) },
        { label: "Mluvi 3", text: "c".repeat(40) },
      ],
    });

    expect(result.count).toBe(3);
    expect(result.noteIds).toHaveLength(3);

    const saved = await Promise.all(
      result.noteIds.map((noteId) => service.getNote(noteId)),
    );

    expect(saved.map((note) => note.title)).toEqual([
      "Třídílný zápis – část 1/3",
      "Třídílný zápis – část 2/3",
      "Třídílný zápis – část 3/3",
    ]);

    for (const note of saved) {
      expect(countGraphemes(note.contentPlain)).toBeLessThanOrEqual(50);
      const revisions = await connection.db
        .select()
        .from(noteRevisions)
        .where(eq(noteRevisions.noteId, note.id));
      expect(revisions).toHaveLength(1);
      expect(revisions[0]?.reason).toBe("initial");
    }

    const rows = await saveRows();
    expect(rows[0]?.noteIds).toHaveLength(3);
    expect(rows[0]?.noteIds).toEqual(result.noteIds);
    expect(await noteCount()).toBe(3);
  });

  it("lists only saved meeting notes and recognizes their membership", async () => {
    const result = await service.saveMeeting({
      requestId: uniqueRequestId(),
      title: "Seznam schůzek",
      segments: [
        { label: "Petra", text: "x".repeat(40) },
        { label: "Jan", text: "y".repeat(40) },
      ],
    });
    const listed = await listSavedMeetingNotes({ db: connection.db });

    expect(listed).toHaveLength(2);
    expect(listed.map((note) => note.title)).toEqual([
      "Seznam schůzek – část 1/2",
      "Seznam schůzek – část 2/2",
    ]);
    expect(listed.map((note) => note.part)).toEqual([1, 2]);
    expect(listed.every((note) => note.total === 2)).toBe(true);
    expect(
      await isSavedMeetingNote(result.noteIds[0]!, connection.db),
    ).toBe(true);
    expect(
      await isSavedMeetingNote(randomUUID(), connection.db),
    ).toBe(false);
  });

  it("returns the first note ids for a retry with the same request and content", async () => {
    const requestId = uniqueRequestId();
    const input = {
      requestId,
      title: "Zápis",
      text: "Petra: Dobrý den.\n\nJan: Ahoj.",
    };
    const first = await service.saveMeeting(input);
    const replay = await service.saveMeeting(input);

    expect(replay.duplicate).toBe(true);
    expect(replay.noteIds).toEqual(first.noteIds);
    expect(await noteCount()).toBe(1);
    expect(await saveRows()).toHaveLength(1);
  });

  it("serializes concurrent identical submits without duplicating notes", async () => {
    const input = {
      requestId: uniqueRequestId(),
      title: "Souběžný zápis",
      text: "Stejný text.",
    };
    const [first, second] = await Promise.all([
      service.saveMeeting(input),
      service.saveMeeting(input),
    ]);

    expect(first.noteIds).toEqual(second.noteIds);
    expect(first.duplicate || second.duplicate).toBe(true);
    expect(await noteCount()).toBe(1);
    expect(await saveRows()).toHaveLength(1);
  });

  it("rejects reusing a request id with different content", async () => {
    const requestId = uniqueRequestId();

    await service.saveMeeting({
      requestId,
      title: "Zápis",
      text: "První text.",
    });

    await expect(
      service.saveMeeting({
        requestId,
        title: "Zápis",
        text: "Jiný text.",
      }),
    ).rejects.toBeInstanceOf(MeetingSaveConflictError);

    expect(await noteCount()).toBe(1);
    expect(await saveRows()).toHaveLength(1);
  });

  it("rolls back every insert when a later note fails", async () => {
    const failingService = createNoteService({
      db: connection.db,
      limits: { title: 160, content: 50 },
      meetingSaveAfterNoteInsert: (insertedCount) => {
        if (insertedCount === 1) {
          throw new Error("injected failure");
        }
      },
    });

    await expect(
      failingService.saveMeeting({
        requestId: uniqueRequestId(),
        title: "Zápis",
        segments: [
          { label: "Petra", text: "x".repeat(40) },
          { label: "Jan", text: "y".repeat(40) },
        ],
      }),
    ).rejects.toThrow("injected failure");

    expect(await noteCount()).toBe(0);
    expect(await saveRows()).toHaveLength(0);

    const revisions = await connection.db.select().from(noteRevisions);
    expect(revisions).toHaveLength(0);
  });

  it("refuses an unsavable transcript without creating a save row", async () => {
    await expect(
      service.saveMeeting({
        requestId: uniqueRequestId(),
        title: "Zápis",
        text: "x".repeat(200),
      }),
    ).rejects.toBeInstanceOf(MeetingTranscriptTooLongError);

    expect(await noteCount()).toBe(0);
    expect(await saveRows()).toHaveLength(0);
  });

  it("keeps saved content readable through a fresh connection", async () => {
    const result = await service.saveMeeting({
      requestId: uniqueRequestId(),
      title: "Trvalý zápis",
      text: "Text, který má přežít restart.",
    });
    const secondConnection = createDatabase(targets.testUrl);

    try {
      const secondService = createNoteService({ db: secondConnection.db });
      const note = await secondService.getNote(result.noteIds[0]!);

      expect(note.title).toBe("Trvalý zápis");
      expect(note.contentPlain).toBe("Text, který má přežít restart.");
    } finally {
      await secondConnection.pool.end();
    }
  });

  it("rejects a forced POST over the 3 MiB JSON cap before calling the service", async () => {
    let called = false;
    const handler = createMeetingSaveHandler({
      async saveMeeting() {
        called = true;
        return {
          requestId: uniqueRequestId(),
          noteIds: [],
          count: 0,
          duplicate: false,
        };
      },
    });
    const request = new Request(`${APP_ORIGIN}/api/meetings/save`, {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: APP_ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: uniqueRequestId(),
        title: "Zápis",
        text: "x".repeat(MEETING_SAVE_MAX_BYTES),
      }),
    });
    const response = await handler(request);

    expect(response.status).toBe(413);
    expect(called).toBe(false);
    expect(await noteCount()).toBe(0);
    expect(await saveRows()).toHaveLength(0);
  });
});
