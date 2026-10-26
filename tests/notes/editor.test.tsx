// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JSONContent } from "@tiptap/core";

import { NoteEditor } from "../../src/components/notes/NoteEditor";
import type { NoteDetail } from "../../src/lib/notes/client";
import {
  VisualConversionError,
  assertVisualEditorRoundTrip,
  canonicalizeMarkdownAst,
  convertMarkdownToVisual,
  serializeVisualJson,
} from "../../src/lib/notes/editor-markdown";
import { parseNoteMarkdown } from "../../src/lib/notes/markdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const emptyRectList = [] as unknown as DOMRectList;
const emptyRect = {
  bottom: 0,
  height: 0,
  left: 0,
  right: 0,
  top: 0,
  width: 0,
  x: 0,
  y: 0,
} as DOMRect;

if (!Range.prototype.getClientRects) {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => emptyRectList,
  });
}

if (!("getClientRects" in Text.prototype)) {
  Object.defineProperty(Text.prototype, "getClientRects", {
    configurable: true,
    value: () => emptyRectList,
  });
}

if (!("getBoundingClientRect" in Text.prototype)) {
  Object.defineProperty(Text.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => emptyRect,
  });
}

if (!Range.prototype.getBoundingClientRect) {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => emptyRect,
  });
}

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
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
  "  - [ ] vnořený úkol",
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

const baseNote: NoteDetail = {
  category: null,
  contentMd: "",
  contentPlain: "",
  createdAt: "2026-10-25T10:00:00.000Z",
  deletedAt: null,
  id: "11111111-1111-4111-8111-111111111111",
  tags: [],
  title: "Testovací poznámka",
  updatedAt: "2026-10-25T10:00:00.000Z",
  version: 1,
};

function renderEditor(overrides: Partial<NoteDetail> = {}) {
  const note: NoteDetail = { ...baseNote, ...overrides };
  const onSaved = vi.fn();
  const view = render(<NoteEditor note={note} onSaved={onSaved} />);
  return { ...view, note, onSaved, user: userEvent.setup() };
}

function sourceTextarea(): HTMLTextAreaElement {
  return screen.getByLabelText("Obsah (Markdown)") as HTMLTextAreaElement;
}

function normalizedCounterText(): string {
  return (
    screen.getByTestId("note-grapheme-counter").textContent?.replace(/\s+/gu, " ") ??
    ""
  );
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NoteEditor source mode", () => {
  it("shows the canonical Markdown and the P02 visible-grapheme count", () => {
    renderEditor({ contentMd: "# Nadpis\n\nPříliš žluťoučký kůň." });

    expect(sourceTextarea().value).toBe("# Nadpis\n\nPříliš žluťoučký kůň.");
    expect(normalizedCounterText()).toContain(
      `${parseNoteMarkdown("# Nadpis\n\nPříliš žluťoučký kůň.").graphemeCount} / 20 000`,
    );
    expect(
      (screen.getByRole("button", { name: "Uložit" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("keeps over-limit text editable but refuses to save it", async () => {
    renderEditor();
    const textarea = sourceTextarea();

    fireEvent.change(textarea, { target: { value: "a".repeat(20_001) } });

    await waitFor(() => {
      expect(normalizedCounterText()).toContain("20 001 / 20 000");
    });
    expect(textarea.disabled).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Uložit" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain(
      "Poznámka překračuje limit",
    );

    fireEvent.change(textarea, { target: { value: "a".repeat(20_000) } });

    await waitFor(() => {
      expect(normalizedCounterText()).toContain("20 000 / 20 000");
      expect(
        (screen.getByRole("button", { name: "Uložit" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
  });
});

describe("NoteEditor visual round trip", () => {
  it("preserves Czech H1-H3, nested task lists, breaks, quotes, marks, links and code", async () => {
    const { user } = renderEditor();
    fireEvent.change(sourceTextarea(), { target: { value: supportedMarkdown } });

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));

    const visual = await screen.findByRole("textbox", {
      name: "Vizuální editor poznámky",
    });

    expect(visual.querySelector("h1")?.textContent).toBe("Nadpis H1");
    expect(visual.querySelector("h2")?.textContent).toBe("Nadpis H2");
    expect(visual.querySelector("h3")?.textContent).toBe("Nadpis H3");
    expect(visual.querySelector("strong")?.textContent).toBe("tučným");
    expect(visual.querySelector("em")?.textContent).toBe("kurzívou");
    expect(visual.querySelector("p code")?.textContent).toBe("kódem");
    expect(
      visual.querySelectorAll("br:not(.ProseMirror-trailingBreak)"),
    ).toHaveLength(1);
    expect(visual.querySelector("blockquote")?.textContent).toContain(
      "Citace s důrazem.",
    );
    expect(visual.querySelector("pre code")?.textContent).toContain(
      "const hodnota = 1;",
    );
    expect(visual.querySelector('a[href="https://example.com"]')?.textContent).toBe(
      "odkazem",
    );

    const checkboxes = Array.from(
      visual.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes[0]?.checked).toBe(false);
    expect(checkboxes[1]?.checked).toBe(true);
    expect(checkboxes[2]?.checked).toBe(false);
    expect(
      visual.querySelector('ul[data-type="taskList"] ul[data-type="taskList"]'),
    ).not.toBeNull();
    expect(
      visual.querySelectorAll("ul ul, ul ol, ol ul, ol ol").length,
    ).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Zdrojový režim" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", {
          name: "Vizuální editor poznámky",
        }),
      ).toBeNull();
    });

    const roundTrip = sourceTextarea().value;
    expect(canonicalizeMarkdownAst(parseNoteMarkdown(roundTrip).ast)).toEqual(
      canonicalizeMarkdownAst(parseNoteMarkdown(supportedMarkdown).ast),
    );
    expect(roundTrip).toContain("Nadpis H1");
    expect(roundTrip).toContain("tučným");
    expect(roundTrip).toContain("vnořený úkol");
    expect(roundTrip).toContain("const hodnota = 1;");
  });


  it("does not mark the note dirty when switching to visual mode", async () => {
    const { user } = renderEditor({ contentMd: "# Nadpis" });

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));
    await screen.findByRole("textbox", {
      name: "Vizuální editor poznámky",
    });

    expect(screen.getByRole("status").textContent).toContain(
      "Vše je uloženo.",
    );
    expect(
      (screen.getByRole("button", { name: "Uložit" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("refuses a GFM table and keeps the source editable", async () => {
    const { user } = renderEditor();
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    fireEvent.change(sourceTextarea(), { target: { value: table } });

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));

    expect(screen.getByRole("alert").textContent).toContain("table");
    expect(screen.getByRole("alert").textContent).toContain("zdrojovém režimu");
    expect(sourceTextarea().value).toBe(table);
    expect(
      screen.queryByRole("textbox", { name: "Vizuální editor poznámky" }),
    ).toBeNull();
  });



  it("falls back to source mode when visual content cannot be serialized", async () => {
    const { user } = renderEditor({ contentMd: "# Nadpis" });

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));
    const visual = await screen.findByRole("textbox", {
      name: "Vizuální editor poznámky",
    });
    visual.focus();
    await user.click(screen.getByRole("button", { name: "Pevný zlomek" }));
    await user.click(screen.getByRole("button", { name: "Zdrojový režim" }));

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Přepnuto do zdrojového režimu");
    expect(alert.textContent).not.toContain("Zůstaňte ve vizuálním režimu");
    expect(screen.getByRole("status").textContent).toContain(
      "nebyla přenesena",
    );
    expect(sourceTextarea().value).toBe("# Nadpis");
  });

  it("refuses a whitespace-only entity paragraph and keeps the source", async () => {
    const { user } = renderEditor();
    fireEvent.change(sourceTextarea(), { target: { value: "&nbsp;" } });

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));

    expect(screen.getByRole("alert").textContent).toContain("změnil význam");
    expect(sourceTextarea().value).toBe("&nbsp;");
  });

  it("refuses unsafe links without exposing a clickable destination", async () => {
    const { user } = renderEditor();
    const unsafe = "[klikni](javascript:alert(1))";
    fireEvent.change(sourceTextarea(), { target: { value: unsafe } });

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));

    expect(screen.getByRole("alert").textContent).toContain("nebezpečný odkaz");
    expect(sourceTextarea().value).toBe(unsafe);
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("keeps an escaped block marker as paragraph text in visual mode", async () => {
    const { user } = renderEditor();
    const literalHeading = "\\# doslova";
    fireEvent.change(sourceTextarea(), { target: { value: literalHeading } });

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));

    const visual = await screen.findByRole("textbox", {
      name: "Vizuální editor poznámky",
    });
    expect(visual.querySelector("h1")).toBeNull();
    expect(visual.textContent).toContain("# doslova");

    await user.click(screen.getByRole("button", { name: "Zdrojový režim" }));

    await waitFor(() => {
      expect(sourceTextarea().value).toContain("\\# doslova");
    });
  });

  it("decodes named entities without losing text", async () => {
    const { user } = renderEditor();
    fireEvent.change(sourceTextarea(), {
      target: { value: "&copy; 2026 a &nbsp; mezera" },
    });

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));

    const visual = await screen.findByRole("textbox", {
      name: "Vizuální editor poznámky",
    });
    expect(visual.textContent).toContain("© 2026");

    await user.click(screen.getByRole("button", { name: "Zdrojový režim" }));

    await waitFor(() => {
      expect(sourceTextarea().value).toContain("© 2026");
    });
  });
});


describe("Tiptap Markdown subset smoke test", () => {
  const cases: Array<{ label: string; markdown: string }> = [
    { label: "Czech H1-H3", markdown: "# H1\n\n## H2\n\n### H3" },
    {
      label: "paragraph marks and inline code",
      markdown: "Odstavec s **tučným**, *kurzívou* a `kódem`.",
    },
    {
      label: "safe link with title",
      markdown: '[odkaz](https://example.com "Titulek")',
    },
    { label: "hard break", markdown: "První\\\ndruhý" },
    {
      label: "indented hard break continuation",
      markdown: "První\\\n  druhý",
    },
    {
      label: "hard break in ordered list item",
      markdown: "1. a\\\n   b",
    },
    {
      label: "hard break in bullet list item",
      markdown: "- a\\\n  b",
    },
    {
      label: "hard break in task item",
      markdown: "- [ ] a\\\n  b",
    },
    {
      label: "space hard break in checked task item",
      markdown: "- [x] a  \n  b",
    },
    {
      label: "blockquote",
      markdown: "> citace\n>\n> druhý odstavec",
    },
    {
      label: "nested bullet list",
      markdown: "- jedna\n- dva\n  - vnořený",
    },
    { label: "ordered list", markdown: "1. jedna\n2. dva" },
    {
      label: "nested task list",
      markdown: "- [ ] úkol\n- [x] hotový\n  - [ ] vnořený",
    },
    {
      label: "fenced code",
      markdown: "```ts\nconst x = 1;\n```",
    },
    { label: "escaped heading marker", markdown: "\\# doslova" },
    { label: "escaped bullet marker", markdown: "\\- doslova" },
    { label: "escaped quote marker", markdown: "\\> doslova" },
    { label: "escaped ordered marker", markdown: "1\\. doslova" },
    { label: "named entity copy", markdown: "&copy; 2026" },
    { label: "inline named entity nbsp", markdown: "a &nbsp; b" },
    { label: "double-escaped ampersand", markdown: "&amp;amp;" },
    { label: "escaped named entity copy", markdown: "&amp;copy;" },
    { label: "escaped named entity nbsp", markdown: "&amp;nbsp;" },
    { label: "empty first bullet item", markdown: "- \n- b" },
    { label: "empty first ordered item", markdown: "1. \n2. b" },
    { label: "empty last ordered item", markdown: "1. a\n2. " },
    { label: "ordered list starting at ten", markdown: "10. x\n11. " },
    {
      label: "link entity in destination",
      markdown: "[x](https://example.com?a=1&amp;b=2)",
    },
    {
      label: "link entity in title",
      markdown: '[x](https://example.com "A &amp; B")',
    },
    {
      label: "ampersand and angle brackets",
      markdown: "Text s &amp; a &lt;tag&gt;.",
    },
    { label: "empty document", markdown: "" },
    { label: "whitespace-only document", markdown: "   \n\n  " },
  ];

  it.each(cases)("round-trips $label", ({ markdown }) => {
    const roundTrip = assertVisualEditorRoundTrip(markdown);

    expect(parseNoteMarkdown(roundTrip).plainText).toBe(
      parseNoteMarkdown(markdown).plainText,
    );
  });

  it.each([
    "&nbsp;",
    "&nbsp;&nbsp;",
    "\u00a0",
    "&emsp;",
    "&ensp;",
    "&thinsp;",
    "&Tab;",
    "&NewLine;",
  ])("refuses a whitespace-only paragraph %s", (markdown) => {
    expect(() => convertMarkdownToVisual(markdown)).toThrow(
      VisualConversionError,
    );
  });

  it("serializes a document with an empty paragraph", () => {
    const json: JSONContent = {
      content: [
        { content: [{ text: "a", type: "text" }], type: "paragraph" },
        { type: "paragraph" },
      ],
      type: "doc",
    };

    expect(() => serializeVisualJson(json)).not.toThrow();
  });

  it("round-trips visual text that looks like a named entity", () => {
    for (const text of ["&copy; 2026", "&nbsp;", "&amp;copy;"]) {
      const json: JSONContent = {
        content: [
          {
            content: [{ text, type: "text" }],
            type: "paragraph",
          },
        ],
        type: "doc",
      };

      const markdown = serializeVisualJson(json);
      expect(() => assertVisualEditorRoundTrip(markdown)).not.toThrow();
    }
  });

  it("refuses a visual document with a hard break inside a heading", () => {
    const json: JSONContent = {
      content: [
        {
          attrs: { level: 1 },
          content: [
            { text: "Nadpis", type: "text" },
            { type: "hardBreak" },
            { text: "druhý", type: "text" },
          ],
          type: "heading",
        },
      ],
      type: "doc",
    };

    expect(() => serializeVisualJson(json)).toThrow();
  });
});

describe("NoteEditor explicit save", () => {
  it("sends a versioned manual PATCH and shows the persisted version", async () => {
    const note = { ...baseNote, contentMd: "# Původní" };
    const onSaved = vi.fn();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as {
          contentMd: string;
        };

        return new Response(
          JSON.stringify({
            ...note,
            contentMd: payload.contentMd,
            contentPlain: "Nový obsah",
            updatedAt: "2026-10-25T11:00:00.000Z",
            version: 2,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<NoteEditor note={note} onSaved={onSaved} />);
    fireEvent.change(sourceTextarea(), { target: { value: "Nový obsah" } });

    await user.click(screen.getByRole("button", { name: "Uložit" }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Uloženo");
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/notes/${note.id}`);
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      contentMd: "Nový obsah",
      expectedVersion: 1,
      title: note.title,
    });
    expect(screen.getByRole("status").textContent).toContain("verze 2");
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ contentMd: "Nový obsah", version: 2 }),
    );
    expect(
      (screen.getByRole("button", { name: "Uložit" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });


  it("saves after pressing Enter in visual mode", async () => {
    const note = { ...baseNote, contentMd: "První" };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as {
          contentMd: string;
        };

        return new Response(
          JSON.stringify({
            ...note,
            contentMd: payload.contentMd,
            contentPlain: payload.contentMd,
            updatedAt: "2026-10-25T11:00:00.000Z",
            version: 2,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<NoteEditor note={note} />);

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));
    const visual = await screen.findByRole("textbox", {
      name: "Vizuální editor poznámky",
    });
    visual.focus();
    await user.keyboard("{Enter}");

    const saveButton = screen.getByRole("button", {
      name: "Uložit",
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    await user.click(saveButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });


  it("keeps the persisted status visible after saving in visual mode", async () => {
    const note = { ...baseNote, contentMd: "První" };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as {
          contentMd: string;
        };

        return new Response(
          JSON.stringify({
            ...note,
            contentMd: payload.contentMd,
            contentPlain: payload.contentMd,
            updatedAt: "2026-10-25T11:00:00.000Z",
            version: 2,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<NoteEditor note={note} />);

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));
    const visual = await screen.findByRole("textbox", {
      name: "Vizuální editor poznámky",
    });
    visual.focus();
    await user.keyboard("x");

    const saveButton = screen.getByRole("button", {
      name: "Uložit",
    }) as HTMLButtonElement;
    await waitFor(() => {
      expect(saveButton.disabled).toBe(false);
    });
    await user.click(saveButton);

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Uloženo");
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByRole("status").textContent).toContain("verze 2");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a 409 error visible after saving in visual mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "version_conflict",
                latestVersion: 9,
                message: "Poznámka byla mezitím změněna. Načtěte ji znovu.",
              },
            }),
            {
              headers: { "content-type": "application/json" },
              status: 409,
            },
          ),
      ),
    );
    const user = userEvent.setup();
    render(<NoteEditor note={{ ...baseNote, contentMd: "První" }} />);

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));
    const visual = await screen.findByRole("textbox", {
      name: "Vizuální editor poznámky",
    });
    visual.focus();
    await user.keyboard("x");

    const saveButton = screen.getByRole("button", {
      name: "Uložit",
    }) as HTMLButtonElement;
    await waitFor(() => {
      expect(saveButton.disabled).toBe(false);
    });
    await user.click(saveButton);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("změněna");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByRole("alert").textContent).toContain("Aktuální verze: 9");
  });

  it("keeps the local draft and shows the latest version on a 409 conflict", async () => {
    const onSaved = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "version_conflict",
                latestVersion: 7,
                message: "Poznámka byla mezitím změněna. Načtěte ji znovu.",
              },
            }),
            {
              headers: { "content-type": "application/json" },
              status: 409,
            },
          ),
      ),
    );
    const user = userEvent.setup();
    render(<NoteEditor note={baseNote} onSaved={onSaved} />);
    fireEvent.change(sourceTextarea(), {
      target: { value: "Můj nový text" },
    });

    await user.click(screen.getByRole("button", { name: "Uložit" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("změněna");
    expect(alert.textContent).toContain("Aktuální verze: 7");
    expect(alert.textContent).toContain("Váš text zůstal v editoru.");
    expect(sourceTextarea().value).toBe("Můj nový text");
    expect(screen.getByRole("status").textContent).toContain("Neuložené změny");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("allows saving source-only Markdown from source mode", async () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const note = { ...baseNote };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as {
          contentMd: string;
        };

        return new Response(
          JSON.stringify({
            ...note,
            contentMd: payload.contentMd,
            contentPlain: payload.contentMd,
            updatedAt: "2026-10-25T11:00:00.000Z",
            version: 2,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<NoteEditor note={note} />);
    fireEvent.change(sourceTextarea(), { target: { value: table } });

    await user.click(screen.getByRole("button", { name: "Uložit" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      contentMd: table,
      expectedVersion: 1,
      title: note.title,
    });
  });
});
