import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";

import {
  assertTestDatabaseTargets,
  loadTestEnvironment,
} from "../scripts/test-db-guard";
import { MEETING_SAVE_MAX_BYTES } from "../src/lib/meetings/save-shared";
import {
  cleanupMedia,
  createSilentWav,
  hasFfmpeg,
} from "../tests/fixtures/media";

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

async function meetingSaveCount(): Promise<number> {
  return withTestPool(async (pool) => {
    const result = await pool.query<{ count: string }>(
      "select count(*)::int as count from meeting_saves",
    );

    return Number(result.rows[0]?.count ?? 0);
  });
}

async function aiUsageCount(): Promise<number> {
  return withTestPool(async (pool) => {
    const result = await pool.query<{ count: string }>(
      "select count(*)::int as count from ai_usage",
    );

    return Number(result.rows[0]?.count ?? 0);
  });
}

async function readNote(noteId: string): Promise<{
  title: string;
  contentMd: string;
  contentPlain: string;
  revisionReasons: string[];
}> {
  return withTestPool(async (pool) => {
    const note = await pool.query<{
      title: string;
      content_md: string;
      content_plain: string;
    }>(
      "select title, content_md, content_plain from notes where id = $1",
      [noteId],
    );
    const revisions = await pool.query<{ reason: string }>(
      "select reason from note_revisions where note_id = $1 order by note_version",
      [noteId],
    );

    return {
      title: note.rows[0]?.title ?? "",
      contentMd: note.rows[0]?.content_md ?? "",
      contentPlain: note.rows[0]?.content_plain ?? "",
      revisionReasons: revisions.rows.map((row) => row.reason),
    };
  });
}

async function transcribeMockRecording(page: Page): Promise<void> {
  const media = await createSilentWav(1);

  try {
    await page.goto("/meetings");
    await page.getByTestId("meeting-file").setInputFiles({
      name: "schuzka.wav",
      mimeType: "audio/wav",
      buffer: await readFile(media.path),
    });
    await page.getByTestId("meeting-inspect").click();
    await expect(page.getByTestId("meeting-inspected")).toContainText(
      "Typ a délka ověřeny",
    );
    await page.getByTestId("transcript-approve").check();
    await page.getByTestId("transcript-start").click();
    await expect(page.getByTestId("transcript-preview")).toBeVisible();
  } finally {
    await cleanupMedia(media.directory);
  }
}

test.afterEach(async () => {
  await withTestPool(async (pool) => {
    const rows = await pool.query<{ note_ids: string[] }>(
      "select note_ids from meeting_saves",
    );
    const noteIds = rows.rows.flatMap((row) => row.note_ids);

    await pool.query("delete from meeting_saves");

    if (noteIds.length > 0) {
      await pool.query("delete from notes where id = any($1::uuid[])", [
        noteIds,
      ]);
    }
  });
});

test("saves a reviewed mock transcript into one note without another provider call", async ({
  page,
}) => {
  test.skip(!hasFfmpeg(), "FFmpeg is required for the meeting save flow.");

  const notesBefore = await noteCount();
  const savesBefore = await meetingSaveCount();

  await transcribeMockRecording(page);
  await page.getByTestId("transcript-speaker-0").fill("Petra");

  const usageBeforeSave = await aiUsageCount();

  await page.getByTestId("transcript-save").click();
  await expect(page.getByTestId("transcript-saved")).toContainText(
    "Uloženo do 1 poznámky",
  );

  const href = await page
    .getByRole("link", { name: "Poznámka 1" })
    .getAttribute("href");

  expect(href).toMatch(/^\/notes\/[0-9a-f-]{36}$/u);

  const noteId = href?.split("/").at(-1) ?? "";
  const note = await readNote(noteId);

  expect(note.title).toBe("Zápis ze schůzky");
  expect(note.contentMd).toContain("**Petra:** Dobrý den, týme.");
  expect(note.contentMd).toContain("**Mluvčí 2:** Schůzka začíná v devět.");
  expect(note.contentPlain).toContain("Petra: Dobrý den, týme.");
  expect(note.revisionReasons).toEqual(["initial"]);

  expect(await noteCount()).toBe(notesBefore + 1);
  expect(await meetingSaveCount()).toBe(savesBefore + 1);
  expect(await aiUsageCount()).toBe(usageBeforeSave);

  await page.goto(href ?? "/notes");
  const savedMarkdown = await page
    .getByRole("textbox", { name: "Obsah (Markdown)" })
    .inputValue();

  expect(savedMarkdown).toContain("**Petra:** Dobrý den, týme.");
  expect(savedMarkdown).toContain("**Mluvčí 2:** Schůzka začíná v devět.");
});

test("dismissing a reviewed transcript before save creates no note", async ({
  page,
}) => {
  test.skip(!hasFfmpeg(), "FFmpeg is required for the meeting save flow.");

  const notesBefore = await noteCount();
  const savesBefore = await meetingSaveCount();

  await transcribeMockRecording(page);
  await page.getByTestId("transcript-dismiss").click();

  await expect(page.getByTestId("transcript-preview")).toHaveCount(0);
  expect(await noteCount()).toBe(notesBefore);
  expect(await meetingSaveCount()).toBe(savesBefore);
});

test("rejects a forced direct POST over 3 MiB before any database write", async ({
  request,
}) => {
  const notesBefore = await noteCount();
  const savesBefore = await meetingSaveCount();
  const response = await request.post("/api/meetings/save", {
    headers: {
      origin: "http://127.0.0.1:3100",
      "content-type": "application/json",
    },
    data: {
      requestId: "55555555-5555-4555-8555-555555555555",
      title: "Příliš velký zápis",
      text: "x".repeat(MEETING_SAVE_MAX_BYTES),
    },
  });

  expect(response.status()).toBe(413);
  await expect(response.json()).resolves.toMatchObject({
    error: { code: "payload_too_large" },
  });
  expect(await noteCount()).toBe(notesBefore);
  expect(await meetingSaveCount()).toBe(savesBefore);
});
