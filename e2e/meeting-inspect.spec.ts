import { readFile, readdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import { Pool } from "pg";

import {
  assertTestDatabaseTargets,
  loadTestEnvironment,
} from "../scripts/test-db-guard";
import { DEFAULT_MEETING_UPLOAD_DIR } from "../src/lib/meetings/audio";
import {
  cleanupMedia,
  createLiveWebmOpus,
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

async function meetingTempFiles(): Promise<string[]> {
  try {
    return (await readdir(DEFAULT_MEETING_UPLOAD_DIR)).filter((name) =>
      name.startsWith("meeting-"),
    );
  } catch {
    return [];
  }
}

test("rejects a 15-minute + 1 second WAV after real duration inspection", async ({
  page,
}) => {
  test.skip(!hasFfmpeg(), "FFmpeg is required for the long-media inspection.");
  const beforeNotes = await noteCount();
  const media = await createSilentWav(901);

  try {
    await page.goto("/meetings");
    await page.getByTestId("meeting-file").setInputFiles({
      name: "prilis-dlouha.wav",
      mimeType: "audio/wav",
      buffer: await readFile(media.path),
    });

    await expect(page.getByTestId("meeting-preview")).toBeVisible();
    await page.getByTestId("meeting-inspect").click();

    await expect(page.getByTestId("meeting-error")).toContainText(
      "delší než 15 minut",
    );
    await expect(page.getByTestId("meeting-inspected")).toHaveCount(0);
    expect(await noteCount()).toBe(beforeNotes);
    expect(await meetingTempFiles()).toEqual([]);
  } finally {
    await cleanupMedia(media.directory);
  }
});

test("validates a MediaRecorder-like headerless WebM using packet timestamps", async ({
  page,
}) => {
  test.skip(!hasFfmpeg(), "FFmpeg is required for the WebM packet fallback.");
  const media = await createLiveWebmOpus();

  try {
    await page.goto("/meetings");
    await page.getByTestId("meeting-file").setInputFiles({
      name: "media-recorder.webm",
      mimeType: "audio/webm",
      buffer: await readFile(media.path),
    });
    await page.getByTestId("meeting-inspect").click();

    await expect(page.getByTestId("meeting-inspected")).toContainText(
      "WEBM / opus",
    );
    await expect(page.getByTestId("meeting-inspected")).toContainText(
      "Typ a délka ověřeny",
    );
    await expect(page.getByTestId("meeting-inspected")).toContainText(
      /2\.[0-9] s/u,
    );
    expect(await meetingTempFiles()).toEqual([]);
  } finally {
    await cleanupMedia(media.directory);
  }
});

test("transcribes a validated meeting into an unsaved editable preview", async ({
  page,
}) => {
  test.skip(!hasFfmpeg(), "FFmpeg is required for meeting transcription.");
  const beforeNotes = await noteCount();
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
    await expect(page.getByTestId("transcript-offer")).toContainText(
      "elevenlabs",
    );
    await expect(page.getByTestId("transcript-start")).toBeDisabled();

    await page.getByTestId("transcript-approve").check();
    await page.getByTestId("transcript-start").click();

    await expect(page.getByTestId("transcript-preview")).toBeVisible();
    await expect(page.getByTestId("transcript-speaker-0")).toHaveValue(
      "Mluvčí 1",
    );
    await expect(page.getByTestId("transcript-segment-0")).toHaveValue(
      "Dobrý den, týme. ",
    );
    await expect(page.getByTestId("transcript-segment-1")).toHaveValue(
      "Schůzka začíná v devět.",
    );
    await expect(page.getByTestId("transcript-unavailable")).toHaveCount(0);

    await page.getByTestId("transcript-speaker-0").fill("Petra");
    await expect(page.getByTestId("transcript-segment-0")).toBeVisible();

    expect(await noteCount()).toBe(beforeNotes);
    expect(await meetingTempFiles()).toEqual([]);

    await page.getByTestId("transcript-dismiss").click();
    await expect(page.getByTestId("transcript-preview")).toHaveCount(0);
  } finally {
    await cleanupMedia(media.directory);
  }
});

test("rejects a spoofed .wav file based on real media bytes", async ({ page }) => {
  const beforeNotes = await noteCount();

  await page.goto("/meetings");
  await page.getByTestId("meeting-file").setInputFiles({
    name: "podvod.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from("this is not audio"),
  });

  await expect(page.getByTestId("meeting-preview")).toBeVisible();
  await page.getByTestId("meeting-inspect").click();

  await expect(page.getByTestId("meeting-error")).toContainText(
    "Soubor není podporované audio",
  );
  await expect(page.getByTestId("meeting-inspected")).toHaveCount(0);
  expect(await noteCount()).toBe(beforeNotes);
  expect(await meetingTempFiles()).toEqual([]);
});
