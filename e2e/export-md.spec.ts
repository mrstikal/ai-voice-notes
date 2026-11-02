import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";
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

const markdown = [
  "# Export české poznámky",
  "",
  "Odstavec s **tučným** textem, 😀 a [nebezpečným odkazem](javascript:alert(1)).",
  "",
  "| A | B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "- [ ] otevřený úkol",
  "- [x] hotový úkol",
].join("\n");

test("exports the exact saved Markdown bytes and Czech filename", async ({
  page,
  request,
}) => {
  const title = `Export E2E ${Date.now()} – poznámka`;

  const noteId = await createNoteViaApi(page, title, "");
  createdNoteId = noteId;

  await page.getByLabel("Obsah (Markdown)").fill(markdown);
  await page.getByRole("button", { name: "Uložit", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(/Uloženo · verze \d+/);

  const savedResponse = await request.get(`/api/notes/${noteId}`);
  expect(savedResponse.ok()).toBe(true);
  const saved = (await savedResponse.json()) as { contentMd: string };
  expect(saved.contentMd).toBe(markdown);

  await page.getByText("Export", { exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Markdown (.md)" }).click(),
  ]);

  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toMatch(/\.md$/);

  const path = await download.path();
  if (!path) {
    throw new Error("Stažený soubor nemá dostupnou cestu.");
  }

  const downloaded = await readFile(path);
  expect(downloaded.equals(Buffer.from(saved.contentMd, "utf8"))).toBe(true);
});
