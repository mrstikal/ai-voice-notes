import { readFile } from "node:fs/promises";

import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { Pool } from "pg";

import {
  assertTestDatabaseTargets,
  loadTestEnvironment,
} from "../scripts/test-db-guard";
import { createNoteViaApi } from "./helpers/create-note";
import { openNoteTab } from "./helpers/tabs";

test.setTimeout(120_000);

test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  },
});

let createdNoteIds: string[] = [];
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
  const noteIds = createdNoteIds;
  createdNoteIds = [];

  if (noteIds.length === 0) {
    return;
  }

  await withTestPool(async (pool) => {
    await pool.query(
      "delete from meeting_saves where note_ids && $1::uuid[]",
      [noteIds],
    );
    await pool.query("delete from notes where id = any($1::uuid[])", [noteIds]);
  });
});

async function createNote(
  page: Page,
  title: string,
  content: string,
): Promise<string> {
  const noteId = await createNoteViaApi(page, title, content);

  createdNoteIds.push(noteId);
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

async function installScribeMock(page: Page): Promise<{
  readonly socket: Promise<WebSocketRoute>;
}> {
  let resolveSocket!: (socket: WebSocketRoute) => void;
  const socket = new Promise<WebSocketRoute>((resolve) => {
    resolveSocket = resolve;
  });

  await page.routeWebSocket(
    /api\.elevenlabs\.io\/v1\/speech-to-text\/realtime/,
    (webSocket) => {
      webSocket.send(
        JSON.stringify({
          message_type: "session_started",
          session_id: "four-stage-scribe",
        }),
      );
      webSocket.onMessage((message) => {
        try {
          const data = JSON.parse(String(message)) as {
            message_type?: string;
            commit?: boolean;
          };

          if (
            data.message_type === "input_audio_chunk" &&
            data.commit
          ) {
            webSocket.send(
              JSON.stringify({
                message_type: "committed_transcript",
                id: "four-stage-segment",
                text: "",
              }),
            );
          }
        } catch {
          return;
        }
      });
      resolveSocket(webSocket);
    },
  );

  return { socket };
}

async function mockSummary(page: Page, noteId: string, noteVersion: number): Promise<void> {
  await page.route("**/api/notes/*/ai-suggest", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      kind?: string;
    };

    if (body.kind !== "summary") {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        kind: "summary",
        noteId,
        noteVersion,
        sourceGraphemes: 120,
        summaryText: "Shrnutí čtyřfázového testu: migrace databáze je hotová.",
      }),
    });
  });
}

async function saveMeetingNote(
  request: Page["request"],
  title: string,
): Promise<string> {
  const response = await request.post("/api/meetings/save", {
    headers: { origin: "http://127.0.0.1:3100" },
    data: {
      requestId: crypto.randomUUID(),
      title,
      text: "Rozhodli jsme, že migrace databáze začne v pondělí. Petra pošle zápis do pátku.",
    },
  });

  expect(response.status()).toBe(201);
  const body = (await response.json()) as { noteIds: string[] };
  const noteId = body.noteIds[0] ?? "";

  expect(noteId).toMatch(/^[0-9a-f-]{36}$/u);
  createdNoteIds.push(noteId);
  return noteId;
}

test("four stages work offline across typed, dictated, AI-edited and searched notes, and a provider outage loses nothing", async ({
  page,
  request,
}) => {
  const title = `Čtyři fáze E2E ${Date.now()}`;
  const noteId = await createNote(page, title, "Ruční text o databázi.");
  const initialNote = await currentNote(request, noteId);
  const source = page.getByLabel("Obsah (Markdown)");

  // Stage 2: mocked Scribe dictation commits a sentence into the typed note.
  await source.click();
  await source.press("End");
  await page.route("**/api/elevenlabs/scribe-token", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        token: "sutkn_four_stage_mock",
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        expiresInSeconds: 900,
        maxSessionSeconds: 180,
        modelId: "scribe_v2_realtime",
      }),
    }),
  );
  const scribe = await installScribeMock(page);
  await page.getByRole("button", { name: "Diktovat text" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  const socket = await scribe.socket;
  socket.send(
    JSON.stringify({
      message_type: "committed_transcript",
      id: "four-stage-manual",
      text: " Diktovaná věta o migraci databáze.",
    }),
  );
  await expect(source).toHaveValue(/Diktovaná věta o migraci databáze\./u);
  await page.getByRole("button", { name: "Stop" }).click();
  // The dictation Stop flush performs the voice save itself. Wait for that
  // exact version instead of racing a second manual save, which would remount
  // the summary panel after the artifact is generated.
  await expect(page.getByRole("status")).toContainText(
    new RegExp(
      `(?:Hlasový přepis uložen|Uloženo) · verze ${initialNote.version + 1}`,
      "u",
    ),
  );

  const afterDictation = await currentNote(request, noteId);
  expect(afterDictation.contentMd).toContain("Ruční text o databázi.");
  expect(afterDictation.contentMd).toContain("Diktovaná věta o migraci databáze.");

  // Stage 3: mocked summary -> visible proposal -> explicit confirmation.
  await mockSummary(page, noteId, afterDictation.version);
  const revisionsBeforeSummary = await revisionCount(noteId);
  await openNoteTab(page, "Shrnutí poznámky");
  await page.getByTestId("summary-generate").click();
  await expect(page.getByTestId("summary-artifact")).toContainText(
    "Shrnutí čtyřfázového testu",
  );
  await page.getByRole("button", { name: "Vložit shrnutí" }).click();
  await expect(page.getByTestId("proposal-preview")).toBeVisible();
  expect((await currentNote(request, noteId)).version).toBe(
    afterDictation.version,
  );
  await page.getByRole("button", { name: "Potvrdit", exact: true }).click();
  await expect(page.getByTestId("summary-artifact")).toHaveCount(0);
  expect(await revisionCount(noteId)).toBe(revisionsBeforeSummary + 1);

  const afterSummary = await currentNote(request, noteId);
  expect(afterSummary.contentMd).toContain("Shrnutí čtyřfázového testu");
  expect(afterSummary.contentMd).toContain("Diktovaná věta o migraci databáze.");

  // Stage 1: exact Markdown export from the edited note.
  await page.goto(`/notes/${noteId}`);
  await page.getByText("Export", { exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Markdown (.md)" }).click(),
  ]);
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toMatch(/\.md$/u);
  const downloadedPath = await download.path();

  if (!downloadedPath) {
    throw new Error("Stažený soubor nemá dostupnou cestu.");
  }

  expect(await readFile(downloadedPath, "utf8")).toBe(afterSummary.contentMd);

  // Stage 4: offline full-text search finds the same note.
  await page.goto("/search?mode=fulltext&q=migraci");
  await expect(page.getByTestId(`search-result-${noteId}`)).toBeVisible();

  // Stage 4: a saved meeting gets a mocked task suggestion through P22-P24.
  const meetingTitle = `Schůzka čtyř fází ${Date.now()}`;
  const meetingNoteId = await saveMeetingNote(request, meetingTitle);

  await page.goto("/meetings");
  await expect(page.getByTestId("meeting-suggestions")).toBeVisible();
  const meetingSelector = page.getByTestId("meeting-suggestion-note");

  if ((await meetingSelector.count()) > 0) {
    await meetingSelector.selectOption({ label: meetingTitle });
    await expect(
      page.getByTestId("meeting-suggestion-selected-note"),
    ).toContainText(meetingTitle);
  } else {
    await expect(
      page.getByTestId("meeting-suggestion-note-label"),
    ).toContainText(meetingTitle);
  }
  await page.route("**/api/notes/*/ai-suggest", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      kind?: string;
      expectedVersion?: number;
      tasks?: string[];
    };

    if (body.kind === "meeting_tasks") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          noteId: meetingNoteId,
          noteVersion: 1,
          tasks: [{ text: "Poslat zápis", normalized: "poslat zapis", duplicate: false }],
          rejectedCount: 0,
          sourceGraphemes: 80,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        }),
      });
      return;
    }

    if (body.kind === "task_apply") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          kind: "task_apply",
          operation: {
            type: "append_bounded_section",
            text: "## Úkoly\n\n- [ ] Poslat zápis",
          },
          noteVersion: body.expectedVersion,
          tasks: body.tasks ?? [],
        }),
      });
      return;
    }

    await route.continue();
  });

  await page.getByTestId("meeting-tasks-generate").click();
  await expect(page.getByTestId("meeting-tasks-artifact")).toBeVisible();
  await page.getByTestId("meeting-tasks-propose").click();
  await expect(page.getByTestId("proposal-preview")).toBeVisible();
  await page.getByRole("button", { name: "Potvrdit", exact: true }).click();
  await expect(page.getByTestId("meeting-suggestions-status")).toContainText(
    "Úkoly byly vloženy jako nová revize.",
  );

  const meetingNote = await currentNote(request, meetingNoteId);
  expect(meetingNote.contentMd).toContain("## Úkoly");
  expect(meetingNote.contentMd).toContain("- [ ] Poslat zápis");

  // Provider outage: summary attempt fails and leaves the note untouched.
  await page.unroute("**/api/notes/*/ai-suggest");
  await page.route("**/api/notes/*/ai-suggest", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "ai_unavailable",
          message: "Poskytovatel AI je dočasně nedostupný.",
        },
      }),
    }),
  );

  await page.goto(`/notes/${noteId}`);
  await openNoteTab(page, "Shrnutí poznámky");
  const beforeOutage = await currentNote(request, noteId);
  const revisionsBeforeOutage = await revisionCount(noteId);
  await page.getByTestId("summary-generate").click();
  await expect(
    page.getByText("Poskytovatel AI je dočasně nedostupný."),
  ).toBeVisible();
  const afterOutage = await currentNote(request, noteId);

  expect(afterOutage.contentMd).toBe(beforeOutage.contentMd);
  expect(afterOutage.version).toBe(beforeOutage.version);
  expect(await revisionCount(noteId)).toBe(revisionsBeforeOutage);
});
