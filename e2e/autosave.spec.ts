import { expect, test, type Page } from "@playwright/test";
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

async function countRevisions(noteId: string): Promise<number> {
  const pool = new Pool({ connectionString: testDatabaseUrl() });

  try {
    const result = await pool.query<{ count: number }>(
      "select count(*)::int as count from note_revisions where note_id = $1",
      [noteId],
    );

    return result.rows[0]?.count ?? 0;
  } finally {
    await pool.end();
  }
}

async function createNote(
  page: Page,
  title: string,
  content: string,
): Promise<string> {
  const noteId = await createNoteViaApi(page, title, content);

  createdNoteId = noteId;
  return noteId;
}

test("deboncované ukládání konceptu, historie bez řádku na každý znak a obnovení po znovu načtení", async ({
  page,
  request,
}) => {
  const title = `Autosave E2E ${Date.now()}`;
  const noteId = await createNote(page, title, "Výchozí text");
  await expect(page.getByTestId("note-editor")).toHaveAttribute(
    "data-autosave-ready",
    "true",
  );

  const source = page.getByLabel("Obsah (Markdown)");
  await source.fill("");
  await source.click();
  await source.pressSequentially("Rozběhnutá poznámka", { delay: 10 });

  await expect(page.getByRole("status")).toContainText(/Uloženo · verze \d+/, {
    timeout: 15_000,
  });

  const saved = (await (await request.get(`/api/notes/${noteId}`)).json()) as {
    contentMd: string;
    version: number;
  };

  expect(saved.version).toBeGreaterThanOrEqual(2);
  expect(saved.contentMd).toBe("Rozběhnutá poznámka");
  expect(await countRevisions(noteId)).toBe(1);

  const versionBeforeExplicitSave = saved.version;
  await page.getByRole("button", { name: "Uložit", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    new RegExp(`Uloženo · verze ${versionBeforeExplicitSave + 1}`),
    { timeout: 15_000 },
  );
  expect(await countRevisions(noteId)).toBe(2);

  await page.reload();
  await expect(page.getByLabel("Obsah (Markdown)")).toHaveValue(
    "Rozběhnutá poznámka",
  );
});

test("zastaralá karta dostane konflikt, její text zůstane k dispozici a server se nepřepíše", async ({
  page,
  context,
  request,
}) => {
  const title = `Konflikt E2E ${Date.now()}`;
  const noteId = await createNote(page, title, "Sdílený text");
  await expect(page.getByTestId("note-editor")).toHaveAttribute(
    "data-autosave-ready",
    "true",
  );

  const second = await context.newPage();
  await second.goto(`/notes/${noteId}`);
  await expect(second.getByTestId("note-editor")).toHaveAttribute(
    "data-autosave-ready",
    "true",
  );
  await expect(second.getByLabel("Obsah (Markdown)")).toHaveValue("Sdílený text");

  await page.getByLabel("Obsah (Markdown)").fill("Text první karty");
  await expect(page.getByRole("status")).toContainText(/Uloženo · verze 2/, {
    timeout: 15_000,
  });

  await second.getByLabel("Obsah (Markdown)").fill("Text druhé karty");

  await expect(
    second.getByRole("region", { name: "Konflikt uložení" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(second.locator('p[role="alert"]')).toContainText(
    "Aktuální verze: 2",
  );
  await expect(second.getByLabel("Obsah (Markdown)")).toHaveValue(
    "Text druhé karty",
  );
  await expect(second.getByLabel("Můj text (verze 1)")).toHaveValue(
    "Text druhé karty",
  );
  await expect(second.getByLabel("Text na serveru (verze 2)")).toHaveValue(
    "Text první karty",
  );

  const saved = (await (await request.get(`/api/notes/${noteId}`)).json()) as {
    contentMd: string;
    version: number;
  };

  expect(saved.contentMd).toBe("Text první karty");
  expect(saved.version).toBe(2);
  expect(await countRevisions(noteId)).toBe(1);
});

test("neuložený koncept se po selhání uložení nabídne po znovu načtení", async ({
  page,
}) => {
  const title = `Obnova E2E ${Date.now()}`;
  await createNote(page, title, "Výchozí text");
  await expect(page.getByTestId("note-editor")).toHaveAttribute(
    "data-autosave-ready",
    "true",
  );

  page.on("dialog", (dialog) => {
    void dialog.accept();
  });

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.route("**/api/notes/*", async (route) => {
    if (route.request().method() === "PATCH") {
      await route.abort("failed");
      return;
    }

    await route.continue();
  });

  const source = page.getByLabel("Obsah (Markdown)");
  await source.fill("");
  await source.click();
  await source.pressSequentially("Rozpracovaný text", { delay: 10 });

  await expect(page.locator('p[role="alert"]')).toContainText(
    "Ukládání konceptu se nezdařilo",
    { timeout: 15_000 },
  );

  await page.reload();

  await expect(
    page.getByRole("region", { name: "Nalezen neuložený koncept" }),
  ).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Obnovit koncept" }).click();
  await expect(page.getByLabel("Obsah (Markdown)")).toHaveValue(
    "Rozpracovaný text",
  );

  expect(
    consoleErrors.filter((message) => /hydrat/i.test(message)),
  ).toHaveLength(0);
});
