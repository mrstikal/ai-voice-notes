import { describe, expect, it } from "vitest";

import {
  READ_SELECTION_TRANSCRIPT_MAX_GRAPHEMES,
  parseReadSelection,
} from "../../src/lib/notes/read-selection";
import { parseNoteMarkdown } from "../../src/lib/notes/markdown";
import { selectTtsText } from "../../src/lib/tts/selection";

const content = [
  "První odstavec o migraci.",
  "",
  "Druhý odstavec o testování.",
  "",
  "Třetí odstavec o nasazení.",
  "",
  "- [ ] Koupit mléko",
  "- [x] Zavolat lékaři",
].join("\n");
const note = {
  contentMd: content,
  id: "11111111-1111-4111-8111-111111111111",
  version: 4,
};
const plain = parseNoteMarkdown(content).plainText;

function read(transcript: string, extra: Record<string, unknown> = {}) {
  return parseReadSelection({
    transcript,
    note,
    ...extra,
  });
}

describe("P32 read selection", () => {
  it("selects the exact full note and explicit range text without mutation", () => {
    const full = read("Přečíst vše");
    expect(full.action).toBe("read");
    if (full.action !== "read") return;
    expect(full.text).toBe(selectTtsText(content, { scope: "full" }).text);
    expect(full.noteVersion).toBe(4);

    const range = read("Přečíst označený text", {
      selection: { start: 0, end: 26 },
    });
    expect(range.action).toBe("read");
    if (range.action !== "read") return;
    expect(range.text).toBe(
      selectTtsText(content, { scope: "range", start: 0, end: 26 }).text,
    );
    expect(content).toBe(note.contentMd);
  });

  it("selects one selected paragraph and rejects an ambiguous partial selection", () => {
    const paragraph = read("Přečíst tento odstavec", {
      paragraphIndex: 1,
    });
    expect(paragraph.action).toBe("read");
    if (paragraph.action !== "read") return;
    expect(paragraph.selection).toMatchObject({
      scope: "paragraph",
      paragraphIndex: 1,
    });
    expect(paragraph.text).toBe("Druhý odstavec o testování.");

    const paragraphText = selectTtsText(content, {
      scope: "paragraph",
      paragraphIndex: 1,
    }).text;
    const offset = plain.indexOf(paragraphText);
    const bySelection = read("Přečíst tento odstavec", {
      selection: { start: offset, end: offset + 10 },
    });
    expect(bySelection.action).toBe("read");
    if (bySelection.action !== "read") return;
    expect(bySelection.selection).toMatchObject({
      scope: "paragraph",
      paragraphIndex: 1,
    });

    expect(read("Přečíst tento odstavec")).toMatchObject({
      action: "clarify",
    });
    expect(
      read("Přečíst označený text", {
        selection: { start: 0, end: 5 },
      }),
    ).toMatchObject({ action: "read" });
  });

  it("reads tasks, including checked status content, and jen úkoly", () => {
    const tasks = read("Přečíst úkoly");
    expect(tasks.action).toBe("read");
    if (tasks.action !== "read") return;
    expect(tasks.selection).toEqual({ scope: "tasks" });
    expect(tasks.text).toBe(
      selectTtsText(content, { scope: "tasks" }).text,
    );
    expect(tasks.text).toContain("Koupit mléko");
    expect(tasks.text).toContain("Zavolat lékaři");

    expect(read("jen úkoly")).toMatchObject({
      action: "read",
      selection: { scope: "tasks" },
    });
  });

  it("selects the latest one to five paragraphs exactly for one-turn commands", () => {
    const two = read("Přečíst poslední dva odstavce");
    expect(two.action).toBe("read");
    if (two.action !== "read") return;
    expect(two.selection).toMatchObject({
      scope: "last_paragraphs",
      count: 2,
    });
    expect(two.text).toBe(
      "Druhý odstavec o testování.\n\nTřetí odstavec o nasazení.",
    );

    const numeric = read("Přečíst poslední 1 odstavec");
    expect(numeric.action).toBe("read");
    if (numeric.action !== "read") return;
    expect(numeric.text).toBe("Třetí odstavec o nasazení.");

    const interleaved = read("Přečíst poslední dva odstavce", {
      note: {
        contentMd: "První odstavec.\n\n- [ ] Úkol\n\nDruhý odstavec.",
        id: "22222222-2222-4222-8222-222222222222",
        version: 1,
      },
    });
    expect(interleaved.action).toBe("read");
    if (interleaved.action !== "read") return;
    expect(interleaved.text).toBe("První odstavec.\n\nDruhý odstavec.");
    expect(interleaved.text).not.toContain("Úkol");

    expect(read("Přečíst poslední odstavce")).toMatchObject({
      action: "clarify",
    });
  });

  it("refuses missing and stale summaries and returns current summary text only", () => {
    expect(read("Přečíst shrnutí")).toMatchObject({
      action: "summary_missing",
    });
    expect(
      read("Přečíst shrnutí", {
        summary: {
          noteId: note.id,
          noteVersion: 3,
          text: "Stará verze.",
        },
      }),
    ).toMatchObject({ action: "summary_stale" });
    expect(
      read("Přečíst shrnutí", {
        summary: {
          noteId: "33333333-3333-4333-8333-333333333333",
          noteVersion: 4,
          text: "Cizí shrnutí.",
        },
      }),
    ).toMatchObject({ action: "summary_stale" });
    expect(
      read("Přečíst shrnutí", {
        summary: {
          noteId: note.id,
          noteVersion: 4,
          text: "Aktuální shrnutí.",
        },
      }),
    ).toEqual({
      action: "summary",
      noteVersion: 4,
      text: "Aktuální shrnutí.",
    });
  });

  it("clarifies unsupported, overlong and unavailable read requests without note changes", () => {
    expect(read("Přečíst nevím co")).toMatchObject({ action: "clarify" });
    expect(read("Připravit migraci")).toMatchObject({ action: "clarify" });
    expect(
      read("Přečíst vše", {
        transcript: "x".repeat(READ_SELECTION_TRANSCRIPT_MAX_GRAPHEMES + 1),
      }),
    ).toMatchObject({ action: "clarify" });
    expect(
      read("Přečíst úkoly", {
        note: { contentMd: "Bez úkolů.", version: 1 },
      }),
    ).toMatchObject({ action: "clarify" });
    expect(note.contentMd).toBe(content);
  });
});
