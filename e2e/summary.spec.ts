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

const content = [
  "První odstavec obsahuje kontext k migraci a tři další kroky.",
  "",
  "Druhý odstavec popisuje testování a bezpečnostní kontrolu.",
].join("\n");
const summaryText = "Shrnutí: migrace má tři kroky a čeká ji testování.";

async function mockSummary(
  page: Page,
  noteVersion = 1,
): Promise<{ calls: number[] }> {
  const requests: number[] = [];

  await page.route("**/api/notes/*/ai-suggest", async (route) => {
    requests.push(1);
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      kind?: string;
    };
    expect(body.kind).toBe("summary");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        kind: "summary",
        noteId: createdNoteId,
        noteVersion,
        sourceGraphemes: 70,
        summaryText,
      }),
    });
  });

  return { calls: requests };
}

test("summary generation and reading create no note change; explicit insertion creates one revision", async ({
  page,
  request,
}) => {
  const title = `Shrnutí E2E ${Date.now()}`;
  const noteId = await createNote(page, title, content);
  const mock = await mockSummary(page);
  let ttsRequests = 0;

  page.on("request", (event) => {
    if (event.url().includes("/api/tts")) {
      ttsRequests += 1;
    }
  });

  await page.getByTestId("summary-generate").click();
  await expect(page.getByTestId("summary-artifact")).toContainText(summaryText);

  expect(mock.calls).toHaveLength(1);
  expect((await currentNote(request, noteId)).version).toBe(1);
  expect((await currentNote(request, noteId)).contentMd).toBe(content);
  expect(await revisionCount(noteId)).toBe(1);
  expect(await proposalCount(noteId)).toBe(0);

  await page.getByRole("button", { name: "Přečíst shrnutí" }).click();
  await expect(page.getByTestId("summary-playback")).toContainText(summaryText);
  expect(ttsRequests).toBe(0);
  expect((await currentNote(request, noteId)).version).toBe(1);
  expect(await revisionCount(noteId)).toBe(1);

  await page.getByRole("button", { name: "Vložit shrnutí" }).click();
  await expect(page.getByTestId("proposal-preview")).toBeVisible();
  expect((await currentNote(request, noteId)).version).toBe(1);
  expect(await revisionCount(noteId)).toBe(1);

  await page.getByRole("button", { name: "Potvrdit" }).click();

  await expect
    .poll(async () => (await currentNote(request, noteId)).version, {
      timeout: 15_000,
    })
    .toBe(2);
  const inserted = await currentNote(request, noteId);
  expect(inserted.contentMd).toContain(summaryText);
  expect(inserted.contentMd).toContain("První odstavec");
  expect(inserted.contentMd).toContain("Druhý odstavec");
  expect(await revisionCount(noteId)).toBe(2);
  expect(await proposalCount(noteId)).toBe(1);
  await expect(page.getByTestId("summary-artifact")).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("summary-artifact")).toHaveCount(0);
  expect((await currentNote(request, noteId)).contentMd).toBe(
    inserted.contentMd,
  );
});

test("an oversized full note asks for a passage before any provider request", async ({
  page,
  request,
}) => {
  const title = `Dlouhé shrnutí E2E ${Date.now()}`;
  const longContent = "a".repeat(8_001);
  const noteId = await createNote(page, title, longContent);
  let requests = 0;

  page.on("request", (event) => {
    if (event.url().includes("/ai-suggest")) {
      requests += 1;
    }
  });

  await expect(page.getByText(/Poznámka je delší než limit/)).toBeVisible();
  await expect(page.getByTestId("summary-generate")).toBeDisabled();
  expect(requests).toBe(0);
  expect((await currentNote(request, noteId)).version).toBe(1);
  expect(await revisionCount(noteId)).toBe(1);
});
