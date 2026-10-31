import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { Pool } from "pg";

import {
  assertTestDatabaseTargets,
  loadTestEnvironment,
} from "../scripts/test-db-guard";
import {
  CONTENT_MAX_GRAPHEMES,
  countGraphemes,
} from "../src/lib/notes/limits";
import { parseNoteMarkdown } from "../src/lib/notes/markdown";

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

const LIMIT_LABEL = CONTENT_MAX_GRAPHEMES.toLocaleString("cs-CZ");

const scriptASegments = [
  "Nadpis.",
  "Plán migrace.",
  "Nový odstavec.",
  "V první fázi ověříme databázi.",
  "Nový odstavec.",
  "Tučně.",
  "Pozor na kompatibilitu API.",
  "Konec tučně.",
  "Začni úkoly.",
  "Připravit migrace.",
  "Další úkol.",
  "Napsat testy.",
  "Konec úkolů.",
] as const;

const scriptAExpected = [
  "Ruční text.",
  "",
  "## Plán migrace",
  "",
  "V první fázi ověříme databázi.",
  "",
  "**Pozor na kompatibilitu API.**",
  "",
  "- [ ] Připravit migrace",
  "- [ ] Napsat testy",
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

async function deleteNoteRow(noteId: string): Promise<void> {
  const pool = new Pool({ connectionString: testDatabaseUrl() });

  try {
    const result = await pool.query("delete from notes where id = $1", [
      noteId,
    ]);
    expect(result.rowCount).toBe(1);
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
  await deleteNoteRow(noteId);
});

async function waitForDictationIdle(page: Page): Promise<void> {
  await expect(
    page.getByRole("button", { name: "Diktovat text" }),
  ).toBeEnabled({ timeout: 5_000 });
}

async function createNote(
  page: Page,
  title: string,
  content: string,
): Promise<string> {
  await page.goto("/notes");
  await page.getByLabel("Název").fill(title);
  await page.getByLabel("Obsah").fill(content);
  await page.getByRole("button", { name: "Vytvořit poznámku" }).click();
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]+$/);

  const noteId = page.url().split("/").pop();

  if (!noteId) {
    throw new Error("ID vytvořené poznámky se nepodařilo zjistit.");
  }

  createdNoteId = noteId;
  return noteId;
}

async function installTokenMock(page: Page): Promise<void> {
  await page.route("**/api/elevenlabs/scribe-token", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: "sutkn_e2e_formatting" }),
    });
  });
}

interface ScribeMock {
  readonly socket: Promise<WebSocketRoute>;
  readonly urls: string[];
}

async function installScribeMock(
  page: Page,
  options: {
    readonly commitResponse?: "empty" | "none";
  } = {},
): Promise<ScribeMock> {
  const commitResponse = options.commitResponse ?? "empty";
  const urls: string[] = [];
  let resolveSocket!: (socket: WebSocketRoute) => void;
  const socket = new Promise<WebSocketRoute>((resolve) => {
    resolveSocket = resolve;
  });

  await page.routeWebSocket(
    /api\.elevenlabs\.io\/v1\/speech-to-text\/realtime/,
    (webSocket) => {
      urls.push(webSocket.url());
      webSocket.send(
        JSON.stringify({
          message_type: "session_started",
          session_id: "mock-scribe-session",
        }),
      );
      webSocket.onMessage((message) => {
        try {
          const data = JSON.parse(String(message)) as {
            message_type?: string;
            commit?: boolean;
          };

          if (
            commitResponse === "empty" &&
            data.message_type === "input_audio_chunk" &&
            data.commit
          ) {
            webSocket.send(
              JSON.stringify({
                message_type: "committed_transcript",
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

  return { socket, urls };
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

test("Script A saves Markdown and tasks, keeps an embedded stop word, and uses the selected VAD", async ({
  page,
  request,
}) => {
  const title = `Formátování E2E ${Date.now()}`;
  const noteId = await createNote(page, title, "Ruční text.");
  const source = page.getByLabel("Obsah (Markdown)");
  await page.getByTestId("vad-silence-select").selectOption("1.5");
  await page.getByRole("checkbox", { name: "Vložit na konec" }).check();

  await installTokenMock(page);
  const mock = await installScribeMock(page);
  await page.getByRole("button", { name: "Diktovat text" }).click();
  const socket = await mock.socket;
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.waitForTimeout(200);

  expect(mock.urls[0]).toContain("vad_silence_threshold_secs=1.5");

  const partial = "Příliš žluťoučký kůň 🐎";
  socket.send(
    JSON.stringify({ message_type: "partial_transcript", text: partial }),
  );
  await expect(page.getByTestId("body-partial")).toHaveText(partial);
  expect(await source.inputValue()).toBe("Ruční text.");

  const approximate = parseNoteMarkdown("Ruční text.").graphemeCount +
    countGraphemes(partial);
  await expect(page.getByTestId("voice-approximate-count")).toContainText(
    `Přibližně ${approximate.toLocaleString("cs-CZ")} / ${LIMIT_LABEL}`,
  );

  for (const [index, segment] of scriptASegments.entries()) {
    await sendCommitted(socket, segment, `script-a-${index}`);
  }

  await expect
    .poll(async () => source.inputValue(), { timeout: 15_000 })
    .toBe(scriptAExpected);
  await expect(page.getByTestId("voice-command-feedback")).toContainText(
    "Nadpis H2: Plán migrace",
  );
  await expect(page.getByTestId("voice-command-feedback")).toContainText(
    "Konec úkolů",
  );
  await expect(page.getByTestId("voice-insert-mode")).toContainText(
    "na konec",
  );

  await sendCommitted(
    socket,
    "Slovo stop použijeme v ukázce.",
    "embedded-stop",
  );
  await expect
    .poll(async () => source.inputValue(), { timeout: 15_000 })
    .toContain("Slovo stop použijeme v ukázce.");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  await sendCommitted(socket, "Stop.", "standalone-stop");
  await waitForDictationIdle(page);
  const afterStop = await source.inputValue();
  expect(afterStop).not.toContain("Stop.");

  try {
    await sendCommitted(socket, "Pozdní věta.", "late");
  } catch {
    // The socket may already be closed; the assertion below covers the note.
  }

  await page.waitForTimeout(300);
  expect(await source.inputValue()).toBe(afterStop);

  await expect(page.getByRole("status")).toContainText(
    /(?:Hlasový přepis uložen|Uloženo) · verze/,
  );
  const saved = (await (
    await request.get(`/api/notes/${noteId}`)
  ).json()) as { contentMd: string };
  expect(saved.contentMd).toBe(afterStop);
  expect(saved.contentMd).toContain("## Plán migrace");
  expect(saved.contentMd).toContain("- [ ] Připravit migrace");
  expect(saved.contentMd).toContain("- [ ] Napsat testy");

  const savedCount = parseNoteMarkdown(saved.contentMd).graphemeCount;
  await expect(page.getByTestId("note-grapheme-counter")).toContainText(
    `${savedCount.toLocaleString("cs-CZ")} / ${LIMIT_LABEL}`,
  );

  await page.reload();
  expect(await page.getByLabel("Obsah (Markdown)").inputValue()).toBe(
    afterStop,
  );
});

test("voice insert over the limit is rejected and preserves earlier content", async ({
  page,
  request,
}) => {
  const title = `Formátování limit E2E ${Date.now()}`;
  const initial = "a".repeat(CONTENT_MAX_GRAPHEMES - 10);
  const noteId = await createNote(page, title, initial);
  const source = page.getByLabel("Obsah (Markdown)");
  await page.getByRole("checkbox", { name: "Vložit na konec" }).check();

  await installTokenMock(page);
  const mock = await installScribeMock(page);
  await page.getByRole("button", { name: "Diktovat text" }).click();
  const socket = await mock.socket;
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  await sendCommitted(socket, "b".repeat(20), "over-limit");

  await expect(
    page.getByText(/Diktovaný text by překročil limit/),
  ).toContainText(
    `Diktovaný text by překročil limit ${LIMIT_LABEL} viditelných znaků`,
  );
  expect(await source.inputValue()).toBe(initial);
  await waitForDictationIdle(page);

  await page.waitForTimeout(1_000);
  const saved = (await (
    await request.get(`/api/notes/${noteId}`)
  ).json()) as { contentMd: string };
  expect(saved.contentMd).toBe(initial);
});

test("lost connection requires a manual Start and increments the reconnect counter", async ({
  page,
}) => {
  const title = `Formátování reconnect E2E ${Date.now()}`;
  await createNote(page, title, "Ruční text.");

  await installTokenMock(page);
  const mock = await installScribeMock(page);
  await page.getByRole("button", { name: "Diktovat text" }).click();
  const socket = await mock.socket;
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.getByText("Stav: Poslouchám…")).toBeVisible();
  await page.waitForTimeout(200);

  await socket.close();
  await expect(page.getByText(/Spojení se přerušilo/)).toBeVisible();
  await expect(page.getByTestId("voice-diagnostics")).toContainText(
    "ruční reconnecty (všechna diktování) 0",
  );

  await page.waitForTimeout(500);
  expect(mock.urls).toHaveLength(1);

  await page.getByRole("button", { name: "Diktovat text" }).click();
  await expect.poll(() => mock.urls.length, { timeout: 10_000 }).toBe(2);
  await expect(page.getByTestId("voice-diagnostics")).toContainText(
    "ruční reconnecty (všechna diktování) 1",
  );
});

test("visual mode applies formatting commands as Markdown at the end", async ({
  page,
}) => {
  const title = `Formátování vizuální E2E ${Date.now()}`;
  await createNote(page, title, "Ruční text.");
  await page.getByRole("button", { name: "Vizuální režim" }).click();
  const visual = page.getByRole("textbox", {
    name: "Vizuální editor poznámky",
  });
  await expect(visual).toBeVisible();

  await installTokenMock(page);
  const mock = await installScribeMock(page);
  await page.getByRole("button", { name: "Diktovat text" }).click();
  const socket = await mock.socket;
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  await sendCommitted(
    socket,
    "Nadpis. Plán migrace. Nový odstavec. Text. Začni úkoly. Připravit migrace. Další úkol. Napsat testy. Konec úkolů.",
    "visual-formatting",
  );

  await expect
    .poll(async () => visual.textContent(), { timeout: 15_000 })
    .toContain("Plán migrace");
  await expect
    .poll(async () => visual.textContent(), { timeout: 15_000 })
    .toContain("Připravit migrace");
  await expect(page.getByText(/vkládají na konec poznámky/)).toBeVisible();

  await page.getByRole("button", { name: "Stop" }).click();
  await waitForDictationIdle(page);
  await page.getByRole("button", { name: "Zdrojový režim" }).click();
  const source = page.getByLabel("Obsah (Markdown)");
  await expect
    .poll(async () => source.inputValue(), { timeout: 15_000 })
    .toContain("## Plán migrace");
  expect(await source.inputValue()).toContain("- [ ] Připravit migrace");
  expect(await source.inputValue()).toContain("- [ ] Napsat testy");
});
