import { describe, expect, it } from "vitest";

import { buildSearchSnippet } from "../../src/lib/search/fts";

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

describe("P34 search snippets", () => {
  it("marks the original accented match for an unaccented query", () => {
    expect(buildSearchSnippet("Úvod. Databáze a testování.", "databaze")).toBe(
      "Úvod. [[[Databáze]]] a testování.",
    );
  });

  it("marks the exact quoted phrase", () => {
    expect(
      buildSearchSnippet("Úvod. Plán migrace a testování.", '"plán migrace"'),
    ).toContain("[[[Plán migrace]]]");
  });

  it("keeps code-unit mapping aligned after non-BMP characters", () => {
    const snippet = buildSearchSnippet("😀😀 Databáze.", "databaze");
    expect(snippet).toBe("😀😀 [[[Databáze]]].");
    expect(snippet).not.toContain("\uFFFD");
  });

  it("matches letters that PostgreSQL unaccent transliterates", () => {
    expect(buildSearchSnippet("Pøhled na data.", "pohled")).toBe(
      "[[[Pøhled]]] na data.",
    );
    expect(buildSearchSnippet("Straße und Daten.", "strasse")).toBe(
      "[[[Straße]]] und Daten.",
    );
  });

  it("falls back to the beginning when the term is only in the title/tags", () => {
    expect(buildSearchSnippet("Tělo bez výrazu.", "titulek")).toBe(
      "Tělo bez výrazu.",
    );
  });

  it("does not split a surrogate pair in the no-match prefix", () => {
    const snippet = buildSearchSnippet("aaaaa😀b", "nenalezeno", 6);
    expect(snippet).toBe("aaaaa");
    expect(hasLoneSurrogate(snippet)).toBe(false);
  });
});

describe("P34 snippet Unicode edges", () => {
  it("includes a trailing non-BMP matched character without a lone surrogate", () => {
    const snippet = buildSearchSnippet("Úvod 😀𝔸.", "𝔸");
    expect(snippet).toContain("[[[𝔸]]]");
    expect(snippet).not.toContain("\uFFFD");
    expect(hasLoneSurrogate(snippet)).toBe(false);
  });

  it("does not split a surrogate pair at the context-window edge", () => {
    const content = `A😀${"x".repeat(68)} Databáze.`;
    const snippet = buildSearchSnippet(content, "databaze");
    expect(snippet).toContain("[[[Databáze]]]");
    expect(snippet).not.toContain("\uFFFD");
    expect(hasLoneSurrogate(snippet)).toBe(false);

    const trailing = buildSearchSnippet(
      `Databáze ${"x".repeat(68)}😀`,
      "databaze",
    );
    expect(trailing).toContain("[[[Databáze]]]");
    expect(trailing).toContain("😀");
    expect(hasLoneSurrogate(trailing)).toBe(false);
  });

  it("folds word-final Greek sigma consistently", () => {
    expect(buildSearchSnippet("ΟΔΟΣ a data.", "ΟΔΟΣ")).toBe(
      "[[[ΟΔΟΣ]]] a data.",
    );
    expect(buildSearchSnippet("τελος", "τελοσ")).toBe("[[[τελος]]]");
  });
});
