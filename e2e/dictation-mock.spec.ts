import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { Pool } from "pg";

import {
  assertTestDatabaseTargets,
  loadTestEnvironment,
} from "../scripts/test-db-guard";
import { createNoteViaApi } from "./helpers/create-note";

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
  const noteId = await createNoteViaApi(page, title, content);

  createdNoteId = noteId;
  return noteId;
}

async function installScribeMock(
  page: Page,
  options: {
    readonly commitResponse?: "text" | "empty" | "none";
  } = {},
): Promise<{
  readonly socket: Promise<WebSocketRoute>;
  readonly commitResponses: string[];
}> {
  const commitResponse = options.commitResponse ?? "text";
  let resolveSocket!: (socket: WebSocketRoute) => void;
  const socket = new Promise<WebSocketRoute>((resolve) => {
    resolveSocket = resolve;
  });
  const commitResponses: string[] = [];

  await page.routeWebSocket(
    /api\.elevenlabs\.io\/v1\/speech-to-text\/realtime/,
    (webSocket) => {
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
            commitResponse !== "none" &&
            data.message_type === "input_audio_chunk" &&
            data.commit
          ) {
            const text = commitResponse === "empty" ? "" : "Poslední věta.";
            commitResponses.push(text);
            webSocket.send(
              JSON.stringify({
                message_type: "committed_transcript",
                ...(text === "" ? {} : { id: "segment-final" }),
                text,
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

  return { socket, commitResponses };
}

test("partials are overlay-only, duplicate ids are ignored, identical commits survive, and stop flushes the final segment", async ({
  page,
  request,
}) => {
  const title = `Diktování E2E ${Date.now()}`;
  const noteId = await createNote(page, title, "Ruční text.");
  const source = page.getByLabel("Obsah (Markdown)");
  await source.click();
  await source.press("End");

  const mock = await installScribeMock(page);
  await page.getByRole("button", { name: "Diktovat text" }).click();
  const socket = await mock.socket;
  await expect(
    page.getByRole("button", { name: "Stop" }),
  ).toBeVisible();
  await page.waitForTimeout(200);

  for (const partial of ["První", "První věta", "První věta."]) {
    socket.send(
      JSON.stringify({
        message_type: "partial_transcript",
        text: partial,
      }),
    );
    await expect(page.getByTestId("body-partial")).toHaveText(partial);
    expect(await source.inputValue()).toBe("Ruční text.");
    const unchanged = (await (
      await request.get(`/api/notes/${noteId}`)
    ).json()) as { contentMd: string };
    expect(unchanged.contentMd).toBe("Ruční text.");
  }

  for (const [id, text] of [
    ["segment-1", "První věta."],
    ["segment-1", "První věta."],
    ["segment-2", "První věta."],
    [null, "Druhá věta."],
  ] as const) {
    socket.send(
      JSON.stringify({
        message_type: "committed_transcript",
        ...(id === null ? {} : { id }),
        text,
      }),
    );
  }

  await expect
    .poll(async () => source.inputValue(), { timeout: 15_000 })
    .toContain("První věta. První věta. Druhá věta.");
  const sourceValue = await source.inputValue();
  expect(sourceValue.match(/První věta\./g) ?? []).toHaveLength(2);
  expect(sourceValue.match(/Druhá věta\./g) ?? []).toHaveLength(1);

  await expect(page.getByRole("status")).toContainText(/Uloženo · verze/);
  const saved = (await (
    await request.get(`/api/notes/${noteId}`)
  ).json()) as { contentMd: string };
  expect(saved.contentMd).toBe(sourceValue);

  await page.getByRole("button", { name: "Stop" }).click();
  await expect
    .poll(async () => source.inputValue(), { timeout: 15_000 })
    .toContain("Poslední věta.");
  expect(mock.commitResponses).toEqual(["Poslední věta."]);
  await waitForDictationIdle(page);

  try {
    socket.send(
      JSON.stringify({
        message_type: "committed_transcript",
        id: "segment-late",
        text: "Pozdní věta.",
      }),
    );
  } catch {
    // The socket may already be closed; the assertion below covers the note.
  }

  await page.waitForTimeout(300);
  expect(await source.inputValue()).not.toContain("Pozdní věta.");

  await expect
    .poll(
      async () =>
        (
          (await (await request.get(`/api/notes/${noteId}`)).json()) as {
            contentMd: string;
          }
        ).contentMd,
      { timeout: 15_000 },
    )
    .toContain("Poslední věta.");

  await page.reload();
  const reloadedSource = page.getByLabel("Obsah (Markdown)");
  expect(await reloadedSource.inputValue()).toContain(
    "První věta. První věta. Druhá věta.",
  );
  expect(await reloadedSource.inputValue()).toContain("Poslední věta.");
});

test("provider errors do not erase manual edits", async ({ page }) => {
  const title = `Diktování chyba E2E ${Date.now()}`;
  await createNote(page, title, "Ruční text.");
  const source = page.getByLabel("Obsah (Markdown)");
  await source.click();
  await source.press("End");
  await source.pressSequentially(" Ruční úprava.");

  const mock = await installScribeMock(page);
  await page.getByRole("button", { name: "Diktovat text" }).click();
  const socket = await mock.socket;
  await expect(
    page.getByRole("button", { name: "Stop" }),
  ).toBeVisible();
  await page.waitForTimeout(200);

  socket.send(
    JSON.stringify({
      message_type: "transcriber_error",
      error: "mock transcriber failure",
    }),
  );

  await expect(
    page.getByText(/Přepisovač ElevenLabs hlásí chybu/),
  ).toBeVisible();
  expect(await source.inputValue()).toContain("Ruční úprava.");
  expect(await source.inputValue()).toContain("Ruční text.");
});

test("explicit end mode appends at the end and warns when the final provider event is missing", async ({
  page,
  request,
}) => {
  const title = `Diktování konec E2E ${Date.now()}`;
  await createNote(page, title, "Začátek konec.");
  const source = page.getByLabel("Obsah (Markdown)");
  await source.click();
  await source.press("Home");

  const mock = await installScribeMock(page, { commitResponse: "none" });
  await page.getByRole("checkbox", { name: "Vložit na konec" }).check();
  await page.getByRole("button", { name: "Diktovat text" }).click();
  const socket = await mock.socket;
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.waitForTimeout(200);

  socket.send(
    JSON.stringify({
      message_type: "committed_transcript",
      id: "segment-end",
      text: "Přidaný konec.",
    }),
  );

  await expect
    .poll(async () => source.inputValue(), { timeout: 15_000 })
    .toContain("Začátek konec. Přidaný konec.");
  expect((await source.inputValue()).startsWith("Začátek konec.")).toBe(true);
  const noteId = createdNoteId!;

  await expect
    .poll(
      async () =>
        (
          (await (await request.get(`/api/notes/${noteId}`)).json()) as {
            contentMd: string;
          }
        ).contentMd,
      { timeout: 15_000 },
    )
    .toContain("Přidaný konec.");

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(
    page.getByText(/Poslední promluva se nemusela dokončit/),
  ).toBeVisible({ timeout: 10_000 });
  expect(mock.commitResponses).toHaveLength(0);
});

test("visual mode inserts dictated HTML-like text literally", async ({
  page,
}) => {
  const title = `Diktování vizuální E2E ${Date.now()}`;
  await createNote(page, title, "Ruční text.");
  await page.getByRole("button", { name: "Vizuální režim" }).click();
  const visual = page.getByRole("textbox", {
    name: "Vizuální editor poznámky",
  });
  await expect(visual).toBeVisible();

  const mock = await installScribeMock(page);
  await page.getByRole("button", { name: "Diktovat text" }).click();
  const socket = await mock.socket;
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.waitForTimeout(200);

  socket.send(
    JSON.stringify({
      message_type: "committed_transcript",
      id: "segment-html",
      text: "<b>ahoj</b>",
    }),
  );

  await expect
    .poll(async () => visual.textContent(), { timeout: 15_000 })
    .toContain("<b>ahoj</b>");
  expect(await visual.innerHTML()).not.toContain("<strong>");

  await page.getByRole("button", { name: "Stop" }).click();
  await waitForDictationIdle(page);
  await page.getByRole("button", { name: "Zdrojový režim" }).click();
  const source = page.getByLabel("Obsah (Markdown)");
  await expect
    .poll(async () => source.inputValue(), { timeout: 15_000 })
    .toContain("ahoj");
  expect(await source.inputValue()).not.toContain("<strong>ahoj</strong>");
});

test("visual end mode appends literal text at the end", async ({ page }) => {
  const title = `Diktování vizuální konec E2E ${Date.now()}`;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await createNote(page, title, "Začátek konec.");
  await page.getByRole("button", { name: "Vizuální režim" }).click();
  const visual = page.getByRole("textbox", {
    name: "Vizuální editor poznámky",
  });
  await expect(visual).toBeVisible();
  await page.getByRole("checkbox", { name: "Vložit na konec" }).check();

  const mock = await installScribeMock(page, { commitResponse: "empty" });
  await page.getByRole("button", { name: "Diktovat text" }).click();
  const socket = await mock.socket;
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.waitForTimeout(200);

  socket.send(
    JSON.stringify({
      message_type: "committed_transcript",
      id: "segment-visual-end",
      text: "<i>konec</i>",
    }),
  );

  await expect
    .poll(async () => visual.textContent(), { timeout: 15_000 })
    .toContain("Začátek konec. <i>konec</i>");
  expect(await visual.innerHTML()).not.toContain("<em>");

  await page.getByRole("button", { name: "Stop" }).click();
  await waitForDictationIdle(page);
  await expect(
    page.getByText(/Poslední promluva se nemusela dokončit/),
  ).toHaveCount(0);
  expect(mock.commitResponses).toEqual([""]);
  await page.getByRole("button", { name: "Zdrojový režim" }).click();
  const source = page.getByLabel("Obsah (Markdown)");
  await expect
    .poll(async () => source.inputValue(), { timeout: 15_000 })
    .toContain("konec");
  expect(await source.inputValue()).not.toContain("<em>konec</em>");
  expect(pageErrors).toEqual([]);
});
