import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";

import {
  assertTestDatabaseTargets,
  loadTestEnvironment,
} from "../scripts/test-db-guard";
import { createNoteViaApi } from "./helpers/create-note";

test.setTimeout(120_000);

test.use({
  launchOptions: {
    args: ["--autoplay-policy=no-user-gesture-required"],
  },
});

const NOTE_CONTENT = [
  "První odstavec.",
  "",
  "Druhý odstavec.",
  "",
  "- [ ] Koupit mléko",
  "- [x] Zavolat lékaři",
  "",
  "Mezi textem.",
  "",
  "- [ ] Připravit report",
].join("\n");

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

test.afterEach(async () => {
  if (!createdNoteId) {
    return;
  }

  const noteId = createdNoteId;
  createdNoteId = undefined;
  const pool = new Pool({ connectionString: testDatabaseUrl() });

  try {
    await pool.query("delete from notes where id = $1", [noteId]);
  } finally {
    await pool.end();
  }
});

async function createNote(page: Page, title: string): Promise<string> {
  const noteId = await createNoteViaApi(page, title, NOTE_CONTENT);

  createdNoteId = noteId;
  return noteId;
}

function silentWav(durationSec: number): Buffer {
  const sampleRate = 8_000;
  const samples = Math.max(1, Math.round(sampleRate * durationSec));
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

interface ManifestRequest {
  readonly noteId: string;
  readonly voice: string;
  readonly scope: "full" | "range" | "paragraph" | "tasks";
  readonly start?: number;
  readonly end?: number;
  readonly paragraphIndex?: number;
  readonly listIndex?: number;
  readonly sectionIndex?: number;
  readonly expectedSourceHash?: string;
}

const SOURCE_HASH = "c".repeat(64);
const MODEL = "elevenlabs/eleven-v4-turbo";

function sectionTexts(body: ManifestRequest): string[] {
  if (body.scope === "full") {
    return [
      "První odstavec.",
      "Druhý odstavec.",
      "Koupit mléko",
      "Zavolat lékaři",
      "Mezi textem.",
      "Připravit report",
    ];
  }

  if (body.scope === "range") {
    return [
      "První odstavec.".slice(body.start ?? 0, body.end ?? undefined),
    ];
  }

  if (body.scope === "paragraph") {
    return [body.paragraphIndex === 1 ? "Druhý odstavec." : "První odstavec."];
  }

  if (body.listIndex === 1) {
    return ["Připravit report"];
  }

  return ["Koupit mléko", "Zavolat lékaři"];
}

async function installTtsMock(
  page: Page,
  options: {
    readonly noteId: string;
    readonly onSection?: (
      body: ManifestRequest,
      sectionNumber: number,
    ) => { readonly status: number; readonly message?: string } | null;
  },
): Promise<{ readonly requests: ManifestRequest[] }> {
  const requests: ManifestRequest[] = [];
  const audio = silentWav(4);
  let manifestCalls = 0;
  let sectionCalls = 0;

  await page.route("**/api/tts", async (route) => {
    const body = route.request().postDataJSON() as ManifestRequest;
    requests.push(body);

    if (body.sectionIndex === undefined) {
      manifestCalls += 1;
      const sections = sectionTexts(body).map((text, index) => ({
        index,
        text,
        start: index * 20,
        end: index * 20 + text.length,
        cacheKey: `e2e-${body.scope}-${index}`,
        cached: body.scope === "full" && manifestCalls > 1,
      }));

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          noteId: options.noteId,
          noteVersion: 1,
          sourceHash: SOURCE_HASH,
          voice: body.voice,
          model: MODEL,
          selection: {
            scope: body.scope,
            ...(body.start === undefined ? {} : { start: body.start }),
            ...(body.end === undefined ? {} : { end: body.end }),
            ...(body.paragraphIndex === undefined
              ? {}
              : { paragraphIndex: body.paragraphIndex }),
            ...(body.listIndex === undefined
              ? {}
              : { listIndex: body.listIndex }),
          },
          cacheHit: body.scope === "full" && manifestCalls > 1,
          estimatedMaxCostUsd:
            body.scope === "full" && manifestCalls > 1 ? "0.000000" : "0.280000",
          sections,
        }),
      });
      return;
    }

    sectionCalls += 1;
    const failure = options.onSection?.(body, sectionCalls);

    if (failure) {
      await route.fulfill({
        status: failure.status,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "rate_limited",
            message:
              failure.message ?? "Příliš mnoho požadavků. Zkuste to za chvíli.",
          },
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "audio/wav",
        "x-tts-cache": "miss",
      },
      body: audio,
    });
  });

  return { requests };
}

test("sekvenční přehrávání po sekcích, pozastavení, přeskočení, Stop a volby rozsahu", async ({
  page,
}) => {
  const title = `Čtení E2E ${Date.now()}`;
  const noteId = await createNote(page, title);
  const { requests } = await installTtsMock(page, { noteId });

  await page.getByRole("button", { name: "Zjistit rozsah a cenu" }).click();
  await expect(page.getByTestId("tts-section-list")).toBeVisible();

  expect(requests[0]).toMatchObject({ scope: "full", voice: "sarah" });
  await expect(page.getByTestId("tts-section-list")).toContainText(
    "První odstavec.",
  );
  await expect(page.getByTestId("tts-section-list")).toContainText(
    "Připravit report",
  );

  const play = page.getByRole("button", { name: "Přehrát" });
  await expect(play).toBeDisabled();
  await page.getByTestId("tts-consent").check();
  await expect(play).toBeEnabled();
  await play.click();

  await expect
    .poll(() => requests.some((request) => request.sectionIndex === 0))
    .toBe(true);
  await expect(
    page.getByTestId("tts-section-list").locator("li[aria-current='true']"),
  ).toContainText("První odstavec.");

  await page.getByRole("button", { name: "Pozastavit" }).click();
  await expect(
    page.getByRole("button", { name: "Pokračovat" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pokračovat" }).click();
  await expect(page.getByRole("button", { name: "Pozastavit" })).toBeVisible();

  await page.getByRole("button", { name: "Další" }).click();
  await expect
    .poll(() => requests.at(-1)?.sectionIndex)
    .toBe(1);
  await expect(
    page.getByTestId("tts-section-list").locator("li[aria-current='true']"),
  ).toContainText("Druhý odstavec.");

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Přehrávání bylo zastaveno.")).toBeVisible();

  const requestsAfterStop = requests.length;
  await page.waitForTimeout(500);
  expect(requests).toHaveLength(requestsAfterStop);

  await page.getByRole("button", { name: "Zjistit rozsah a cenu" }).click();
  await expect(
    page.getByText(/0 USD \(vše z cache\)/),
  ).toBeVisible();

  await page.getByTestId("tts-scope").selectOption("tasks");
  await page.getByTestId("tts-task-list").selectOption("1");
  await page.getByRole("button", { name: "Zjistit rozsah a cenu" }).click();
  await expect
    .poll(() => requests.at(-1)?.listIndex)
    .toBe(1);
  expect(requests.at(-1)).toMatchObject({ scope: "tasks" });
  await expect(page.getByTestId("tts-section-list")).toContainText(
    "Připravit report",
  );

  await page.getByTestId("tts-scope").selectOption("paragraph");
  await page.getByTestId("tts-paragraph").selectOption("1");
  await page.getByRole("button", { name: "Zjistit rozsah a cenu" }).click();
  await expect
    .poll(() => requests.at(-1)?.paragraphIndex)
    .toBe(1);
  await expect(page.getByTestId("tts-section-list")).toContainText(
    "Druhý odstavec.",
  );

  await page.getByTestId("tts-scope").selectOption("range");
  await page.getByTestId("tts-range-start").fill("0");
  await page.getByTestId("tts-range-end").fill("5");
  await page.getByRole("button", { name: "Zjistit rozsah a cenu" }).click();
  await expect
    .poll(() => requests.at(-1)?.scope)
    .toBe("range");
  expect(requests.at(-1)).toMatchObject({ scope: "range", start: 0, end: 5 });
  await expect(page.getByTestId("tts-section-list")).toContainText("První");
});

test("429 u další sekce zastaví přehrávání a nevytvoří další požadavek", async ({
  page,
}) => {
  const title = `Čtení 429 E2E ${Date.now()}`;
  const noteId = await createNote(page, title);
  const { requests } = await installTtsMock(page, {
    noteId,
    onSection: (_body, sectionNumber) =>
      sectionNumber === 2
        ? {
            status: 429,
            message: "Příliš mnoho požadavků. Zkuste to za chvíli.",
          }
        : null,
  });

  await page.getByRole("button", { name: "Zjistit rozsah a cenu" }).click();
  await expect(page.getByTestId("tts-section-list")).toBeVisible();
  await page.getByTestId("tts-consent").check();
  await page.getByRole("button", { name: "Přehrát" }).click();
  await expect
    .poll(() => requests.some((request) => request.sectionIndex === 0))
    .toBe(true);

  await page.getByRole("button", { name: "Další" }).click();

  await expect(
    page.getByRole("alert").filter({
      hasText: "Příliš mnoho požadavků. Zkuste to za chvíli.",
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Přehrát" })).toBeVisible();

  const requestsAfterError = requests.length;
  await page.waitForTimeout(700);
  expect(requests).toHaveLength(requestsAfterError);
});
