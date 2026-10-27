import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";

import {
  assertTestDatabaseTargets,
  loadTestEnvironment,
} from "../scripts/test-db-guard";

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
  await page.goto("/notes");
  await page.getByLabel("Název").fill(title);
  await page.getByLabel("Obsah").fill("První verze.");
  await page.getByRole("button", { name: "Vytvořit poznámku" }).click();
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]+$/);
  createdNoteId = page.url().split("/").pop();
}

async function saveSource(page: Page, markdown: string): Promise<void> {
  const source = page.getByLabel("Obsah (Markdown)");
  await source.fill(markdown);
  await page.getByRole("button", { name: "Uložit", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Uloženo");
}

test("history shows named revisions, exact Undo and explicit older restore", async ({
  page,
}) => {
  const title = `Historie E2E ${Date.now()}`;
  await createNote(page, title);

  await saveSource(page, "Druhá verze.");
  await saveSource(page, "Třetí verze.");

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
  await expect(page.getByText(/Verze 5/)).toBeVisible();
  await expect(history.getByText("Obnovení verze")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("revision-history")).toBeVisible();
  await expect(
    page.getByTestId("revision-history").getByText("Obnovení verze"),
  ).toBeVisible();
  await expect(page.getByLabel("Obsah (Markdown)")).toHaveValue(
    "První verze.",
  );
});
