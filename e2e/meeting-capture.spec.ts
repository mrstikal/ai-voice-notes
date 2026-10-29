import { readdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import { Pool } from "pg";

import {
  assertTestDatabaseTargets,
  loadTestEnvironment,
} from "../scripts/test-db-guard";
import { DEFAULT_MEETING_UPLOAD_DIR } from "../src/lib/meetings/audio";

test.setTimeout(120_000);

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

async function noteCount(): Promise<number> {
  return withTestPool(async (pool) => {
    const result = await pool.query<{ count: string }>(
      "select count(*)::int as count from notes",
    );

    return Number(result.rows[0]?.count ?? 0);
  });
}

async function meetingTempFiles(): Promise<string[]> {
  try {
    return (await readdir(DEFAULT_MEETING_UPLOAD_DIR)).filter((name) =>
      name.startsWith("meeting-"),
    );
  } catch {
    return [];
  }
}

test("uploads and inspects a local file without creating a note or calling a provider", async ({
  page,
  request,
}) => {
  const beforeNotes = await noteCount();
  const providerRequests: string[] = [];

  page.on("request", (browserRequest) => {
    if (/openrouter|elevenlabs|api\.openai/i.test(browserRequest.url())) {
      providerRequests.push(browserRequest.url());
    }
  });

  await page.goto("/meetings");
  await expect(
    page.getByRole("heading", { name: "Zápis ze schůzky" }),
  ).toBeVisible();
  await expect(page.getByTestId("meeting-recorder")).toBeVisible();

  await page.getByTestId("meeting-file").setInputFiles({
    name: "synteticka-schuzka.webm",
    mimeType: "audio/webm",
    buffer: Buffer.from("synthetic-audio-bytes"),
  });

  await expect(page.getByTestId("meeting-preview")).toBeVisible();
  await expect(page.getByTestId("meeting-preview")).toContainText(
    "synteticka-schuzka.webm",
  );
  await expect(page.getByTestId("meeting-preview")).toContainText(
    "Typ a délka dosud neověřeny",
  );
  await expect(page.getByTestId("meeting-inspected")).toHaveCount(0);

  await page.getByTestId("meeting-inspect").click();

  await expect(page.getByTestId("meeting-inspected")).toBeVisible();
  await expect(page.getByTestId("meeting-inspected")).toContainText(
    "Server přijal",
  );
  await expect(page.getByTestId("meeting-inspected")).toContainText(
    "Typ a délka dosud neověřeny",
  );

  expect(await noteCount()).toBe(beforeNotes);
  expect(await meetingTempFiles()).toEqual([]);
  expect(providerRequests).toEqual([]);

  const wrongOrigin = await request.post("/api/meetings/inspect", {
    headers: {
      origin: "http://evil.example",
      "content-type": "application/octet-stream",
    },
    data: Buffer.from("synthetic-audio"),
  });

  expect(wrongOrigin.status()).toBe(403);
  expect(await meetingTempFiles()).toEqual([]);
});

test("the meetings page links from the main navigation and keeps recording guidance visible", async ({
  page,
}) => {
  await page.goto("/search");
  await page.getByRole("link", { name: "Zápis ze schůzky" }).click();

  await expect(page).toHaveURL(/\/meetings$/);
  await expect(
    page.getByRole("heading", { name: "Zápis ze schůzky" }),
  ).toBeVisible();
  await expect(page.getByTestId("meeting-start")).toBeVisible();
  await expect(page.getByTestId("meeting-file")).toBeVisible();
  await expect(page.getByTestId("meeting-recorder")).toContainText(
    "Max. 15 min",
  );
  await expect(page.getByTestId("meeting-recorder")).toContainText(
    /26\s*214\s*400 B/u,
  );
});

test.afterAll(async () => {
  // The route unlinks its own temp file; this is a safety check for the suite.
  const leftovers = await meetingTempFiles();

  expect(leftovers, `leftover meeting temp files: ${leftovers.join(", ")}`).toEqual(
    [],
  );
});
