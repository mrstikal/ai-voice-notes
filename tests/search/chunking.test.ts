import { describe, expect, it } from "vitest";

import {
  CHUNK_MAX_TOKENS,
  chunkNoteMarkdown,
} from "../../src/lib/search/chunking";
import { parseNoteMarkdown } from "../../src/lib/notes/markdown";

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);

      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }

      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }

  return false;
}

describe("P35 deterministic chunking", () => {
  it("is deterministic, bounded and includes headings/paragraphs/code", () => {
    const content = [
      "# Plán migrace",
      "",
      "První odstavec o databázi.",
      "",
      "Druhý odstavec o testování.",
      "",
      "```text",
      "kódový blok",
      "```",
    ].join("\n");
    const first = chunkNoteMarkdown(content);
    const second = chunkNoteMarkdown(content);

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
    expect(first.map((chunk) => chunk.text).join("\n\n")).toContain(
      "Plán migrace",
    );
    expect(first.map((chunk) => chunk.text).join("\n\n")).toContain(
      "kódový blok",
    );

    for (const chunk of first) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
      expect(hasLoneSurrogate(chunk.text)).toBe(false);
    }
  });

  it("splits an oversized paragraph at sentence/grapheme boundaries", () => {
    const sentence = "Toto je delší věta o migraci a testování. ";
    const content = sentence.repeat(220);
    const chunks = chunkNoteMarkdown(content);

    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
      expect(chunk.text.trim()).not.toBe("");
      expect(hasLoneSurrogate(chunk.text)).toBe(false);
    }
  });

  it("does not break graphemes when hard-splitting", () => {
    const content = `${"👨‍👩‍👧‍👦".repeat(120)} konec`;
    const chunks = chunkNoteMarkdown(content);

    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
      expect(hasLoneSurrogate(chunk.text)).toBe(false);
      expect(chunk.text).not.toContain("\uFFFD");
    }
  });

  it("indexes source-only notes from source-derived search text", () => {
    const content = [
      "# Nadpis",
      "",
      "| tabulka | hodnota |",
      "| --- | --- |",
      "| klíč | data |",
      "",
      "<script>alert(1)</script>",
    ].join("\n");
    const parsed = parseNoteMarkdown(content);
    expect(parsed.sourceOnly).toBe(true);

    const chunks = chunkNoteMarkdown(content);
    const text = chunks.map((chunk) => chunk.text).join("\n");
    expect(text).toContain("tabulka");
    expect(text).toContain("script");
  });

  it("chunks list and blockquote-only visible content", () => {
    const content = [
      "- [ ] Koupit mléko",
      "- [x] Zavolat lékaři",
      "",
      "> Citace z porady.",
    ].join("\n");
    const chunks = chunkNoteMarkdown(content);
    const text = chunks.map((chunk) => chunk.text).join("\n");

    expect(chunks.length).toBeGreaterThan(0);
    expect(text).toContain("Koupit mléko");
    expect(text).toContain("Zavolat lékaři");
    expect(text).toContain("Citace z porady");
  });

  it("returns no chunks for empty content", () => {
    expect(chunkNoteMarkdown("   \n\n ")).toEqual([]);
  });
});
