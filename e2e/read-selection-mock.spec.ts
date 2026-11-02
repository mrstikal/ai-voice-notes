import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { Pool } from "pg";

import {
  assertTestDatabaseTargets,
  loadTestEnvironment,
} from "../scripts/test-db-guard";
import { createNoteViaApi } from "./helpers/create-note";

test.setTimeout(120_000);

let createdNoteId: string | undefined;
let cachedTestDatabaseUrl: string | undefined;

const paragraphs = [
  "První odstavec o migraci.",
  "Druhý odstavec o testování.",
  "Třetí odstavec o nasazení.",
];
const content = `${paragraphs.join("\n\n")}\n\n- [ ] Koupit mléko\n- [x] Zavolat lékaři`;

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

async function createNote(page: Page, title: string): Promise<string> {
  const noteId = await createNoteViaApi(page, title, content);

  createdNoteId = noteId;
  return noteId;
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

function silentWav(): Buffer {
  const sampleRate = 8_000;
  const samples = 80;
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

interface TtsBody {
  readonly noteId: string;
  readonly voice: string;
  readonly scope:
    | "full"
    | "range"
    | "paragraph"
    | "tasks"
    | "last_paragraphs";
  readonly start?: number;
  readonly end?: number;
  readonly paragraphIndex?: number;
  readonly listIndex?: number;
  readonly paragraphCount?: number;
  readonly sectionIndex?: number;
}

async function installTtsMock(page: Page, noteId: string) {
  const requests: TtsBody[] = [];

  await page.route("**/api/tts", async (route) => {
    const body = route.request().postDataJSON() as TtsBody;
    requests.push(body);

    if (body.sectionIndex === undefined) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          noteId,
          noteVersion: 1,
          sourceHash: "c".repeat(64),
          voice: body.voice,
          model: "elevenlabs/eleven-v4-turbo",
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
            ...(body.paragraphCount === undefined
              ? {}
              : { paragraphCount: body.paragraphCount }),
          },
          cacheHit: false,
          estimatedMaxCostUsd: "0.140000",
          sections: [
            {
              index: 0,
              text: body.scope === "tasks" ? "Koupit mléko" : "Vybraný text.",
              start: 0,
              end: 12,
              cacheKey: "e2e-p32",
              cached: false,
            },
          ],
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      headers: { "content-type": "audio/wav", "x-tts-cache": "miss" },
      body: silentWav(),
    });
  });

  return { requests };
}

async function installScribeMock(page: Page) {
  const pending: WebSocketRoute[] = [];
  const resolvers: ((socket: WebSocketRoute) => void)[] = [];

  await page.route("**/api/elevenlabs/scribe-token", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: "sutkn_e2e_p32" }),
    });
  });

  await page.routeWebSocket(
    /api\.elevenlabs\.io\/v1\/speech-to-text\/realtime/,
    (socket) => {
      socket.send(
        JSON.stringify({
          message_type: "session_started",
          session_id: "p32-session",
        }),
      );
      const resolver = resolvers.shift();

      if (resolver) {
        resolver(socket);
      } else {
        pending.push(socket);
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

function sendCommitted(socket: WebSocketRoute, text: string, id: string) {
  socket.send(
    JSON.stringify({
      message_type: "committed_transcript",
      id,
      text,
    }),
  );
}

test("voice read commands select exact last-two-paragraph and task ranges without note mutation", async ({
  page,
  request,
}) => {
  const title = `Čtení hlasem E2E ${Date.now()}`;
  const noteId = await createNote(page, title);
  const tts = await installTtsMock(page, noteId);
  const scribe = await installScribeMock(page);

  await page.getByTestId("tts-voice-command").click();
  await page.getByTestId("tts-voice-start").click();
  const firstSocket = await scribe.nextSocket();
  sendCommitted(
    firstSocket,
    "Přečíst poslední dva odstavce.",
    "read-last-two",
  );

  await expect
    .poll(() => tts.requests.length, { timeout: 15_000 })
    .toBe(1);
  expect(tts.requests[0]).toMatchObject({
    scope: "last_paragraphs",
    paragraphCount: 2,
    voice: "sarah",
  });
  await expect(page.getByTestId("tts-section-list")).toBeVisible();
  await expect(page.getByText(/Připraveno:/)).toBeVisible();

  await expect(page.getByTestId("tts-voice-command")).toBeEnabled();
  await page.getByTestId("tts-voice-command").click();
  await page.getByTestId("tts-voice-start").click();
  const secondSocket = await scribe.nextSocket();
  sendCommitted(secondSocket, "Přečíst úkoly.", "read-tasks");

  await expect
    .poll(() => tts.requests.length, { timeout: 15_000 })
    .toBe(2);
  expect(tts.requests[1]).toMatchObject({ scope: "tasks" });

  expect((await request.get(`/api/notes/${noteId}`)).ok()).toBe(true);
  expect(await revisionCount(noteId)).toBe(1);
});

test("voice summary without a P29 artifact asks for the explicit action instead of generating", async ({
  page,
}) => {
  const title = `Shrnutí hlasem E2E ${Date.now()}`;
  await createNote(page, title);
  const scribe = await installScribeMock(page);

  await page.getByTestId("tts-voice-command").click();
  await page.getByTestId("tts-voice-start").click();
  const socket = await scribe.nextSocket();
  sendCommitted(socket, "Přečíst shrnutí.", "read-summary-missing");

  await expect(page.getByText(/Shrnutí ještě není vytvořené/)).toBeVisible();
  await expect(page.getByTestId("summary-artifact")).toHaveCount(0);
  await expect(page.getByTestId("summary-generate")).toBeVisible();
});
