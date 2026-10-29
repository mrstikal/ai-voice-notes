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

async function createSearchNote(page: Page, title: string): Promise<string> {
  await page.goto("/notes");
  await page.getByLabel("Název").fill(title);
  await page.getByLabel("Obsah").fill(
    "Plán migrace databáze a testování. Tento text je určený pro sémantické hledání.",
  );
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

test("semantic search bills only an explicitly confirmed POST, shows the bounded result and opens the exact note", async ({
  page,
  request,
}) => {
  const title = `Sémantická poznámka E2E ${Date.now()}`;
  const noteId = await createSearchNote(page, title);
  const posts: unknown[] = [];
  const providerRequests: string[] = [];

  page.on("request", (browserRequest) => {
    if (/openrouter|elevenlabs/i.test(browserRequest.url())) {
      providerRequests.push(browserRequest.url());
    }
  });

  await page.route("**/api/search", async (route) => {
    const url = new URL(route.request().url());

    if (
      url.pathname !== "/api/search" ||
      route.request().method() !== "POST"
    ) {
      await route.continue();
      return;
    }

    posts.push(JSON.parse(route.request().postData() ?? "{}"));

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        query: "migrace",
        page: 1,
        pageSize: 10,
        total: 1,
        hasNext: false,
        model: "openai/text-embedding-3-small",
        estimatedMaxCostUsd: 0.000001,
        items: [
          {
            id: noteId,
            title,
            category: null,
            tags: ["e2e"],
            excerpt:
              "Plán migrace databáze a testování. Tento text je určený pro sémantické hledání.",
            updatedAt: new Date().toISOString(),
          },
        ],
        index: {
          readyNotes: 1,
          readyChunks: 1,
          pendingNotes: 1,
          errorNotes: 0,
          noContentNotes: 0,
        },
      }),
    });
  });

  await page.goto("/search?mode=semantic&q=migrace");
  await expect(page.getByTestId("semantic-search")).toBeVisible();

  const submit = page.getByTestId("semantic-submit");

  expect(posts).toHaveLength(0);
  await expect(submit).toBeDisabled();

  await page.getByTestId("semantic-query").fill("jiný dotaz");
  expect(posts).toHaveLength(0);
  await page.getByTestId("semantic-query").fill("migrace");
  expect(posts).toHaveLength(0);

  await page.getByTestId("semantic-confirm").check();
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(page.getByTestId("semantic-results")).toBeVisible();
  await expect(page.getByTestId(`semantic-result-${noteId}`)).toBeVisible();
  await expect(page.getByTestId("semantic-index-notice")).toBeVisible();
  await expect(page.getByTestId(`semantic-result-${noteId}`)).toContainText(
    "Plán migrace",
  );

  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    mode: "semantic",
    q: "migrace",
    page: 1,
    confirmCost: true,
  });
  expect(
    Number((posts[0] as { approvedMaxCostUsd?: number }).approvedMaxCostUsd),
  ).toBeGreaterThan(0);

  await page
    .getByTestId(`semantic-result-${noteId}`)
    .getByRole("link", { name: title, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/notes/${noteId}$`));
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  const getResponse = await request.get("/api/search?mode=semantic&q=migrace");

  expect(getResponse.status()).toBe(400);
  expect(await getResponse.json()).toMatchObject({
    error: { code: "semantic_requires_post" },
  });
  expect(providerRequests).toEqual([]);
});

test("a semantic search with no ready vectors shows a distinct error instead of a fake success", async ({
  page,
}) => {
  await page.route("**/api/search", async (route) => {
    const url = new URL(route.request().url());

    if (
      url.pathname !== "/api/search" ||
      route.request().method() !== "POST"
    ) {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "semantic_index_empty",
          message:
            "Sémantický index zatím nemá žádné připravené vektory. Spusťte Reindexovat v panelu Indexace; fulltextové hledání funguje dál.",
        },
      }),
    });
  });

  await page.goto("/search?mode=semantic&q=neexistujici");
  await page.getByTestId("semantic-confirm").check();
  await page.getByTestId("semantic-submit").click();

  await expect(page.getByTestId("semantic-error")).toContainText(
    "Sémantický index zatím nemá žádné připravené vektory",
  );
  await expect(page.getByTestId("semantic-results")).toHaveCount(0);
});

test("hybrid mode requires confirmation, shows component ranks and distinguishes the free text mode", async ({
  page,
}) => {
  const title = `Hybridní poznámka E2E ${Date.now()}`;
  const noteId = await createSearchNote(page, title);
  const secondId = "22222222-2222-4222-8222-222222222222";
  const thirdId = "33333333-3333-4333-8333-333333333333";
  const posts: unknown[] = [];
  const providerRequests: string[] = [];

  page.on("request", (browserRequest) => {
    if (/openrouter|elevenlabs/i.test(browserRequest.url())) {
      providerRequests.push(browserRequest.url());
    }
  });

  await page.route("**/api/search", async (route) => {
    const url = new URL(route.request().url());

    if (
      url.pathname !== "/api/search" ||
      route.request().method() !== "POST"
    ) {
      await route.continue();
      return;
    }

    posts.push(JSON.parse(route.request().postData() ?? "{}"));

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mode: "hybrid",
        query: "migrace",
        page: 1,
        pageSize: 20,
        total: 3,
        hasNext: false,
        model: "openai/text-embedding-3-small",
        estimatedMaxCostUsd: 0.000001,
        components: { textCandidates: 2, semanticCandidates: 2 },
        items: [
          {
            id: noteId,
            title,
            category: null,
            tags: [],
            excerpt: "Nejlepší kombinovaný výsledek.",
            updatedAt: new Date().toISOString(),
            score: 0.032,
            textRank: 1,
            semanticRank: 1,
          },
          {
            id: secondId,
            title: "Pouze textová poznámka",
            category: null,
            tags: [],
            excerpt: "Textový kandidát.",
            updatedAt: new Date().toISOString(),
            score: 0.016,
            textRank: 2,
            semanticRank: null,
          },
          {
            id: thirdId,
            title: "Pouze významová poznámka",
            category: null,
            tags: [],
            excerpt: "Významový kandidát.",
            updatedAt: new Date().toISOString(),
            score: 0.016,
            textRank: null,
            semanticRank: 2,
          },
        ],
        index: {
          readyNotes: 3,
          readyChunks: 3,
          pendingNotes: 0,
          errorNotes: 0,
          noContentNotes: 0,
        },
      }),
    });
  });

  await page.goto("/search");
  await expect(page.getByTestId("search-empty")).toBeVisible();
  await expect(page.getByTestId("semantic-confirm")).toHaveCount(0);
  await expect(page.getByTestId("hybrid-confirm")).toHaveCount(0);

  await page.goto("/search?mode=hybrid&q=migrace");
  await expect(page.getByTestId("hybrid-search")).toBeVisible();
  await expect(
    page
      .getByTestId("hybrid-search")
      .getByText(/Textová část je zdarma/),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("hybrid-search")
      .getByText(/placené je jedno embedding volání/),
  ).toBeVisible();

  const submit = page.getByTestId("hybrid-submit");

  expect(posts).toHaveLength(0);
  await expect(submit).toBeDisabled();

  await page.getByTestId("hybrid-confirm").check();
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(page.getByTestId("hybrid-results")).toBeVisible();
  await expect(page.getByTestId(`hybrid-result-${noteId}`)).toBeVisible();
  await expect(page.getByTestId(`hybrid-ranks-${noteId}`)).toContainText(
    "Textově #1",
  );
  await expect(page.getByTestId(`hybrid-ranks-${noteId}`)).toContainText(
    "Významově #1",
  );
  await expect(page.getByTestId(`hybrid-ranks-${secondId}`)).toContainText(
    "pouze textově",
  );
  await expect(page.getByTestId(`hybrid-ranks-${thirdId}`)).toContainText(
    "pouze významově",
  );

  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    mode: "hybrid",
    q: "migrace",
    page: 1,
    confirmCost: true,
  });

  await page
    .getByTestId(`hybrid-result-${noteId}`)
    .getByRole("link", { name: title, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/notes/${noteId}$`));
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  expect(providerRequests).toEqual([]);
});
