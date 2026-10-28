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

async function createNote(page: Page, title: string, contentMd: string) {
  await page.goto("/notes");
  await page.getByLabel("Název").fill(title);
  await page.getByLabel("Obsah").fill(contentMd);
  await page.getByRole("button", { name: "Vytvořit poznámku" }).click();
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]+$/);

  const noteId = page.url().split("/").pop();

  if (!noteId) {
    throw new Error("ID poznámky se nepodařilo zjistit.");
  }

  createdNoteId = noteId;
  return noteId;
}

async function currentNote(
  request: Page["request"],
  noteId: string,
): Promise<{
  category: string | null;
  contentMd: string;
  tags: string[];
  version: number;
}> {
  const response = await request.get(`/api/notes/${noteId}`);
  expect(response.ok()).toBe(true);

  return (await response.json()) as {
    category: string | null;
    contentMd: string;
    tags: string[];
    version: number;
  };
}

async function revisionRows(
  noteId: string,
): Promise<Array<{ reason: string; note_version: number }>> {
  return withTestPool(async (pool) => {
    const result = await pool.query<{ reason: string; note_version: number }>(
      "select reason, note_version from note_revisions where note_id = $1 order by note_version",
      [noteId],
    );

    return result.rows;
  });
}

async function addTag(page: Page, tag: string) {
  await page.getByTestId("tag-input").fill(tag);
  await page.getByTestId("tag-add").click();
}

test("manual metadata normalizes tags, writes one metadata revision and survives reload", async ({
  page,
  request,
}) => {
  const title = `Tagy E2E ${Date.now()}`;
  const noteId = await createNote(page, title, "Text pro metadata.");

  await page.getByTestId("tag-category").selectOption("Práce");
  await addTag(page, "Práce");
  await addTag(page, "práce");
  await addTag(page, "#škola");

  await expect(page.getByTestId("tag-list")).toContainText("Práce");
  await expect(page.getByTestId("tag-list")).toContainText("škola");
  await expect(page.getByTestId("tag-list").locator("li")).toHaveCount(2);

  await page.getByTestId("tag-save").click();

  await expect
    .poll(async () => (await currentNote(request, noteId)).version, {
      timeout: 15_000,
    })
    .toBe(2);
  const updated = await currentNote(request, noteId);
  expect(updated.category).toBe("Práce");
  expect(updated.tags).toEqual(["Práce", "škola"]);
  expect(updated.contentMd).toBe("Text pro metadata.");

  const rows = await revisionRows(noteId);
  expect(rows.map((row) => row.reason)).toEqual(["initial", "metadata"]);
  await expect(
    page.getByTestId("revision-history").getByText("Změna metadat"),
  ).toBeVisible();
  await expect(page.getByTestId("metadata-applied")).toContainText(
    "jedna revize",
  );

  await page.reload();
  await expect(page.getByTestId("tag-category")).toHaveValue("Práce");
  await expect(page.getByTestId("tag-list")).toContainText("Práce");
  await expect(page.getByTestId("tag-list")).toContainText("škola");

  await expect(page.getByTestId("tag-save")).toBeDisabled();
  expect((await currentNote(request, noteId)).version).toBe(2);
  expect((await revisionRows(noteId)).length).toBe(2);
});

test("P25 restore returns the exact earlier category and tags", async ({
  page,
  request,
}) => {
  const title = `Obnova metadat E2E ${Date.now()}`;
  const noteId = await createNote(page, title, "Původní obsah.");

  await page.getByTestId("tag-category").selectOption("Osobní");
  await addTag(page, "práce");
  await addTag(page, "škola");
  await page.getByTestId("tag-save").click();
  await expect
    .poll(async () => (await currentNote(request, noteId)).version, {
      timeout: 15_000,
    })
    .toBe(2);

  await page.getByLabel("Obsah (Markdown)").fill("Novější obsah.");
  await page.getByRole("button", { name: "Uložit", exact: true }).click();
  await expect
    .poll(async () => (await currentNote(request, noteId)).version, {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(3);
  await expect
    .poll(async () => (await revisionRows(noteId)).length, { timeout: 15_000 })
    .toBe(3);

  await page.reload();
  const metadataRevision = page.getByTestId("revision-2");
  await metadataRevision
    .getByRole("button", { name: "Obnovit tuto verzi" })
    .click();
  await expect(page.getByTestId("revision-restore-preview")).toBeVisible();
  await page.getByRole("button", { name: "Potvrdit obnovení" }).click();

  await expect
    .poll(async () => (await currentNote(request, noteId)).contentMd, {
      timeout: 15_000,
    })
    .toBe("Původní obsah.");
  const restored = await currentNote(request, noteId);
  expect(restored.category).toBe("Osobní");
  expect(restored.tags).toEqual(["práce", "škola"]);
  expect(restored.version).toBeGreaterThanOrEqual(4);
  await expect(page.getByTestId("tag-category")).toHaveValue("Osobní");
  await expect(page.getByTestId("tag-list")).toContainText("práce");
});

test("stale metadata save returns a conflict and never overwrites a newer version", async ({
  browser,
  request,
}) => {
  const title = `Konflikt metadat E2E ${Date.now()}`;
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  try {
    const noteId = await createNote(pageA, title, "Stale test.");
    await pageB.goto(`/notes/${noteId}`);

    await pageB.getByTestId("tag-category").selectOption("Studium");
    await addTag(pageB, "novy");
    await pageB.getByTestId("tag-save").click();
    await expect
      .poll(async () => (await currentNote(request, noteId)).version, {
        timeout: 15_000,
      })
      .toBe(2);

    await pageA.getByTestId("tag-category").selectOption("Práce");
    await addTag(pageA, "stary");
    await pageA.getByTestId("tag-save").click();

    await expect(pageA.getByTestId("tag-error")).toContainText(
      "mezitím změněna",
    );
    const current = await currentNote(request, noteId);
    expect(current.version).toBe(2);
    expect(current.category).toBe("Studium");
    expect(current.tags).toEqual(["novy"]);
  } finally {
    await pageA.close();
    await pageB.close();
  }
});

test("pending tag edits survive an editor autosave version bump", async ({
  page,
  request,
}) => {
  const title = `Koncept tagů E2E ${Date.now()}`;
  const noteId = await createNote(page, title, "Počáteční obsah.");

  await addTag(page, "škola");
  await addTag(page, "zebra");
  await page.getByTestId("tag-save").click();
  await expect
    .poll(async () => (await currentNote(request, noteId)).version, {
      timeout: 15_000,
    })
    .toBe(2);
  expect((await currentNote(request, noteId)).tags).toEqual(["zebra", "škola"]);

  await addTag(page, "pending");
  await expect(page.getByTestId("tag-pending")).toBeVisible();
  await page.getByLabel("Obsah (Markdown)").fill("Počáteční obsah. Upraveno.");
  await expect
    .poll(async () => (await currentNote(request, noteId)).version, {
      timeout: 15_000,
    })
    .toBe(3);

  await expect(page.getByTestId("tag-pending")).toBeVisible();
  await expect(page.getByTestId("tag-save")).toBeEnabled();
  await page.getByTestId("tag-save").click();

  await expect
    .poll(async () => (await currentNote(request, noteId)).version, {
      timeout: 15_000,
    })
    .toBe(4);
  expect((await currentNote(request, noteId)).tags).toEqual([
    "pending",
    "zebra",
    "škola",
  ]);
});
