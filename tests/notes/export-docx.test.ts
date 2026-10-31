import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  DOCX_EXPORT_MAX_BYTES,
  DocxExportTooLargeError,
  renderNoteDocx,
} from "../../src/lib/notes/export-docx";
import { UnsupportedMarkdownError } from "../../src/lib/notes/markdown";

const markdown = [
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
  "3. tři",
  "4. čtyři",
  "",
  "- [ ] otevřený úkol",
  "- [x] hotový úkol",
  "  - [ ] vnořený úkol",
  "",
  "> Citace s **důrazem**.",
  "",
  "```ts",
  "const hodnota = 1;",
  "const pozdrav = 'Příliš žluťoučký kůň';",
  "```",
].join("\n");

interface DocxParts {
  readonly document: string;
  readonly numbering: string;
  readonly relationships: string;
  readonly styles: string;
}

function paragraphContaining(xml: string, text: string): string {
  const paragraphs = xml.match(/<w:p>[\s\S]*?<\/w:p>/gu) ?? [];
  const paragraph = paragraphs.find((candidate) => candidate.includes(text));

  if (!paragraph) {
    throw new Error(`V DOCX chybí odstavec s textem ${text}.`);
  }

  return paragraph;
}

async function readDocx(buffer: Buffer): Promise<DocxParts> {
  const zip = await JSZip.loadAsync(buffer);
  const read = async (path: string): Promise<string> => {
    const file = zip.file(path);

    if (!file) {
      throw new Error(`V DOCX chybí ${path}.`);
    }

    return file.async("string");
  };

  return {
    document: await read("word/document.xml"),
    numbering: await read("word/numbering.xml"),
    relationships: await read("word/_rels/document.xml.rels"),
    styles: await read("word/styles.xml"),
  };
}

describe("DOCX export", () => {
  it("maps the supported Markdown AST with Czech text and formatting", async () => {
    const buffer = await renderNoteDocx("Můj deník", markdown);
    const parts = await readDocx(buffer);

    expect(buffer.subarray(0, 2).toString()).toBe("PK");
    expect(parts.document).toContain("Můj deník");
    expect(parts.document).toContain('w:pStyle w:val="Title"');
    expect(parts.document).toContain('w:pStyle w:val="Heading1"');
    expect(parts.document).toContain('w:pStyle w:val="Heading2"');
    expect(parts.document).toContain('w:pStyle w:val="Heading3"');
    expect(parts.document).toContain("Nadpis H1");
    expect(parts.document).toContain("Nadpis H2");
    expect(parts.document).toContain("Nadpis H3");

    expect(parts.document).toContain("<w:b/>");
    expect(parts.document).toContain("<w:i/>");
    expect(parts.document).toContain("tučným");
    expect(parts.document).toContain("kurzívou");
    expect(parts.document).toContain("kódem");
    expect(parts.document).toContain("Courier New");
    expect(parts.document).toContain("<w:br/>");
    expect(parts.document).toContain("Příliš žluťoučký kůň");

    expect(parts.relationships).toContain(
      "Target=\"https://example.com\" TargetMode=\"External\"",
    );
    expect(parts.relationships).not.toContain("javascript:");

    expect(parts.document).toContain('w:pStyle w:val="ListParagraph"');
    expect(parts.document).toContain('<w:ilvl w:val="1"/>');
    expect(parts.numbering).toContain('<w:numFmt w:val="bullet"/>');
    expect(parts.numbering).toContain('<w:numFmt w:val="decimal"/>');
    expect(parts.numbering).toContain('<w:start w:val="3"/>');

    expect(parts.document).toContain('<w14:checked w14:val="1"/>');
    expect(parts.document).toContain('<w14:checked w14:val="0"/>');
    expect(parts.document).toContain('<w:sym w:char="2612"');
    expect(parts.document).toContain('<w:sym w:char="2610"');
    expect(parts.document).toContain("hotový úkol");
    expect(parts.document).toContain("otevřený úkol");
    expect(parts.document).toContain("vnořený úkol");

    const taskParagraph = paragraphContaining(parts.document, "hotový úkol");
    const nestedTaskParagraph = paragraphContaining(
      parts.document,
      "vnořený úkol",
    );
    const bulletParagraph = paragraphContaining(parts.document, "první");

    expect(taskParagraph).toContain("<w14:checkbox>");
    expect(taskParagraph).not.toContain("<w:numPr>");
    expect(taskParagraph).not.toContain('w:pStyle w:val="ListParagraph"');
    expect(nestedTaskParagraph).toContain("<w14:checkbox>");
    expect(nestedTaskParagraph).not.toContain("<w:numPr>");
    expect(nestedTaskParagraph).toContain('<w:ind w:left="1440"/>');
    expect(bulletParagraph).toContain("<w:numPr>");

    expect(parts.document).toContain("Citace s ");
    expect(parts.document).toContain("důrazem");

    expect(parts.styles).toContain('<w:lang w:val="cs-CZ"/>');
    expect(parts.document).toContain('<w:lang w:val="cs-CZ"/>');
  });

  it("uses the note title as metadata and avoids duplicating an H1 title", async () => {
    const buffer = await renderNoteDocx(
      "Stejný nadpis",
      "# Stejný nadpis\n\nText poznámky.",
    );
    const parts = await readDocx(buffer);
    const zip = await JSZip.loadAsync(buffer);
    const core = await zip.file("docProps/core.xml")?.async("string");

    expect(parts.document).toContain("Stejný nadpis");
    expect(parts.document).toContain('w:pStyle w:val="Heading1"');
    expect(parts.document.match(/Stejný nadpis/gu)).toHaveLength(1);
    expect(core).toContain("Stejný nadpis");
  });

  it("rejects source-only Markdown with 422-compatible error details", async () => {
    for (const source of [
      "| A | B |\n| --- | --- |\n| 1 | 2 |",
      "<div>Nebezpečné HTML</div>",
      "[klikni](javascript:alert(1))",
      "##### Příliš hluboký nadpis",
    ]) {
      await expect(renderNoteDocx("Poznámka", source)).rejects.toMatchObject({
        name: "UnsupportedMarkdownError",
        target: "docx",
      });
    }

    try {
      await renderNoteDocx("Poznámka", "| A | B |\n| --- | --- |\n| 1 | 2 |");
      throw new Error("Export měl selhat.");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedMarkdownError);
      expect((error as UnsupportedMarkdownError).reasons).toContainEqual({
        nodeType: "table",
        type: "unsupported_node",
      });
    }
  });

  it("rejects list nesting deeper than the nine DOCX levels", async () => {
    const list = (levels: number) =>
      Array.from(
        { length: levels },
        (_, index) => `${"  ".repeat(index)}- úroveň ${index + 1}`,
      ).join("\n");

    await expect(renderNoteDocx("Poznámka", list(9))).resolves.toBeInstanceOf(
      Buffer,
    );
    await expect(renderNoteDocx("Poznámka", list(10))).rejects.toMatchObject({
      name: "DocxListDepthError",
    });
  });

  it("bounds the packed output size", async () => {
    await expect(
      renderNoteDocx("Poznámka", "Text", { maxBytes: 1 }),
    ).rejects.toBeInstanceOf(DocxExportTooLargeError);
    expect(DOCX_EXPORT_MAX_BYTES).toBe(8 * 1024 * 1024);
  });
});
