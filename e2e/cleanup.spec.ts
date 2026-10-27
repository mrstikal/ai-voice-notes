import { createHash } from "node:crypto";

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

async function proposalCount(noteId: string): Promise<number> {
  return withTestPool(async (pool) => {
    const result = await pool.query<{ count: number }>(
      "select count(*)::int as count from edit_proposals where note_id = $1",
      [noteId],
    );

    return result.rows[0]?.count ?? 0;
  });
}

function sourceHash(contentMd: string): string {
  return createHash("sha256").update(contentMd, "utf8").digest("hex");
}

const originalParagraph =
  "Já jsem já jsem se včera ehm sešel s Janem Novákem a měl jsem 3 schůzky.";
const secondParagraph = "Druhý odstavec zůstává beze změny.";
const cleanedParagraph =
  "Včera jsem se sešel s Janem Novákem a měl jsem 3 schůzky.";
const original = `${originalParagraph}\n\n${secondParagraph}`;
const cleaned = `${cleanedParagraph}\n\n${secondParagraph}`;

async function mockCleanupSuggestion(page: Page): Promise<void> {
  await page.route("**/api/notes/*/ai-suggest", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      blockIndex?: number;
    };

    expect(body.blockIndex).toBe(0);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidateId: "p0",
        cleanedText: cleanedParagraph,
        kind: "cleanup",
        noteVersion: 1,
        operation: {
          type: "replace_paragraph",
          target: {
            startPhrase: originalParagraph,
            endPhrase: originalParagraph,
          },
          text: cleanedParagraph,
        },
        originalText: originalParagraph,
        sourceHash: sourceHash(original),
      }),
    });
  });
}

test("cleanup rejection, approval, original transcript and Undo work end to end", async ({
  page,
  request,
}) => {
  const title = `Čištění E2E ${Date.now()}`;
  const noteId = await createNote(page, title, original);

  expect(await revisionCount(noteId)).toBe(1);
  await mockCleanupSuggestion(page);

  await page.getByTestId("cleanup-paragraph").selectOption("0");
  await page.getByTestId("cleanup-submit").click();
  await expect(page.getByTestId("proposal-preview")).toBeVisible();

  expect((await currentNote(request, noteId)).version).toBe(1);
  expect(await revisionCount(noteId)).toBe(1);
  expect(await proposalCount(noteId)).toBe(1);

  await page.getByRole("button", { name: "Zamítnout návrh" }).click();
  await expect(page.getByText(/Návrh vyčištění byl zamítnut/)).toBeVisible();
  expect((await currentNote(request, noteId)).contentMd).toBe(original);
  expect(await revisionCount(noteId)).toBe(1);

  await page.getByTestId("cleanup-submit").click();
  await expect(page.getByTestId("proposal-preview")).toBeVisible();
  await page.getByRole("button", { name: "Potvrdit" }).click();

  await expect
    .poll(async () => (await currentNote(request, noteId)).version, {
      timeout: 15_000,
    })
    .toBe(2);
  expect((await currentNote(request, noteId)).contentMd).toBe(cleaned);
  expect(await revisionCount(noteId)).toBe(2);
  await expect(page.getByTestId("cleanup-applied")).toHaveText(
    "Vyčištění odstavce bylo uloženo.",
  );

  await page.reload();
  const history = page.getByTestId("revision-history");
  await history.getByTestId("revision-before-toggle-2").click();
  const before = history.getByTestId("revision-before-2");
  await expect(before).toBeVisible();
  await expect(before).toContainText("Původní přepis před touto změnou");
  await expect(before).toContainText(originalParagraph);

  await history.getByRole("button", { name: "Vrátit poslední změnu" }).click();

  await expect
    .poll(async () => (await currentNote(request, noteId)).contentMd, {
      timeout: 15_000,
    })
    .toBe(original);
  expect(await revisionCount(noteId)).toBe(3);
});

test("cleanup provider failure creates no proposal, note change or revision", async ({
  page,
  request,
}) => {
  const title = `Čištění selhání E2E ${Date.now()}`;
  const noteId = await createNote(page, title, original);

  await page.route("**/api/notes/*/ai-suggest", async (route) => {
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "llm_provider_error",
          message: "Poskytovatel AI selhal.",
        },
      }),
    });
  });

  await page.getByTestId("cleanup-paragraph").selectOption("0");
  await page.getByTestId("cleanup-submit").click();

  await expect(
    page.getByText("Poskytovatel AI selhal.", { exact: true }),
  ).toBeVisible();
  expect((await currentNote(request, noteId)).contentMd).toBe(original);
  expect((await currentNote(request, noteId)).version).toBe(1);
  expect(await revisionCount(noteId)).toBe(1);
  expect(await proposalCount(noteId)).toBe(0);
});

test("the preserved original transcript is restorable after a later named revision", async ({
  page,
  request,
}) => {
  const title = `Čištění obnova E2E ${Date.now()}`;
  const noteId = await createNote(page, title, original);
  await mockCleanupSuggestion(page);

  await page.getByTestId("cleanup-paragraph").selectOption("0");
  await page.getByTestId("cleanup-submit").click();
  await expect(page.getByTestId("proposal-preview")).toBeVisible();
  await page.getByRole("button", { name: "Potvrdit" }).click();
  await expect
    .poll(async () => (await currentNote(request, noteId)).version, {
      timeout: 15_000,
    })
    .toBe(2);

  const laterContent = `${cleaned} Pozdější změna.`;
  await page.getByLabel("Obsah (Markdown)").fill(laterContent);
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect
    .poll(async () => (await currentNote(request, noteId)).version, {
      timeout: 15_000,
    })
    .toBe(3);
  expect(await revisionCount(noteId)).toBe(3);
  await expect(
    page.getByTestId("revision-history").getByText("Ruční úprava"),
  ).toBeVisible();

  await page.reload();
  const history = page.getByTestId("revision-history");
  await history.getByTestId("revision-before-toggle-2").click();
  await expect(history.getByTestId("revision-before-2")).toContainText(
    originalParagraph,
  );

  await history
    .getByRole("button", { name: "Obnovit původní přepis" })
    .click();
  await expect(page.getByTestId("revision-restore-preview")).toContainText(
    "Obnovit původní přepis před verzí 2",
  );
  await page.getByRole("button", { name: "Potvrdit obnovení" }).click();

  await expect
    .poll(async () => (await currentNote(request, noteId)).contentMd, {
      timeout: 15_000,
    })
    .toBe(original);
  expect((await currentNote(request, noteId)).version).toBeGreaterThanOrEqual(4);
  expect(await revisionCount(noteId)).toBe(4);
});
