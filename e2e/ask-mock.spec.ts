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

async function createAskNote(page: Page, title: string): Promise<string> {
  const noteId = await createNoteViaApi(page, title, "Plán migrace databáze PostgreSQL na sobotu. Zálohu je potřeba ověřit.",);

  createdNoteId = noteId;
  return noteId;
}

function askResponse(noteId: string, title: string) {
  return {
    status: "answered",
    answer: "Migrace PostgreSQL je v sobotu.",
    retrieval: "hybrid",
    claims: [
      {
        text: "Migrace PostgreSQL je v sobotu.",
        citations: [
          {
            noteId,
            chunkId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            noteTitle: title,
            noteVersion: 1,
          },
        ],
      },
    ],
    sources: [],
    cost: {
      approvedMaxCostUsd: 0.0205,
      queryEmbeddingUsd: 0.000001,
      llmUsd: 0.0002,
      totalEstimatedUsd: 0.000201,
    },
    manualFactualReview: "required",
    approvalCeilingUsd: 0.0205,
  };
}

test("asks a PostgreSQL question, renders a cited claim and opens the current note", async ({
  page,
}) => {
  const title = `Ask E2E ${Date.now()}`;
  const noteId = await createAskNote(page, title);
  const posts: unknown[] = [];
  const providerRequests: string[] = [];

  page.on("request", (request) => {
    if (/openrouter|elevenlabs/i.test(request.url())) {
      providerRequests.push(request.url());
    }
  });

  await page.route("**/api/ask", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    posts.push(JSON.parse(route.request().postData() ?? "{}"));

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(askResponse(noteId, title)),
    });
  });

  await page.goto("/search?mode=hybrid");
  await expect(page.getByTestId("ask-notes")).toBeVisible();
  await expect(page.getByTestId("ask-submit")).toBeDisabled();

  await page.getByTestId("ask-question").fill(
    "Co je v poznámkách o migraci PostgreSQL?",
  );
  expect(posts).toHaveLength(0);
  await page.getByTestId("ask-confirm").check();
  await page.getByTestId("ask-submit").click();

  await expect(page.getByTestId("ask-results")).toBeVisible();
  await expect(page.getByTestId("ask-claim-0")).toContainText(
    "Migrace PostgreSQL je v sobotu.",
  );
  await expect(
    page.getByTestId("ask-citation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  ).toContainText(title);
  await expect(page.getByTestId("ask-results")).toContainText("Neznámá");
  await expect(page.getByTestId("ask-results")).toContainText("ručně");

  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    question: "Co je v poznámkách o migraci PostgreSQL?",
    confirmCost: true,
  });
  expect(
    Number((posts[0] as { approvedMaxCostUsd?: number }).approvedMaxCostUsd),
  ).toBeGreaterThan(0);

  await page
    .getByTestId("ask-citation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    .click();
  await expect(page).toHaveURL(new RegExp(`/notes/${noteId}$`));
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  expect(providerRequests).toEqual([]);
});

test("shows the exact insufficient-evidence state without source links", async ({
  page,
}) => {
  await page.route("**/api/ask", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "insufficient_evidence",
        answer:
          "V poznámkách jsem pro tuto odpověď nenašel dostatek podkladů.",
        retrieval: "text_only",
        claims: [],
        sources: [],
        cost: {
          approvedMaxCostUsd: 0.02,
          queryEmbeddingUsd: 0,
          llmUsd: 0,
          totalEstimatedUsd: 0,
        },
        manualFactualReview: "required",
        approvalCeilingUsd: 0.02,
      }),
    });
  });

  await page.goto("/search?mode=hybrid");
  await page.getByTestId("ask-question").fill("nesouvisející otázka");
  await page.getByTestId("ask-confirm").check();
  await page.getByTestId("ask-submit").click();

  await expect(page.getByTestId("ask-insufficient")).toContainText(
    "V poznámkách jsem pro tuto odpověď nenašel dostatek podkladů.",
  );
  await expect(page.getByTestId("ask-results")).toHaveCount(0);
  await expect(page.getByTestId("ask-notes").getByRole("link")).toHaveCount(0);
});

test("refuses an invented citation link even if the answer payload is malformed", async ({
  page,
}) => {
  await page.route("**/api/ask", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "answered",
        answer: "Vymyšlená odpověď.",
        retrieval: "hybrid",
        claims: [
          {
            text: "Vymyšlené tvrzení.",
            citations: [
              {
                noteId: "not-a-uuid",
                chunkId: "also-not-a-uuid",
                noteTitle: "Vymyšlený zdroj",
                noteVersion: 1,
              },
            ],
          },
        ],
        sources: [],
        cost: {
          approvedMaxCostUsd: 0.0205,
          queryEmbeddingUsd: 0.000001,
          llmUsd: 0.0002,
          totalEstimatedUsd: 0.000201,
        },
        manualFactualReview: "required",
        approvalCeilingUsd: 0.0205,
      }),
    });
  });

  await page.goto("/search?mode=hybrid");
  await page.getByTestId("ask-question").fill("otázka");
  await page.getByTestId("ask-confirm").check();
  await page.getByTestId("ask-submit").click();

  await expect(page.getByTestId("ask-error")).toContainText(
    "Odpověď obsahuje citaci, kterou nelze bezpečně otevřít.",
  );
  await expect(page.getByTestId("ask-results")).toHaveCount(0);
  await expect(page.getByTestId("ask-notes").getByRole("link")).toHaveCount(0);
});

test("submitting no question makes zero paid requests", async ({ page }) => {
  const posts: unknown[] = [];

  await page.route("**/api/ask", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    posts.push(JSON.parse(route.request().postData() ?? "{}"));
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "unexpected_ask", message: "Neočekávaný požadavek." },
      }),
    });
  });

  await page.goto("/search?mode=hybrid");
  const submit = page.getByTestId("ask-submit");

  await page.getByTestId("ask-confirm").check();
  await expect(submit).toBeDisabled();
  await page.getByTestId("ask-question").fill("   ");
  await expect(submit).toBeDisabled();
  expect(posts).toHaveLength(0);
});

test("refuses a deleted/stale citation response and renders no note links", async ({
  page,
}) => {
  await page.route("**/api/ask", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "grounding_sources_stale",
          message: "Poznámky se během odpovědi změnily. Položte otázku znovu.",
        },
      }),
    });
  });

  await page.goto("/search?mode=hybrid");
  await page.getByTestId("ask-question").fill("otázka na smazanou poznámku");
  await page.getByTestId("ask-confirm").check();
  await page.getByTestId("ask-submit").click();

  await expect(page.getByTestId("ask-error")).toContainText(
    "Poznámky se během odpovědi změnily.",
  );
  await expect(page.getByTestId("ask-results")).toHaveCount(0);
  await expect(page.getByTestId("ask-notes").getByRole("link")).toHaveCount(0);
});
