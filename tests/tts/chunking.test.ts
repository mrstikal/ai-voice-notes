import { describe, expect, it } from "vitest";

import {
  chunkText,
  TtsTextError,
  type TtsChunk,
} from "../../src/lib/tts/chunking";
import { selectTtsText } from "../../src/lib/tts/selection";

function assertExactChunks(text: string, chunks: readonly TtsChunk[]): void {
  expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);

  for (const chunk of chunks) {
    expect(text.slice(chunk.start, chunk.end)).toBe(chunk.text);
    expect(chunk.text.length).toBeGreaterThan(0);
  }
}

const SAMPLE = `# Nadpis

První odstavec s **tučným** textem a [odkazem](https://example.com).

Druhý odstavec s \`kódem\`.

- [ ] Připravit migrace.
- [x] Napsat testy.

> Citace.

\`\`\`js
console.log("ahoj");
\`\`\``;

describe("P19 read-aloud selection", () => {
  it("selects the full note without Markdown punctuation and reads tasks naturally", () => {
    const selection = selectTtsText(SAMPLE, { scope: "full" });

    expect(selection.text).toContain("Nadpis");
    expect(selection.text).toContain("První odstavec s tučným textem a odkazem.");
    expect(selection.text).toContain("Druhý odstavec s kódem.");
    expect(selection.text).toContain("Připravit migrace.");
    expect(selection.text).toContain("Napsat testy.");
    expect(selection.text).toContain("Citace.");
    expect(selection.text).toContain('console.log("ahoj");');
    expect(selection.text).not.toContain("#");
    expect(selection.text).not.toContain("**");
    expect(selection.text).not.toContain("[odkazem]");
    expect(selection.text).not.toContain("https://example.com");
    expect(selection.text).not.toContain("- [");
    expect(selection.text).not.toContain("`");
  });

  it("selects an exact explicit range in the P02 plain text", () => {
    const full = selectTtsText(SAMPLE, { scope: "full" }).text;
    const start = full.indexOf("Druhý odstavec");
    const end = full.indexOf("\n\n", start);
    const selection = selectTtsText(SAMPLE, {
      scope: "range",
      start,
      end,
    });

    expect(selection.text).toBe("Druhý odstavec s kódem.");
  });

  it("selects one top-level paragraph by index or by a contained range", () => {
    const byIndex = selectTtsText(SAMPLE, {
      scope: "paragraph",
      paragraphIndex: 1,
    });
    const full = selectTtsText(SAMPLE, { scope: "full" }).text;
    const start = full.indexOf("První odstavec");
    const byRange = selectTtsText(SAMPLE, {
      scope: "paragraph",
      start,
      end: start + 5,
    });

    expect(byIndex.text).toBe("Druhý odstavec s kódem.");
    expect(byRange.text).toBe(
      "První odstavec s tučným textem a odkazem.",
    );
  });

  it("selects all tasks or one current checklist", () => {
    const all = selectTtsText(SAMPLE, { scope: "tasks" });
    const one = selectTtsText(SAMPLE, { scope: "tasks", listIndex: 0 });

    expect(all.text).toBe("Připravit migrace.\nNapsat testy.");
    expect(one.text).toBe("Připravit migrace.\nNapsat testy.");
  });

  it("selects a checklist containing the explicit range", () => {
    const content = "- [ ] A\n- [ ] B\n\nMezitext.\n\n- [ ] C";
    const full = selectTtsText(content, { scope: "full" }).text;
    const start = full.indexOf("C");
    const selection = selectTtsText(content, {
      scope: "tasks",
      start,
      end: start + 1,
    });

    expect(selection.text).toBe("C");
  });

  it("selects one of two separate checklists by listIndex", () => {
    const content = "- [ ] A\n- [ ] B\n\nMezitext.\n\n- [ ] C";

    expect(selectTtsText(content, { scope: "tasks", listIndex: 1 }).text).toBe(
      "C",
    );
    expect(selectTtsText(content, { scope: "tasks" }).text).toBe(
      "A\nB\nC",
    );
  });

  it("rejects a range that splits a grapheme", () => {
    const content = "A👨‍👩‍👧‍👦B";

    expect(() =>
      selectTtsText(content, { scope: "range", start: 1, end: 2 }),
    ).toThrowError(
      expect.objectContaining({
        code: "tts_range_splits_grapheme",
      }),
    );
  });

  it("rejects source-only Markdown for full and range reads instead of reading punctuation", () => {
    const table = "| A | B |\n|---|---|\n| 1 | 2 |";

    expect(() => selectTtsText(table, { scope: "full" })).toThrowError(
      expect.objectContaining({ code: "tts_unsupported_markdown" }),
    );
    expect(() =>
      selectTtsText(table, { scope: "range", start: 0, end: 1 }),
    ).toThrowError(
      expect.objectContaining({ code: "tts_unsupported_markdown" }),
    );
  });

  it("fails closed when a selected block contains unsupported inline content", () => {
    const content = "Ahoj ~~světe~~ jak se máš.\n\n- [ ] ~~Hotovo~~ úkol.";

    expect(() =>
      selectTtsText(content, { scope: "paragraph", paragraphIndex: 0 }),
    ).toThrowError(
      expect.objectContaining({ code: "tts_unsupported_markdown" }),
    );
    expect(() =>
      selectTtsText(content, { scope: "tasks", listIndex: 0 }),
    ).toThrowError(
      expect.objectContaining({ code: "tts_unsupported_markdown" }),
    );
  });

  it("reads a supported paragraph or checklist inside a partially unsupported note", () => {
    const content =
      "| A | B |\n|---|---|\n| 1 | 2 |\n\nPodporovaný odstavec.\n\n- [ ] Úkol.";

    expect(
      selectTtsText(content, { scope: "paragraph", paragraphIndex: 0 })
        .text,
    ).toBe("Podporovaný odstavec.");
    expect(selectTtsText(content, { scope: "tasks", listIndex: 0 }).text).toBe(
      "Úkol.",
    );
  });

  it("rejects an empty selection", () => {
    expect(() => selectTtsText("   \n\n", { scope: "full" })).toThrowError(
      expect.objectContaining({ code: "tts_empty_selection" }),
    );
  });
});

describe("P19 chunking", () => {
  it("keeps a short selection as one exact chunk", () => {
    const text = "Krátký text.";
    const chunks = chunkText(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe(text);
    assertExactChunks(text, chunks);
  });

  it("packs paragraphs into a bounded chunk without dropping characters", () => {
    const text = "První odstavec.\n\nDruhý odstavec.";
    const chunks = chunkText(text, 20);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toBe("První odstavec.\n\n");
    expect(chunks[1]?.text).toBe("Druhý odstavec.");
    assertExactChunks(text, chunks);
  });

  it("splits an oversized paragraph at sentence boundaries", () => {
    const text = "První věta. Druhá věta. Třetí věta.";
    const chunks = chunkText(text, 20);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 20)).toBe(true);
    assertExactChunks(text, chunks);
  });

  it("splits one oversized sentence at grapheme boundaries", () => {
    const text = "a".repeat(25);
    const chunks = chunkText(text, 10);

    expect(chunks.map((chunk) => chunk.text.length)).toEqual([10, 10, 5]);
    assertExactChunks(text, chunks);
  });

  it("never cuts a combined grapheme or emoji", () => {
    const grapheme = "👨‍👩‍👧‍👦";
    const text = grapheme.repeat(3);
    const chunks = chunkText(text, grapheme.length);

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.text === grapheme)).toBe(true);
    assertExactChunks(text, chunks);
  });

  it("returns an explicit unspeakable-section error when one grapheme exceeds the bound", () => {
    const grapheme = "👨‍👩‍👧‍👦";

    expect(() => chunkText(grapheme, 2)).toThrowError(
      expect.objectContaining({
        code: "tts_unspeakable_section",
        status: 422,
      }),
    );
  });

  it("rejects empty text", () => {
    expect(() => chunkText(" \n ")).toThrowError(
      expect.objectContaining({ code: "tts_empty_selection" }),
    );
  });

  it("keeps the 3,500 UTF-16 code-unit default bound", () => {
    const text = "a".repeat(3_501);
    const chunks = chunkText(text);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.text.length <= 3_500)).toBe(true);
    assertExactChunks(text, chunks);
  });
});

describe("P19 text errors", () => {
  it("exposes a stable TtsTextError shape", () => {
    const error = new TtsTextError(400, "test_code", "Test", { a: 1 });

    expect(error.status).toBe(400);
    expect(error.code).toBe("test_code");
    expect(error.details).toEqual({ a: 1 });
  });
});
