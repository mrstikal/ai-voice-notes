import type { List, ListItem } from "mdast";
import { visit } from "unist-util-visit";
import { describe, expect, it } from "vitest";

import {
  assertLosslessConversionSupported,
  isSafeLinkDestination,
  parseNoteMarkdown,
  type ParsedNoteMarkdown,
  type SourceOnlyReason,
  UnsupportedMarkdownError,
} from "../../src/lib/notes/markdown";
import {
  assertContentGraphemeLimit,
  assertTitleGraphemeLimit,
  CONTENT_MAX_GRAPHEMES,
  countGraphemes,
  NoteLimitError,
  TITLE_MAX_GRAPHEMES,
  validateNoteGraphemeLimits,
} from "../../src/lib/notes/limits";

function collectNodeTypes(parsed: ParsedNoteMarkdown): Set<string> {
  const types = new Set<string>();
  visit(parsed.ast, (node) => {
    types.add(node.type);
  });
  return types;
}

const supportedMarkdown = [
  "# Nadpis H1",
  "",
  "## Nadpis H2",
  "",
  "### Nadpis H3",
  "",
  "Odstavec s **tučným**, *kurzívou*, `kódem` a [odkazem](https://example.com).",
  "Měkký",
  "zlom a tvrdý\\",
  "zlom.",
  "",
  "- první",
  "- druhý",
  "  - vnořený",
  "",
  "1. jedna",
  "2. dva",
  "",
  "- [ ] otevřený úkol",
  "- [x] hotový úkol",
  "",
  "> Citace s **důrazem**.",
  ">",
  "> Druhý odstavec.",
  "",
  "```ts",
  "const hodnota = 1;",
  "```",
  "",
  "Text s `inline kódem`.",
].join("\n");

describe("grapheme counting", () => {
  it("counts Czech diacritics, combining marks, and emoji correctly", () => {
    expect(countGraphemes("Příliš žluťoučký kůň úpěl ďábelské ódy.")).toBe(39);
    expect(countGraphemes("e\u0301")).toBe(1);
    expect(countGraphemes("a\u0301b")).toBe(2);
    expect(countGraphemes("👨‍👩‍👧‍👦")).toBe(1);
    expect(countGraphemes("🇨🇿")).toBe(1);
    expect(countGraphemes("👍🏽")).toBe(1);
  });
});

describe("parseNoteMarkdown", () => {
  it("supports every documented node and extracts block-separated visible text", () => {
    const parsed = parseNoteMarkdown(supportedMarkdown);
    const nodeTypes = collectNodeTypes(parsed);

    expect(parsed.sourceOnly).toBe(false);
    expect(parsed.sourceOnlyReasons).toEqual([]);
    expect(parsed.safeLinks).toEqual([
      { url: "https://example.com", text: "odkazem" },
    ]);
    expect(parsed.graphemeCount).toBe(countGraphemes(parsed.plainText));

    for (const type of [
      "root",
      "heading",
      "paragraph",
      "text",
      "strong",
      "emphasis",
      "link",
      "inlineCode",
      "break",
      "list",
      "listItem",
      "blockquote",
      "code",
    ]) {
      expect(nodeTypes.has(type)).toBe(true);
    }

    expect(parsed.plainText).toContain("Nadpis H1\n\nNadpis H2\n\nNadpis H3");
    expect(parsed.plainText).toContain("tučným");
    expect(parsed.plainText).toContain("kurzívou");
    expect(parsed.plainText).toContain("kódem");
    expect(parsed.plainText).toContain("Měkký zlom a tvrdý\nzlom.");
    expect(parsed.plainText).toContain("první\ndruhý\nvnořený");
    expect(parsed.plainText).toContain("jedna\ndva");
    expect(parsed.plainText).toContain("otevřený úkol\nhotový úkol");
    expect(parsed.plainText).not.toContain("- první");
    expect(parsed.plainText).not.toContain("1. jedna");
    expect(parsed.plainText).toContain("Citace s důrazem.\n\nDruhý odstavec.");
    expect(parsed.plainText).toContain("const hodnota = 1;");
    expect(parsed.plainText).toContain("Text s inline kódem.");
    expect(parsed.plainText).not.toContain("**");
    expect(parsed.plainText).not.toContain("```");

    const headings: number[] = [];
    visit(parsed.ast, "heading", (node) => {
      headings.push(node.depth);
    });
    expect(headings).toEqual([1, 2, 3]);

    const lists: List[] = [];
    visit(parsed.ast, "list", (node) => {
      lists.push(node);
    });
    expect(lists.some((list) => list.ordered === true)).toBe(true);
    expect(lists.some((list) => list.ordered !== true)).toBe(true);

    const checkedValues: Array<boolean | null | undefined> = [];
    visit(parsed.ast, "listItem", (node: ListItem) => {
      if (node.checked !== null && node.checked !== undefined) {
        checkedValues.push(node.checked);
      }
    });
    expect(checkedValues).toEqual([false, true]);
  });

  it("handles empty content without becoming source-only", () => {
    const parsed = parseNoteMarkdown("");

    expect(parsed.sourceOnly).toBe(false);
    expect(parsed.plainText).toBe("");
    expect(parsed.searchText).toBe("");
    expect(parsed.graphemeCount).toBe(0);
    expect(parsed.safeLinks).toEqual([]);
  });

  it("uses a flat content_plain projection while preserving list structure in the AST", () => {
    const parsed = parseNoteMarkdown("- [ ] otevřený\n- [x] hotový\n  - vnořený");

    expect(parsed.sourceOnly).toBe(false);
    expect(parsed.plainText).toBe("otevřený\nhotový\nvnořený");
    expect(parsed.searchText).toBe(parsed.plainText);

    const checkedValues: Array<boolean | null | undefined> = [];
    visit(parsed.ast, "listItem", (node: ListItem) => {
      if (node.checked !== null && node.checked !== undefined) {
        checkedValues.push(node.checked);
      }
    });
    expect(checkedValues).toEqual([false, true]);

    const lists: List[] = [];
    visit(parsed.ast, "list", (node) => {
      lists.push(node);
    });
    expect(lists).toHaveLength(2);
  });

  it.each<{
    label: string;
    source: string;
    reasonType: SourceOnlyReason["type"];
  }>([
    {
      label: "raw HTML",
      source: "<script>alert('x')</script>",
      reasonType: "unsupported_node",
    },
    {
      label: "a GFM table",
      source: "| A | B |\n| --- | --- |\n| 1 | 2 |",
      reasonType: "unsupported_node",
    },
    {
      label: "a heading deeper than H3",
      source: "#### Nadpis H4",
      reasonType: "unsupported_heading_depth",
    },
    {
      label: "a thematic break",
      source: "---",
      reasonType: "unsupported_node",
    },
    {
      label: "an image",
      source: "![alt](image.png)",
      reasonType: "unsupported_node",
    },
  ])("preserves $label verbatim as source-only", ({ source, reasonType }) => {
    const parsed = parseNoteMarkdown(source);

    expect(parsed.sourceOnly).toBe(true);
    expect(parsed.plainText).toBe(source);
    expect(parsed.searchText).toBe(source);
    expect(parsed.graphemeCount).toBe(countGraphemes(source));
    expect(parsed.sourceOnlyReasons.some((reason) => reason.type === reasonType)).toBe(
      true,
    );
    expect(parsed.safeLinks).toEqual([]);
    expect(() => assertLosslessConversionSupported(parsed, "visual")).toThrow(
      UnsupportedMarkdownError,
    );
    expect(() => assertLosslessConversionSupported(parsed, "docx")).toThrow(
      UnsupportedMarkdownError,
    );
  });

  it("keeps a mixed document entirely source-only and exposes no clickable links", () => {
    const source =
      "# Nadpis\n\n[bezpečný odkaz](https://example.com)\n\n| A |\n| --- |\n| 1 |";
    const parsed = parseNoteMarkdown(source);

    expect(parsed.sourceOnly).toBe(true);
    expect(parsed.plainText).toBe(source);
    expect(parsed.searchText).toBe(source);
    expect(parsed.safeLinks).toEqual([]);
    expect(parsed.sourceOnlyReasons).toEqual([
      { type: "unsupported_node", nodeType: "table" },
    ]);
  });

  it("preserves unsafe link destinations as inert source text", () => {
    const destinations = [
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "//example.com",
    ];

    for (const destination of destinations) {
      const source = `[klikni](${destination})`;
      const parsed = parseNoteMarkdown(source);

      expect(parsed.sourceOnly).toBe(true);
      expect(parsed.plainText).toBe(source);
      expect(parsed.plainText).toContain(destination);
      expect(parsed.safeLinks).toEqual([]);
      expect(parsed.sourceOnlyReasons).toEqual([
        { type: "unsafe_link", url: destination },
      ]);
      expect(() => assertLosslessConversionSupported(parsed, "visual")).toThrow(
        UnsupportedMarkdownError,
      );
    }
  });

  it("does not fabricate rendered HTML from raw HTML source", () => {
    const source = "<img src=x onerror=alert(1)>";
    const parsed = parseNoteMarkdown(source);

    expect(parsed.sourceOnly).toBe(true);
    expect(parsed.plainText).toBe(source);
    expect(parsed.plainText).toContain("<img");
    expect(parsed.safeLinks).toEqual([]);
    expect(collectNodeTypes(parsed).has("html")).toBe(true);
    expect(() => assertLosslessConversionSupported(parsed, "visual")).toThrow(
      /vizuálním editoru/,
    );
  });

  it("treats percent-encoded and zero-width-obfuscated schemes as unsafe", () => {
    const destinations = [
      "java%73cript:alert(1)",
      "javascript%3Aalert(1)",
      "javascript%253Aalert(1)",
      "javascript%2525253Aalert(1)",
      "java%73cript:alert(1)%zz",
      "java%20script:alert(1)",
      "\u200Bjavascript:alert(1)",
      "%E2%80%8Bjavascript:alert(1)",
    ];

    for (const destination of destinations) {
      const source = `[klikni](${destination})`;
      const parsed = parseNoteMarkdown(source);

      expect(parsed.sourceOnly).toBe(true);
      expect(parsed.plainText).toBe(source);
      expect(parsed.safeLinks).toEqual([]);
      expect(parsed.sourceOnlyReasons).toEqual([
        { type: "unsafe_link", url: destination },
      ]);
    }
  });
});

describe("isSafeLinkDestination", () => {
  it("allows documented protocols and relative paths", () => {
    for (const destination of [
      "http://127.0.0.1:3000/notes",
      "https://example.com",
      "HTTP://EXAMPLE.COM",
      "mailto:test@example.com",
      "https://example.com/a%20b",
      "https://example.com/100%25",
      "https://example.com/a%25b",
      "mailto:test@example.com?subject=Hello%20World",
      "./relative",
      "../relative",
      "%2E%2E/relative",
      "/absolute",
      "relative/path",
      "foo%2Fbar",
      "foo%2Fbar:baz",
      "foo%2Fbar%3Abaz",
      "foo%20bar",
      "#section",
      "?query=1",
    ]) {
      expect(isSafeLinkDestination(destination)).toBe(true);
    }
  });

  it("rejects executable, data, protocol-relative, and malformed destinations", () => {
    for (const destination of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java%73cript:alert(1)",
      "javascript%3Aalert(1)",
      "javascript%253Aalert(1)",
      "javascript%2525253Aalert(1)",
      "java%73cript:alert(1)%zz",
      "java%20script:alert(1)",
      "java%0Ascript:alert(1)",
      "java%09script:alert(1)",
      "\u200Bjavascript:alert(1)",
      "%E2%80%8Bjavascript:alert(1)",
      "data:text/html,hello",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "tel:+420123456789",
      "//example.com",
      "%2F%2Fexample.com",
      "/%2F%2Fexample.com",
      "\\\\example.com",
      "%5C%5Cexample.com",
      "/%5Cevil.com",
      " javascript:alert(1)",
      "java\nscript:alert(1)",
      "javascript: alert(1)",
      "https://example.com/\nheader",
      "javascript:\u0000alert(1)",
      "",
    ]) {
      expect(isSafeLinkDestination(destination)).toBe(false);
    }
  });

  it("rejects excessively nested percent encoding", () => {
    const deeplyEncoded = `javascript${"%25".repeat(11)}3Aalert(1)`;

    expect(isSafeLinkDestination(deeplyEncoded)).toBe(false);
  });
});

describe("note limits", () => {
  it("enforces the exact title and content boundaries", () => {
    expect(assertTitleGraphemeLimit("á".repeat(TITLE_MAX_GRAPHEMES))).toBe(
      TITLE_MAX_GRAPHEMES,
    );
    expect(() =>
      assertTitleGraphemeLimit("á".repeat(TITLE_MAX_GRAPHEMES + 1)),
    ).toThrow(NoteLimitError);

    expect(() => assertContentGraphemeLimit(CONTENT_MAX_GRAPHEMES)).not.toThrow();
    expect(() => assertContentGraphemeLimit(CONTENT_MAX_GRAPHEMES + 1)).toThrow(
      NoteLimitError,
    );
    expect(() => assertContentGraphemeLimit(-1)).toThrow(RangeError);
  });

  it("counts visible graphemes rather than Markdown source bytes", () => {
    const formatted = parseNoteMarkdown(
      `**${"a".repeat(CONTENT_MAX_GRAPHEMES)}**`,
    );

    expect(formatted.sourceOnly).toBe(false);
    expect(formatted.graphemeCount).toBe(CONTENT_MAX_GRAPHEMES);
    expect(() =>
      validateNoteGraphemeLimits("Název", formatted.graphemeCount),
    ).not.toThrow();
  });

  it("rejects content at 20,001 visible graphemes", () => {
    const atLimit = parseNoteMarkdown("😀".repeat(CONTENT_MAX_GRAPHEMES));
    expect(atLimit.graphemeCount).toBe(CONTENT_MAX_GRAPHEMES);
    expect(() =>
      validateNoteGraphemeLimits("Název", atLimit.graphemeCount),
    ).not.toThrow();

    const overLimit = parseNoteMarkdown("😀".repeat(CONTENT_MAX_GRAPHEMES + 1));
    expect(overLimit.graphemeCount).toBe(CONTENT_MAX_GRAPHEMES + 1);
    expect(() =>
      validateNoteGraphemeLimits("Název", overLimit.graphemeCount),
    ).toThrow(NoteLimitError);
  });

  it("accepts a configured lower limit for the content and title", () => {
    expect(() => assertContentGraphemeLimit(100, 100)).not.toThrow();
    expect(() => assertContentGraphemeLimit(101, 100)).toThrow(NoteLimitError);
    expect(() =>
      validateNoteGraphemeLimits("Název", 101, { title: 160, content: 100 }),
    ).toThrow(NoteLimitError);
    expect(() =>
      validateNoteGraphemeLimits("Příliš dlouhý", 10, { title: 3, content: 100 }),
    ).toThrow(NoteLimitError);
  });

  it("does not throw for supported content during conversion preflight", () => {
    const parsed = parseNoteMarkdown("**bezpečný obsah**");

    expect(() => assertLosslessConversionSupported(parsed, "visual")).not.toThrow();
    expect(() => assertLosslessConversionSupported(parsed, "docx")).not.toThrow();
  });
});
