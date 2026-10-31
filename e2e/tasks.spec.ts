import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { Pool } from "pg";

import {
  assertTestDatabaseTargets,
  loadTestEnvironment,
} from "../scripts/test-db-guard";

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

async function installTokenMock(page: Page): Promise<void> {
  await page.route("**/api/elevenlabs/scribe-token", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: "sutkn_e2e_tasks" }),
    });
  });
}

interface ScribeMock {
  readonly nextSocket: () => Promise<WebSocketRoute>;
}

async function installScribeMock(page: Page): Promise<ScribeMock> {
  const pending: WebSocketRoute[] = [];
  const resolvers: ((socket: WebSocketRoute) => void)[] = [];

  await page.routeWebSocket(
    /api\.elevenlabs\.io\/v1\/speech-to-text\/realtime/,
    (webSocket) => {
      webSocket.send(
        JSON.stringify({
          message_type: "session_started",
          session_id: "mock-scribe-session",
        }),
      );
      const resolver = resolvers.shift();

      if (resolver) {
        resolver(webSocket);
      } else {
        pending.push(webSocket);
      }
    },
  );

  return {
    nextSocket: () =>
      new Promise<WebSocketRoute>((resolve) => {
        const existing = pending.shift();

        if (existing) {
          resolve(existing);
        } else {
          resolvers.push(resolve);
        }
      }),
  };
}

async function sendCommitted(
  socket: WebSocketRoute,
  text: string,
  id: string,
): Promise<void> {
  socket.send(
    JSON.stringify({
      message_type: "committed_transcript",
      id,
      text,
    }),
  );
}

test("checkbox toggle saves exactly one task, survives export/reload and Undo restores it", async ({
  page,
  request,
}) => {
  const title = `Úkoly E2E ${Date.now()}`;
  const original = "- [ ] Koupit mléko\n- [x] Zavolat lékaři";
  const noteId = await createNote(page, title, original);

  expect(await revisionCount(noteId)).toBe(1);

  await page.getByRole("button", { name: "Vizuální režim" }).click();
  const visual = page.getByRole("textbox", { name: "Vizuální editor poznámky" });
  await expect(visual).toBeVisible();

  const checkboxes = visual.locator('input[type="checkbox"]');
  await expect(checkboxes).toHaveCount(2);
  await checkboxes.nth(0).click();

  await expect
    .poll(async () => (await currentNote(request, noteId)).version, {
      timeout: 15_000,
    })
    .toBe(2);
  const toggled = await currentNote(request, noteId);

  expect(toggled.contentMd).toBe(
    "- [x] Koupit mléko\n- [x] Zavolat lékaři",
  );
  expect(await revisionCount(noteId)).toBe(2);

  const exported = await request.get(
    `/api/notes/${noteId}/export?format=md`,
  );
  expect(exported.ok()).toBe(true);
  expect(await exported.text()).toBe(toggled.contentMd);

  await page.reload();
  await page.getByRole("button", { name: "Vizuální režim" }).click();
  const reloaded = page.getByRole("textbox", {
    name: "Vizuální editor poznámky",
  });
  const reloadedCheckboxes = reloaded.locator('input[type="checkbox"]');
  await expect(reloadedCheckboxes.nth(0)).toBeChecked();
  await expect(reloadedCheckboxes.nth(1)).toBeChecked();

  const history = page.getByTestId("revision-history");
  await expect(history.getByText("Ruční úprava")).toHaveCount(1);
  await history
    .getByRole("button", { name: "Vrátit poslední změnu" })
    .click();

  await expect
    .poll(async () => (await currentNote(request, noteId)).contentMd, {
      timeout: 15_000,
    })
    .toBe(original);
  expect(await revisionCount(noteId)).toBe(3);
});

test("voice task command confirms exactly one matching task and blocks duplicates", async ({
  page,
  request,
}) => {
  const title = `Hlasové úkoly E2E ${Date.now()}`;
  const original = [
    "- [ ] Koupit mléko",
    "- [ ] Koupit mléko",
    "- [ ] Napsat testy",
  ].join("\n");
  const noteId = await createNote(page, title, original);

  await installTokenMock(page);
  const mock = await installScribeMock(page);

  await page.getByRole("button", { name: "Nadiktovat změnu úkolu" }).click();
  const duplicateSocket = await mock.nextSocket();
  await sendCommitted(
    duplicateSocket,
    "Označ úkol Koupit mléko jako hotový.",
    "task-duplicate",
  );

  await expect(
    page.getByText("Text úkolu odpovídá více úkolům", { exact: true }),
  ).toBeVisible();
  expect((await currentNote(request, noteId)).version).toBe(1);
  expect(await revisionCount(noteId)).toBe(1);

  await page.getByRole("button", { name: /^2\./ }).click();
  await expect(page.getByTestId("proposal-preview")).toBeVisible();
  expect((await currentNote(request, noteId)).version).toBe(1);

  await page.getByRole("button", { name: "Potvrdit" }).click();

  await expect
    .poll(async () => (await currentNote(request, noteId)).version, {
      timeout: 15_000,
    })
    .toBe(2);
  const confirmed = await currentNote(request, noteId);
  expect(confirmed.contentMd).toBe(
    [
      "- [ ] Koupit mléko",
      "- [x] Koupit mléko",
      "- [ ] Napsat testy",
    ].join("\n"),
  );
  expect(await revisionCount(noteId)).toBe(2);
  await expect(page.getByTestId("task-voice-applied")).toContainText(
    "Změna úkolu byla uložena.",
  );

  await expect(
    page.getByRole("button", { name: "Nadiktovat změnu úkolu" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Nadiktovat změnu úkolu" }).click();
  const uniqueSocket = await mock.nextSocket();
  await sendCommitted(
    uniqueSocket,
    "Označ úkol Napsat testy jako hotový.",
    "task-unique",
  );

  await expect(page.getByTestId("proposal-preview")).toBeVisible();
  await page.getByRole("button", { name: "Potvrdit" }).click();

  await expect
    .poll(async () => (await currentNote(request, noteId)).contentMd, {
      timeout: 15_000,
    })
    .toBe(
      [
        "- [ ] Koupit mléko",
        "- [x] Koupit mléko",
        "- [x] Napsat testy",
      ].join("\n"),
    );

  await expect(
    page.getByRole("button", { name: "Nadiktovat změnu úkolu" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Nadiktovat změnu úkolu" }).click();
  const undoTaskSocket = await mock.nextSocket();
  await sendCommitted(
    undoTaskSocket,
    "Zruš označení úkolu Napsat testy.",
    "task-unmark",
  );

  await expect(page.getByTestId("proposal-preview")).toBeVisible();
  await page.getByRole("button", { name: "Potvrdit" }).click();

  await expect
    .poll(async () => (await currentNote(request, noteId)).contentMd, {
      timeout: 15_000,
    })
    .toBe(
      [
        "- [ ] Koupit mléko",
        "- [x] Koupit mléko",
        "- [ ] Napsat testy",
      ].join("\n"),
    );
});

test("voice task command ignores fenced code and leaves the note unchanged", async ({
  page,
  request,
}) => {
  const title = `Kódový úkol E2E ${Date.now()}`;
  const original = ["```", "- [ ] Kódový úkol", "```"].join("\n");
  const noteId = await createNote(page, title, original);

  await installTokenMock(page);
  const mock = await installScribeMock(page);

  await page.getByRole("button", { name: "Nadiktovat změnu úkolu" }).click();
  const socket = await mock.nextSocket();
  await sendCommitted(
    socket,
    "Označ úkol Kódový úkol jako hotový.",
    "task-fenced",
  );

  await expect(
    page.getByText("Úkol se nepodařilo jednoznačně najít."),
  ).toBeVisible();
  expect((await currentNote(request, noteId)).version).toBe(1);
  expect(await revisionCount(noteId)).toBe(1);
});

test("vytvoř seznam úkolů starts a dictated checklist", async ({ page }) => {
  const title = `Seznam úkolů E2E ${Date.now()}`;
  const noteId = await createNote(page, title, "Úvod.");

  await installTokenMock(page);
  const mock = await installScribeMock(page);

  await page.getByRole("checkbox", { name: "Vložit na konec" }).check();
  await page.getByRole("button", { name: "Diktovat text" }).click();
  const socket = await mock.nextSocket();
  await sendCommitted(socket, "Vytvoř seznam úkolů.", "task-list-start");
  await sendCommitted(socket, "Připravit migrace.", "task-list-item");
  await sendCommitted(socket, "Konec úkolů.", "task-list-end");

  const source = page.getByLabel("Obsah (Markdown)");
  await expect
    .poll(async () => source.inputValue(), { timeout: 15_000 })
    .toBe("Úvod.\n\n- [ ] Připravit migrace");

  await sendCommitted(socket, "Stop.", "task-list-stop");
  await expect(page.getByRole("button", { name: "Diktovat text" })).toBeEnabled({
    timeout: 5_000,
  });
  await expect(page.getByRole("status")).toContainText(
    /(?:Hlasový přepis uložen|Uloženo) · verze/,
  );

  expect((await currentNote(page.request, noteId)).contentMd).toContain(
    "- [ ] Připravit migrace",
  );
});
