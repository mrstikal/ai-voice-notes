import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";

import {
  assertTestDatabaseTargets,
  loadTestEnvironment,
} from "../scripts/test-db-guard";
import { createNoteViaApi } from "./helpers/create-note";
import { openNoteTab } from "./helpers/tabs";

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

async function createNote(page: Page, title: string): Promise<void> {
  createdNoteId = await createNoteViaApi(page, title, "První verze.");
}

async function revisionCount(
  request: Page["request"],
  noteId: string,
): Promise<number> {
  const response = await request.get(`/api/notes/${noteId}/revisions`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { revisions: unknown[] };
  return body.revisions.length;
}

async function saveSource(
  page: Page,
  request: Page["request"],
  noteId: string,
  markdown: string,
  expectedRevisionCount: number,
): Promise<void> {
  const source = page.getByLabel("Obsah (Markdown)");
  await source.fill(markdown);
  await page.getByRole("button", { name: "Uložit", exact: true }).click();
  await expect
    .poll(() => revisionCount(request, noteId), { timeout: 15_000 })
    .toBe(expectedRevisionCount);
}

test("history shows named revisions, exact Undo and explicit older restore", async ({
  page,
  request,
}) => {
  const title = `Historie E2E ${Date.now()}`;
  await createNote(page, title);

  await saveSource(page, request, createdNoteId!, "Druhá verze.", 2);
  await saveSource(page, request, createdNoteId!, "Třetí verze.", 3);

  await openNoteTab(page, "Historie");
  const history = page.getByTestId("revision-history");
  await expect(history).toBeVisible();
  await expect(history.getByText("Počáteční verze")).toBeVisible();
  await expect(history.getByText("Ruční úprava")).toHaveCount(2);
  await expect(history.locator("time").first()).toBeVisible();

  await history
    .getByRole("button", { name: "Vrátit poslední změnu" })
    .click();

  const source = page.getByLabel("Obsah (Markdown)");
  await expect(source).toHaveValue("Druhá verze.");
  await expect(history.getByText("Vrácení změny")).toBeVisible();

  await page
    .getByTestId("revision-1")
    .getByRole("button", { name: "Obnovit tuto verzi" })
    .click();
  await expect(page.getByTestId("revision-restore-preview")).toBeVisible();
  await page.getByRole("button", { name: "Potvrdit obnovení" }).click();

  await expect(source).toHaveValue("První verze.");
  await expect(history.getByText("Obnovení verze")).toBeVisible();

  await page.reload();
  await openNoteTab(page, "Historie");
  await expect(page.getByTestId("revision-history")).toBeVisible();
  await expect(
    page.getByTestId("revision-history").getByText("Obnovení verze"),
  ).toBeVisible();
  await expect(page.getByLabel("Obsah (Markdown)")).toHaveValue(
    "První verze.",
  );
});
