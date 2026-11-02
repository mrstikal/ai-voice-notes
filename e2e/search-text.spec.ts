import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";

import {
  assertTestDatabaseTargets,
  loadTestEnvironment,
} from "../scripts/test-db-guard";
import { createNoteViaApi } from "./helpers/create-note";

test.setTimeout(120_000);

let createdNoteId: string | undefined;
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

async function withTestPool<T>(operation: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: testDatabaseUrl() });

  try {
    return await operation(pool);
  } finally {
    await pool.end();
  }
}

test.afterEach(async () => {
  if (!createdNoteId) {
    return;
  }

  const noteId = createdNoteId;
  createdNoteId = undefined;

  await withTestPool(async (pool) => {
    await pool.query("delete from notes where id = $1", [noteId]);
  });
});

async function createSearchNote(page: Page, title: string): Promise<string> {
  const noteId = await createNoteViaApi(page, title, "Plán migrace databáze a testování. Tento text je určený pro fulltextové hledání.",);

  createdNoteId = noteId;
  return noteId;
}

test("fulltext search finds accent variants, a quoted phrase and opens the exact note without any provider", async ({
  page,
}) => {
  const title = `Hledaná poznámka E2E ${Date.now()}`;
  const noteId = await createSearchNote(page, title);
  const providerRequests: string[] = [];

  page.on("request", (request) => {
    if (/openrouter|elevenlabs/i.test(request.url())) {
      providerRequests.push(request.url());
    }
  });

  await page.goto("/search");
  await expect(page.getByTestId("search-empty")).toBeVisible();
  await expect(page.getByTestId("ask-notes")).toHaveCount(0);

  const searchInput = page.getByLabel("Hledaný výraz");
  const indexHeading = page.getByRole("heading", {
    name: "Indexace pro vyhledávání",
  });
  await expect(indexHeading).toBeVisible();
  const searchBox = await searchInput.boundingBox();
  const indexBox = await indexHeading.boundingBox();
  expect(searchBox).not.toBeNull();
  expect(indexBox).not.toBeNull();
  expect(searchBox!.y).toBeLessThan(indexBox!.y);

  await page.getByLabel("Hledaný výraz").fill("databaze");
  await page.getByRole("button", { name: "Hledat" }).click();
  await expect(page).toHaveURL(/\/search\?.*q=databaze/);
  await expect(page.getByTestId(`search-result-${noteId}`)).toBeVisible();
  await expect(
    page.getByTestId(`search-result-${noteId}`).locator("mark"),
  ).toContainText("databáze");
  await expect(page.getByTestId(`index-status-${noteId}`)).toContainText(
    "Čeká",
  );
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/notes/${noteId}$`));
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  await page.goto("/search?mode=fulltext&q=%22pl%C3%A1n%20migrace%22");
  await expect(page.getByTestId(`search-result-${noteId}`)).toBeVisible();

  await page.goto("/search?mode=fulltext&q=neexistujici-vyraz");
  await expect(page.getByTestId("search-no-results")).toBeVisible();

  expect(providerRequests).toEqual([]);
});
