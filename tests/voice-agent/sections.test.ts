import { describe, expect, it, vi } from "vitest";

import {
  NoteNotFoundError,
  type NoteDetailDto,
} from "../../src/lib/notes/service";
import { parseNoteMarkdown } from "../../src/lib/notes/markdown";
import type { SearchResult } from "../../src/lib/search/fts";
import {
  READ_TOOL_SECTION_MAX_GRAPHEMES,
  READ_TOOL_SUMMARY_MAX_SOURCE_GRAPHEMES,
  createReadServices,
  selectNoteSectionText,
} from "../../src/lib/voice-agent/read-services";
import {
  ToolSessionError,
  ToolSessionStore,
  type ToolSessionHandle,
} from "../../src/lib/voice-agent/tool-dispatch";

const NOW = Date.parse("2026-10-30T12:00:00Z");

const STRUCTURED_CONTENT = [
  "# Poznámka o migraci",
  "",
  "První odstavec popisuje databázi.",
  "",
  "Druhý odstavec popisuje migraci API.",
  "",
  "- [ ] Ověřit databázi",
  "- [x] Napsat testy",
].join("\n");

function plainTextOf(contentMd: string): string {
  return parseNoteMarkdown(contentMd).plainText;
}

function note(
  id: string,
  title: string,
  contentMd: string,
  version = 1,
): NoteDetailDto {
  return {
    category: null,
    contentMd,
    contentPlain: plainTextOf(contentMd),
    createdAt: new Date(NOW),
    deletedAt: null,
    id,
    tags: [],
    title,
    updatedAt: new Date(NOW),
    version,
  };
}

function searchResult(items: ReadonlyArray<{ id: string; title: string }>): SearchResult {
  return {
    empty: items.length === 0,
    hasNext: false,
    items: items.map((item) => ({
      category: null,
      id: item.id,
      snippet: `[[[${item.title}]]]`,
      tags: [],
      title: item.title,
      updatedAt: new Date(NOW),
    })),
    page: 1,
    pageSize: 10,
    query: "poznámka",
    total: items.length,
  };
}

interface Harness {
  readonly notes: Map<string, NoteDetailDto>;
  readonly store: ToolSessionStore;
  readonly session: ToolSessionHandle;
  readonly summarize: ReturnType<typeof vi.fn>;
  readonly services: ReturnType<typeof createReadServices>;
}

function harness(
  initialNotes: ReadonlyArray<NoteDetailDto> = [
    note("note-a", "Migrace", STRUCTURED_CONTENT),
    note("note-b", "Druhá", "Druhá poznámka o databázi."),
  ],
): Harness {
  const notes = new Map(initialNotes.map((item) => [item.id, item]));
  const summarize = vi.fn(async ({ note: target }: { note: NoteDetailDto }) => ({
    sourceGraphemes: 10,
    summaryText: `Shrnutí poznámky ${target.title}.`,
  }));
  const services = createReadServices({
    getNote: async (noteId) => {
      const value = notes.get(noteId);

      if (!value) {
        throw new NoteNotFoundError();
      }

      return value;
    },
    searchNotes: async () =>
      searchResult(
        [...notes.values()].map((item) => ({
          id: item.id,
          title: item.title,
        })),
      ),
  });
  const store = new ToolSessionStore(
    services,
    () => NOW,
    summarize as never,
  );
  const session = store.createSession({ expiresAt: new Date(NOW + 60_000) });

  return { notes, services, session, store, summarize };
}

async function searchAndSelect(
  current: Harness,
  noteId = "note-a",
): Promise<void> {
  await current.store.dispatch({
    arguments: { query: "poznámka" },
    callId: `search-${noteId}-${Math.random()}`,
    name: "search_notes",
    sessionId: current.session.sessionId,
    turnId: "turn-1",
  });
  await current.store.selectNote(current.session.sessionId, noteId);
}

function mark(
  current: Harness,
  noteId: string,
  selection: { readonly start: number; readonly end: number } | null,
): ReturnType<ToolSessionStore["markSelection"]> {
  return current.store.markSelection(
    current.session.sessionId,
    noteId,
    selection,
  );
}

function call(
  current: Harness,
  name: string,
  args: unknown,
  callId = `call-${Math.random()}`,
): ReturnType<ToolSessionStore["dispatch"]> {
  return current.store.dispatch({
    arguments: args,
    callId,
    name,
    sessionId: current.session.sessionId,
    turnId: callId,
  });
}

describe("bounded note sections", () => {
  it("reads the last paragraph, tasks and an explicitly marked selection", async () => {
    const current = harness();
    const plain = plainTextOf(STRUCTURED_CONTENT);
    const selectedStart = plain.indexOf("První odstavec");
    const selectedEnd = selectedStart + "První odstavec popisuje databázi.".length;

    const lastParagraph = await current.services.readNoteSection({
      noteId: "note-a",
      section: "last_paragraph",
    });
    expect(lastParagraph).toMatchObject({
      noteId: "note-a",
      section: "last_paragraph",
      status: "ok",
      text: "Druhý odstavec popisuje migraci API.",
      title: "Migrace",
      truncated: false,
      version: 1,
    });

    const tasks = await current.services.readNoteSection({
      noteId: "note-a",
      section: "tasks",
    });
    expect(tasks).toMatchObject({ status: "ok", text: "Ověřit databázi\nNapsat testy" });

    const selection = await current.services.readNoteSection({
      noteId: "note-a",
      section: "selection",
      selection: { end: selectedEnd, start: selectedStart },
    });
    expect(selection).toMatchObject({
      status: "ok",
      text: "První odstavec popisuje databázi.",
    });

    const ambiguous = await current.services.readNoteSection({
      noteId: "note-a",
      section: "selection",
      selection: null,
    });
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.text).toBe("");
    expect(ambiguous.message).toContain("neoznačil");
  });

  it("bounds a section at 1,200 graphemes and reports truncation", async () => {
    const long = "x".repeat(READ_TOOL_SECTION_MAX_GRAPHEMES + 50);
    const current = harness([note("long", "Dlouhá", long)]);

    const section = await current.services.readNoteSection({
      noteId: "long",
      section: "last_paragraph",
    });

    expect(section.text).toHaveLength(READ_TOOL_SECTION_MAX_GRAPHEMES);
    expect(section.truncated).toBe(true);
    expect(section.status).toBe("ok");
  });

  it("indicates an empty section instead of guessing", async () => {
    expect(selectNoteSectionText("# Jen nadpis", "last_paragraph")).toMatchObject({
      status: "empty",
      text: "",
    });
    expect(selectNoteSectionText("Prostý odstavec.", "tasks")).toMatchObject({
      status: "empty",
      text: "",
    });
    expect(
      selectNoteSectionText(STRUCTURED_CONTENT, "selection", null).status,
    ).toBe("ambiguous");
  });

  it("rejects an unsupported Markdown section without falling back to the note", async () => {
    const current = harness([
      note("source", "Zdroj", "<div>nebezpečný blok</div>"),
    ]);

    await expect(
      current.services.readNoteSection({
        noteId: "source",
        section: "last_paragraph",
      }),
    ).rejects.toMatchObject({ code: "tts_unsupported_markdown", status: 422 });
  });
});

describe("session-bound section and summary tools", () => {
  it("stays on the chosen current note and rejects stale, deleted and cross-note reads", async () => {
    const current = harness([
      note("note-a", "Migrace", STRUCTURED_CONTENT),
      note("note-b", "Druhá", "Druhá poznámka."),
    ]);
    await searchAndSelect(current, "note-a");

    const section = await call(current, "read_note_section", {
      noteId: "note-a",
      section: "last_paragraph",
    });
    expect(section.ok).toBe(true);
    expect(section.response).toMatchObject({
      noteId: "note-a",
      status: "ok",
      text: "Druhý odstavec popisuje migraci API.",
      title: "Migrace",
    });

    const crossNote = await call(current, "read_note_section", {
      noteId: "note-b",
      section: "last_paragraph",
    });
    expect(crossNote).toMatchObject({
      ok: false,
      response: { error: { code: "note_not_selected" } },
    });

    const updated = note("note-a", "Migrace", STRUCTURED_CONTENT, 2);
    current.notes.set("note-a", updated);

    const stale = await call(current, "read_note_section", {
      noteId: "note-a",
      section: "tasks",
    });
    expect(stale).toMatchObject({
      ok: false,
      response: { error: { code: "note_stale" } },
    });

    await searchAndSelect(current, "note-a");
    current.notes.delete("note-a");

    const deleted = await call(current, "read_note_section", {
      noteId: "note-a",
      section: "tasks",
    });
    expect(deleted).toMatchObject({
      ok: false,
      response: { error: { code: "note_not_found" } },
    });
  });

  it("marks only a genuine selection inside the chosen note", async () => {
    const current = harness();
    await searchAndSelect(current, "note-a");
    const plain = plainTextOf(STRUCTURED_CONTENT);
    const start = plain.indexOf("Druhý odstavec");
    const end = plain.indexOf("migraci API.") + "migraci API.".length;

    const marked = await mark(current, "note-a", { end, start });
    expect(marked).toMatchObject({
      noteId: "note-a",
      selection: { end, start },
      title: "Migrace",
    });

    const section = await call(current, "read_note_section", {
      noteId: "note-a",
      section: "selection",
    });
    expect(section.response).toMatchObject({
      status: "ok",
      text: "Druhý odstavec popisuje migraci API.",
    });

    const cleared = await mark(current, "note-a", null);
    expect(cleared.selection).toBeNull();
    const ambiguous = await call(current, "read_note_section", {
      noteId: "note-a",
      section: "selection",
    });
    expect(ambiguous.response).toMatchObject({ status: "ambiguous" });

    await expect(
      mark(current, "note-a", { end: 0, start: 1 }),
    ).rejects.toMatchObject({ code: "selection_invalid" });
  });

  it("returns a cost confirmation before the paid summary and reuses the cached summary", async () => {
    const current = harness();
    await searchAndSelect(current, "note-a");

    const pending = await call(current, "summarize_note", { noteId: "note-a" });
    expect(pending.response).toMatchObject({
      noteId: "note-a",
      noteTitle: "Migrace",
      noteVersion: 1,
      status: "needs_user_cost_confirmation",
    });
    expect(current.summarize).not.toHaveBeenCalled();

    const approved = await current.store.approveSummary(current.session.sessionId);
    expect(approved).toMatchObject({
      noteId: "note-a",
      noteTitle: "Migrace",
      noteVersion: 1,
      status: "generated",
      summaryText: "Shrnutí poznámky Migrace.",
    });
    expect(current.summarize).toHaveBeenCalledTimes(1);

    const cached = await call(current, "summarize_note", { noteId: "note-a" });
    expect(cached.response).toMatchObject({
      status: "cached",
      summaryText: "Shrnutí poznámky Migrace.",
    });
    expect(current.summarize).toHaveBeenCalledTimes(1);
  });

  it("uses a marked passage as the bounded summary source", async () => {
    const current = harness();
    await searchAndSelect(current, "note-a");
    const plain = plainTextOf(STRUCTURED_CONTENT);
    const start = plain.indexOf("První odstavec");
    const end = start + "První odstavec popisuje databázi.".length;
    await mark(current, "note-a", { end, start });

    const pending = await call(current, "summarize_note", { noteId: "note-a" });
    expect(pending.response).toMatchObject({
      selection: { end, start },
      status: "needs_user_cost_confirmation",
    });
    expect(
      (pending.response as { sourceGraphemes: number }).sourceGraphemes,
    ).toBe("První odstavec popisuje databázi.".length);

    await current.store.approveSummary(current.session.sessionId);
    expect(current.summarize).toHaveBeenCalledWith(
      expect.objectContaining({ selection: { end, start } }),
    );
  });

  it("rejects an empty or over-limit summary source before any approval", async () => {
    const empty = harness([note("empty", "Prázdná", "")]);
    await searchAndSelect(empty, "empty");
    const emptyResult = await call(empty, "summarize_note", { noteId: "empty" });
    expect(emptyResult).toMatchObject({
      ok: false,
      response: { error: { code: "tts_empty_selection" } },
    });

    const tooLarge = harness([
      note("large", "Velká", "a".repeat(READ_TOOL_SUMMARY_MAX_SOURCE_GRAPHEMES + 1)),
    ]);
    await searchAndSelect(tooLarge, "large");
    const largeResult = await call(tooLarge, "summarize_note", {
      noteId: "large",
    });
    expect(largeResult).toMatchObject({
      ok: false,
      response: { error: { code: "summary_source_too_large" } },
    });
    expect(empty.summarize).not.toHaveBeenCalled();
    expect(tooLarge.summarize).not.toHaveBeenCalled();
    await expect(
      empty.store.approveSummary(empty.session.sessionId),
    ).rejects.toMatchObject({ code: "summary_not_requested" });
  });

  it("does not reuse a cached summary after the note version changes", async () => {
    const current = harness();
    await searchAndSelect(current, "note-a");
    await call(current, "summarize_note", { noteId: "note-a" });
    await current.store.approveSummary(current.session.sessionId);

    current.notes.set(
      "note-a",
      note("note-a", "Migrace", `${STRUCTURED_CONTENT}\n\nNová věta.`, 2),
    );

    const stale = await call(current, "summarize_note", { noteId: "note-a" });
    expect(stale).toMatchObject({
      ok: false,
      response: { error: { code: "note_stale" } },
    });

    await searchAndSelect(current, "note-a");
    const pendingAgain = await call(current, "summarize_note", {
      noteId: "note-a",
    });
    expect(pendingAgain.response).toMatchObject({
      status: "needs_user_cost_confirmation",
    });
    await current.store.approveSummary(current.session.sessionId);
    expect(current.summarize).toHaveBeenCalledTimes(2);
  });

  it("rejects approval without a pending request and a second approval", async () => {
    const current = harness();
    await searchAndSelect(current, "note-a");

    await expect(
      current.store.approveSummary(current.session.sessionId),
    ).rejects.toMatchObject({ code: "summary_not_requested" });

    await call(current, "summarize_note", { noteId: "note-a" });
    await current.store.approveSummary(current.session.sessionId);

    await expect(
      current.store.approveSummary(current.session.sessionId),
    ).rejects.toBeInstanceOf(ToolSessionError);
    expect(current.summarize).toHaveBeenCalledTimes(1);
  });

  it("confirms a summary request only for the selected note", async () => {
    const current = harness([
      note("note-a", "Migrace", STRUCTURED_CONTENT),
      note("note-b", "Druhá", "Druhá poznámka."),
    ]);
    await searchAndSelect(current, "note-a");

    const wrong = await call(current, "summarize_note", { noteId: "note-b" });
    expect(wrong).toMatchObject({
      ok: false,
      response: { error: { code: "note_not_selected" } },
    });
    expect(current.summarize).not.toHaveBeenCalled();
  });
});
