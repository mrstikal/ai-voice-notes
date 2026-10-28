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

async function createNote(
  page: Page,
  title: string,
  contentMd: string,
): Promise<string> {
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
): Promise<{ contentMd: string; version: number }> {
  const response = await request.get(`/api/notes/${noteId}`);
  expect(response.ok()).toBe(true);

  return (await response.json()) as { contentMd: string; version: number };
}

async function revisionCount(noteId: string): Promise<number> {
  return withTestPool(async (pool) => {
    const result = await pool.query<{ count: number }>(
      "select count(*)::int as count from note_revisions where note_id = $1",
      [noteId],
    );

    return result.rows[0]?.count ?? 0;
  });
}

async function mockTaskSuggestions(
  page: Page,
  tasks: Array<{ text: string; duplicate: boolean }>,
  noteVersion = 1,
): Promise<void> {
  await page.route("**/api/notes/*/ai-suggest", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      kind?: string;
    };

    if (body.kind !== "task_suggestions") {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        kind: "task_suggestions",
        noteId: createdNoteId,
        noteVersion,
        sourceGraphemes: 50,
        tasks,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
    });
  });
}

const content = [
  "Musíme koupit mléko a zavolat lékaři.",
  "",
  "- [ ] Koupit mléko",
].join("\n");

test("task suggestions show duplicates, stay inert until approval and append one parseable checklist", async ({
  page,
  request,
}) => {
  const title = `Úkoly AI E2E ${Date.now()}`;
  const noteId = await createNote(page, title, content);
  await mockTaskSuggestions(page, [
    { duplicate: true, text: "Koupit mléko" },
    { duplicate: false, text: "Zavolat lékaře" },
  ]);

  await page.getByTestId("task-select-all").click();
  await expect(page.getByText(/Vybraná pasáž:/)).toBeVisible();
  await page.getByTestId("task-suggest").click();
  await expect(page.getByTestId("task-suggestion")).toBeVisible();
  await expect(page.getByText("Už existuje")).toBeVisible();

  expect((await currentNote(request, noteId)).contentMd).toBe(content);
  expect(await revisionCount(noteId)).toBe(1);

  await page.getByTestId("task-suggestion-apply").click();
  await expect(page.getByTestId("proposal-preview")).toBeVisible();
  expect((await currentNote(request, noteId)).contentMd).toBe(content);

  await page.getByRole("button", { name: "Potvrdit" }).click();

  await expect
    .poll(async () => (await currentNote(request, noteId)).version, {
      timeout: 15_000,
    })
    .toBe(2);
  const updated = await currentNote(request, noteId);
  expect(updated.contentMd).toContain("- [ ] Zavolat lékaře");
  expect(updated.contentMd).toContain("- [ ] Koupit mléko");
  expect(await revisionCount(noteId)).toBe(2);

  const exported = await request.get(`/api/notes/${noteId}/export?format=md`);
  expect(exported.ok()).toBe(true);
  expect(await exported.text()).toBe(updated.contentMd);

  await mockTaskSuggestions(
    page,
    [{ duplicate: true, text: "Zavolat lékaře" }],
    2,
  );
  await page.getByTestId("task-select-all").click();
  await page.getByTestId("task-suggest").click();
  await expect(page.getByTestId("task-suggestion")).toBeVisible();
  const duplicateCheckbox = page
    .getByTestId("task-suggestion")
    .locator('input[type="checkbox"]')
    .first();
  await duplicateCheckbox.check();
  await page.getByTestId("task-suggestion-apply").click();

  await expect(page.getByTestId("task-suggestion-error")).toContainText(
    "už v poznámce",
  );
  expect((await currentNote(request, noteId)).version).toBe(2);
  expect(await revisionCount(noteId)).toBe(2);
});

test("stale task suggestion is refused after the note version moves", async ({
  page,
  request,
}) => {
  const title = `Úkoly stale E2E ${Date.now()}`;
  const noteId = await createNote(page, title, content);
  await mockTaskSuggestions(page, [{ duplicate: false, text: "Napsat testy" }]);

  await page.getByTestId("task-select-all").click();
  await page.getByTestId("task-suggest").click();
  await expect(page.getByTestId("task-suggestion")).toBeVisible();

  await page.getByLabel("Obsah (Markdown)").fill(`${content}\n\nPozději.`);
  await expect
    .poll(async () => (await currentNote(request, noteId)).version, {
      timeout: 15_000,
    })
    .toBe(2);

  await page.getByTestId("task-suggestion-apply").click();
  await expect(page.getByTestId("task-suggestion-error")).toContainText(
    "změnila",
  );
  expect(await revisionCount(noteId)).toBe(1);
});
