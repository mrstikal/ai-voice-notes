import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { Pool } from "pg";

import {
  assertTestDatabaseTargets,
  loadTestEnvironment,
} from "../scripts/test-db-guard";
import {
  GEMINI_LIVE_WEBSOCKET_PATTERN,
  GeminiLiveSocketDouble,
} from "../tests/helpers/webrtc-double";
import { GEMINI_LIVE_SESSION_MAX_SECONDS } from "../src/lib/voice-agent/gemini-session-shared";
import { createNoteViaApi } from "./helpers/create-note";

test.setTimeout(180_000);

test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  },
});

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

async function withTestPool<T>(
  operation: (pool: Pool) => Promise<T>,
): Promise<T> {
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

interface NoteState {
  readonly contentMd: string;
  readonly title: string;
  readonly version: number;
}

async function readNote(
  request: APIRequestContext,
  noteId: string,
): Promise<NoteState> {
  const response = await request.get(`/api/notes/${noteId}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as NoteState;
}

async function revisionReasons(noteId: string): Promise<string[]> {
  return withTestPool(async (pool) => {
    const result = await pool.query<{ reason: string }>(
      "select reason from note_revisions where note_id = $1 order by note_version asc",
      [noteId],
    );

    return result.rows.map((row) => row.reason);
  });
}

async function createNote(page: Page, title: string): Promise<string> {
  const marker = `zvonek${randomUUID().replace(/-/gu, "").slice(0, 10)}`;

  const noteId = await createNoteViaApi(page, `${title} ${marker}`, `Migrační poznámka pro hlasového asistenta.\n\nMarker ${marker}.`);

  createdNoteId = noteId;
  return noteId;
}

test("mock voice agent: connect, select, reject, approve, undo and stop without an unauthorized mutation", async ({
  context,
  page,
  request,
}) => {
  const title = `Hlasový agent E2E ${Date.now()}`;
  const noteId = await createNote(page, title);
  const baseline = await readNote(request, noteId);
  const marker = baseline.contentMd.match(/Marker (zvonek[0-9a-f]+)\./u)?.[1];

  if (!marker) {
    throw new Error("Marker testovací poznámky se nepodařilo přečíst.");
  }

  const double = new GeminiLiveSocketDouble();
  await page.routeWebSocket(GEMINI_LIVE_WEBSOCKET_PATTERN, (socket) => {
    double.attach(socket);
  });

  await page.goto("/voice-agent");
  await expect(page.getByTestId("voice-agent-cost-warning")).toContainText(
    "Cena Gemini je neznámá",
  );
  await expect(page.getByTestId("voice-agent-cost-warning")).toContainText(
    `${GEMINI_LIVE_SESSION_MAX_SECONDS / 60} minut`,
  );

  await page.getByTestId("voice-agent-connect").click();
  await expect(page.getByTestId("voice-agent-connection-status")).toContainText(
    "Připojeno",
    { timeout: 30_000 },
  );
  await double.waitForSetup();

  double.sendToolCall([
    {
      args: { maxResults: 3, query: marker },
      id: "call-search-1",
      name: "search_notes",
    },
  ]);

  const results = page.getByTestId("voice-agent-search-results");
  await expect(results).toBeVisible();
  const resultItem = results
    .locator("li")
    .filter({ hasText: `${title} ${marker}` });
  await expect(resultItem).toHaveCount(1);
  await resultItem.getByRole("button", { name: "Vybrat" }).click();
  await expect(page.getByTestId("voice-agent-selected-note")).toContainText(
    `${title} ${marker}`,
  );
  await expect
    .poll(() =>
      double.clientContentTexts().some((text) => text.includes(noteId)),
    )
    .toBe(true);

  double.sendToolCall([
    {
      args: { noteId, text: "Zkontrolovat zamítnutý návrh" },
      id: "call-todo-reject",
      name: "add_todo",
    },
  ]);

  const pending = page.getByTestId("voice-agent-pending-edit");
  await expect(pending).toBeVisible();
  await expect(pending.getByTestId("voice-agent-pending-diff")).toContainText(
    "Zkontrolovat zamítnutý návrh",
  );

  const afterPreview = await readNote(request, noteId);
  expect(afterPreview.contentMd).toBe(baseline.contentMd);
  expect(afterPreview.version).toBe(baseline.version);
  expect(await revisionReasons(noteId)).toEqual(["initial"]);

  await pending.getByTestId("voice-agent-pending-reject").click();
  await expect(pending).toContainText("Zamítnuto");
  await expect
    .poll(() => double.clientContentTexts().some((text) => text.includes("zamít")))
    .toBe(true);

  const afterReject = await readNote(request, noteId);
  expect(afterReject.contentMd).toBe(baseline.contentMd);
  expect(afterReject.version).toBe(baseline.version);
  expect(await revisionReasons(noteId)).toEqual(["initial"]);

  double.sendToolCall([
    {
      args: { noteId, text: "Dokončit regresní test" },
      id: "call-todo-apply",
      name: "add_todo",
    },
  ]);

  const pendingApply = page.getByTestId("voice-agent-pending-edit");
  await expect(pendingApply.getByTestId("voice-agent-pending-diff")).toContainText(
    "Dokončit regresní test",
  );
  await pendingApply.getByTestId("voice-agent-pending-confirm").click();
  await expect(pendingApply).toContainText("Aplikováno", {
    timeout: 20_000,
  });

  const afterApply = await readNote(request, noteId);
  expect(afterApply.version).toBe(baseline.version + 1);
  expect(afterApply.contentMd).toContain("- [ ] Dokončit regresní test");
  expect(await revisionReasons(noteId)).toEqual(["initial", "ai"]);
  await expect
    .poll(() =>
      double.clientContentTexts().some((text) => text.includes("verzi")),
    )
    .toBe(true);

  const notePage = await context.newPage();
  await notePage.goto(`/notes/${noteId}`);
  const history = notePage.getByTestId("revision-history");
  await expect(history).toBeVisible();
  await history
    .getByRole("button", { name: "Vrátit poslední změnu" })
    .click();
  await expect(notePage.getByLabel("Obsah (Markdown)")).toHaveValue(
    baseline.contentMd,
  );
  await expect(history.getByText("Vrácení změny")).toBeVisible();
  expect(await revisionReasons(noteId)).toEqual(["initial", "ai", "undo"]);

  await page.getByTestId("voice-agent-stop").click();
  await expect(page.getByTestId("voice-agent-connection-status")).toContainText(
    "Odpojeno",
  );
  await double.waitForClose();

  await page.getByTestId("voice-agent-connect").click();
  await expect(page.getByTestId("voice-agent-connection-status")).toContainText(
    "Připojeno",
    { timeout: 30_000 },
  );
  await double.waitForSetup();
  await page.getByTestId("voice-agent-stop").click();
  await expect(page.getByTestId("voice-agent-connection-status")).toContainText(
    "Odpojeno",
  );
  await double.waitForClose();

  const storage = await page.evaluate(() => ({
    local: JSON.stringify({ ...localStorage }),
    session: JSON.stringify({ ...sessionStorage }),
  }));
  expect(storage.local).not.toContain("Dokončit regresní test");
  expect(storage.session).not.toContain("Dokončit regresní test");
  expect(storage.local).not.toContain(marker);
  expect(storage.session).not.toContain(marker);
});
