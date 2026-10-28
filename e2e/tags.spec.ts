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

async function mockTagSuggestions(
  page: Page,
  state: {
    version: number;
    tags: string[];
    category: string | null;
    expiresAt?: string;
  },
) {
  await page.route("**/api/notes/*/ai-suggest", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        kind: "tag_suggestions",
        noteId: createdNoteId,
        noteVersion: state.version,
        tags: state.tags,
        category: state.category,
        expiresAt:
          state.expiresAt ?? new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
    });
  });
}

test("AI suggestion applies only the selected subset and keeps category unless explicitly chosen", async ({
  page,
  request,
}) => {
  const title = `AI tagy E2E ${Date.now()}`;
  const noteId = await createNote(page, title, "Projekt Atlas a migrace databáze.");

  await page.getByTestId("tag-category").selectOption("Osobní");
  await addTag(page, "manual");
  await page.getByTestId("tag-save").click();
  await expect
    .poll(async () => (await currentNote(request, noteId)).version, {
      timeout: 15_000,
    })
    .toBe(2);

  const suggestion = {
    version: 2,
    tags: ["atlas", "migrace"],
    category: "Práce",
  };
  await mockTagSuggestions(page, suggestion);

  await page.getByTestId("tag-ai-suggest").click();
  await expect(page.getByTestId("tag-ai-suggestion")).toBeVisible();
  await page.getByTestId("tag-ai-suggested-migrace").uncheck();
  await page.getByTestId("tag-ai-apply").click();

  await expect
    .poll(async () => (await currentNote(request, noteId)).version, {
      timeout: 15_000,
    })
    .toBe(3);
  const first = await currentNote(request, noteId);
  expect(first.category).toBe("Osobní");
  expect(first.tags).toEqual(["atlas", "manual"]);
  expect(
    (await revisionRows(noteId)).filter((row) => row.reason === "metadata"),
  ).toHaveLength(2);

  suggestion.version = 3;
  suggestion.tags = ["tým"];
  await page.getByTestId("tag-ai-suggest").click();
  await expect(page.getByTestId("tag-ai-suggestion")).toBeVisible();
  await page.getByTestId("tag-ai-apply-category").check();
  await page.getByTestId("tag-ai-apply").click();

  await expect
    .poll(async () => (await currentNote(request, noteId)).version, {
      timeout: 15_000,
    })
    .toBe(4);
  const second = await currentNote(request, noteId);
  expect(second.category).toBe("Práce");
  expect(second.tags).toEqual(["atlas", "manual", "tým"]);
  expect(
    (await revisionRows(noteId)).filter((row) => row.reason === "metadata"),
  ).toHaveLength(3);
});

test("expired and failed AI suggestions never change the note", async ({
  page,
  request,
}) => {
  const title = `AI tagy selhani E2E ${Date.now()}`;
  const noteId = await createNote(page, title, "Text pro AI metadata.");

  await mockTagSuggestions(page, {
    version: 1,
    tags: ["atlas"],
    category: "Práce",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });

  await page.getByTestId("tag-ai-suggest").click();
  await expect(page.getByTestId("tag-ai-suggestion")).toBeVisible();
  await page.getByTestId("tag-ai-apply").click();
  await expect(page.getByTestId("tag-ai-error")).toContainText("vypršel");
  await page.getByTestId("tag-ai-reject").click();

  await page.route("**/api/notes/*/ai-suggest", async (route) => {
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        error: { message: "Poskytovatel AI selhal." },
      }),
    });
  });
  await page.getByTestId("tag-ai-suggest").click();
  await expect(page.getByTestId("tag-ai-error")).toContainText(
    "Poskytovatel AI selhal.",
  );

  const current = await currentNote(request, noteId);
  expect(current.version).toBe(1);
  expect(current.tags).toEqual([]);
  expect(current.category).toBeNull();
  expect((await revisionRows(noteId)).length).toBe(1);
});

test("AI apply refuses pending manual edits, edits suggested text and reports a no-op without stale status", async ({
  page,
  request,
}) => {
  const title = `AI tagy hrany E2E ${Date.now()}`;
  const noteId = await createNote(page, title, "Projekt Atlas.");

  await page.getByTestId("tag-category").selectOption("Osobní");
  await addTag(page, "manual");
  await page.getByTestId("tag-save").click();
  await expect
    .poll(async () => (await currentNote(request, noteId)).version, {
      timeout: 15_000,
    })
    .toBe(2);

  const suggestion = {
    version: 2,
    tags: ["atlas"],
    category: "Práce",
  };
  await mockTagSuggestions(page, suggestion);

  await page.getByTestId("tag-category").selectOption("Práce");
  await page.getByTestId("tag-ai-suggest").click();
  await expect(page.getByTestId("tag-ai-suggestion")).toBeVisible();
  await page.getByTestId("tag-ai-apply").click();
  await expect(page.getByTestId("tag-ai-error")).toContainText(
    "Nejprve uložte ruční změny",
  );
  await expect(page.getByTestId("tag-ai-error")).toContainText(
    "další placené volání",
  );
  expect((await currentNote(request, noteId)).version).toBe(2);
  expect((await currentNote(request, noteId)).category).toBe("Osobní");

  await page.getByTestId("tag-category").selectOption("Osobní");
  await page
    .getByLabel("Upravit navržený tag atlas")
    .fill("atlas-edit");
  await page.getByTestId("tag-ai-apply").click();
  await expect
    .poll(async () => (await currentNote(request, noteId)).version, {
      timeout: 15_000,
    })
    .toBe(3);
  expect((await currentNote(request, noteId)).tags).toEqual([
    "atlas-edit",
    "manual",
  ]);
  expect((await currentNote(request, noteId)).category).toBe("Osobní");

  suggestion.version = 3;
  suggestion.tags = ["atlas-edit"];
  await page.getByTestId("tag-ai-suggest").click();
  await expect(page.getByTestId("tag-ai-suggestion")).toBeVisible();
  await page.getByTestId("tag-ai-apply").click();

  await expect(page.getByTestId("metadata-applied")).toContainText(
    "nová revize nevznikla",
  );
  expect((await currentNote(request, noteId)).version).toBe(3);
  expect((await currentNote(request, noteId)).category).toBe("Osobní");
  await expect(page.getByText("AI návrh je připravený")).toHaveCount(0);
});
