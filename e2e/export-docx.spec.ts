import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";
import JSZip from "jszip";
import { Pool } from "pg";

import {
  assertTestDatabaseTargets,
  loadTestEnvironment,
} from "../scripts/test-db-guard";
import { createNoteViaApi } from "./helpers/create-note";

test.setTimeout(120_000);

let createdNoteId: string | undefined;

test.afterEach(async () => {
  if (!createdNoteId) {
    return;
  }

  const noteId = createdNoteId;
  createdNoteId = undefined;

  const pool = new Pool({ connectionString: testDatabaseUrl() });

  try {
    await pool.query("delete from notes where id = $1", [noteId]);
  } finally {
    await pool.end();
  }
});

let cachedTestDatabaseUrl: string | undefined;

function testDatabaseUrl(): string {
  if (cachedTestDatabaseUrl) {
    return cachedTestDatabaseUrl;
  }

  const previousNodeEnv = process.env.NODE_ENV;
  const mutableEnv = process.env as Record<string, string | undefined>;

  try {
    loadTestEnvironment();
    cachedTestDatabaseUrl = assertTestDatabaseTargets().testUrl;
  } finally {
    if (previousNodeEnv === undefined) {
      delete mutableEnv.NODE_ENV;
    } else {
      mutableEnv.NODE_ENV = previousNodeEnv;
    }
  }

  return cachedTestDatabaseUrl;
}

function paragraphContaining(xml: string, text: string): string {
  const paragraphs = xml.match(/<w:p>[\s\S]*?<\/w:p>/gu) ?? [];
  const paragraph = paragraphs.find((candidate) => candidate.includes(text));

  if (!paragraph) {
    throw new Error(`V DOCX chybí odstavec s textem ${text}.`);
  }

  return paragraph;
}

const markdown = [
  "# Export DOCX",
  "",
  "## Formátování",
  "",
  "Odstavec s **tučným**, *kurzívou*, `kódem` a [odkazem](https://example.com).",
  "",
  "- [ ] otevřený úkol",
  "- [x] hotový úkol",
  "",
  "> Citace s **důrazem**.",
  "",
  "```ts",
  "const pozdrav = 'Příliš žluťoučký kůň';",
  "```",
].join("\n");

async function createNote(
  page: Page,
  title: string,
  content: string,
): Promise<string> {
  const noteId = await createNoteViaApi(page, title, "");

  createdNoteId = noteId;
  await page.getByLabel("Obsah (Markdown)").fill(content);
  await page.getByRole("button", { name: "Uložit", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(/Uloženo · verze \d+/);

  return noteId;
}

test("downloads a DOCX with Czech text, headings, marks, links and tasks", async ({
  page,
}) => {
  const title = `Export DOCX E2E ${Date.now()} – poznámka`;
  await createNote(page, title, markdown);

  await page.getByText("Export", { exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "DOCX (.docx)" }).click(),
  ]);

  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toMatch(/\.docx$/);

  const path = await download.path();
  if (!path) {
    throw new Error("Stažený DOCX nemá dostupnou cestu.");
  }

  const buffer = await readFile(path);
  const zip = await JSZip.loadAsync(buffer);
  const document = await zip.file("word/document.xml")?.async("string");
  const relationships = await zip
    .file("word/_rels/document.xml.rels")
    ?.async("string");
  const styles = await zip.file("word/styles.xml")?.async("string");

  expect(document).toContain("Export DOCX");
  expect(document).toContain('w:pStyle w:val="Heading1"');
  expect(document).toContain('w:pStyle w:val="Heading2"');
  expect(document).toContain("tučným");
  expect(document).toContain("kurzívou");
  expect(document).toContain("<w:b/>");
  expect(document).toContain("<w:i/>");
  expect(document).toContain("kódem");
  expect(document).toContain("Příliš žluťoučký kůň");
  expect(document).toContain('<w14:checked w14:val="1"/>');
  expect(document).toContain('<w14:checked w14:val="0"/>');
  expect(document).toContain('<w:sym w:char="2612"');
  expect(document).toContain("hotový úkol");
  expect(document).toContain("otevřený úkol");
  const taskParagraph = paragraphContaining(document ?? "", "hotový úkol");
  expect(taskParagraph).toContain("<w14:checkbox>");
  expect(taskParagraph).not.toContain("<w:numPr>");
  expect(document).toContain("Citace s ");
  expect(relationships).toContain(
    'Target="https://example.com" TargetMode="External"',
  );
  expect(styles).toContain('<w:lang w:val="cs-CZ"/>');
});

test("source-only note returns 422 for DOCX and still exports exact Markdown", async ({
  page,
  request,
}) => {
  const title = `Export DOCX unsupported ${Date.now()}`;
  const content = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  const noteId = await createNote(page, title, content);

  const docx = await request.get(`/api/notes/${noteId}/export?format=docx`);
  expect(docx.status()).toBe(422);
  expect(await docx.json()).toMatchObject({
    error: { code: "unsupported_markdown" },
  });

  const markdownResponse = await request.get(
    `/api/notes/${noteId}/export?format=md`,
  );
  expect(markdownResponse.status()).toBe(200);
  expect(
    Buffer.from(await markdownResponse.body()).equals(
      Buffer.from(content, "utf8"),
    ),
  ).toBe(true);
});
