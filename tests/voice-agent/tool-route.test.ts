import { describe, expect, it } from "vitest";

import type { NoteDetailDto } from "../../src/lib/notes/service";
import type { SearchResult } from "../../src/lib/search/fts";
import { createReadServices } from "../../src/lib/voice-agent/read-services";
import {
  ToolSessionStore,
} from "../../src/lib/voice-agent/tool-dispatch";
import {
  createVoiceAgentToolRouteHandler,
} from "../../src/app/api/voice-agent/tool/route";

const APP_ORIGIN = "http://127.0.0.1:3000";
const NOW = Date.parse("2026-10-30T12:00:00Z");

function note(id: string, title: string, content: string): NoteDetailDto {
  return {
    category: null,
    contentMd: content,
    contentPlain: content,
    createdAt: new Date(NOW),
    deletedAt: null,
    id,
    tags: [],
    title,
    updatedAt: new Date(NOW),
    version: 1,
  };
}

function searchResult(): SearchResult {
  return {
    empty: false,
    hasNext: false,
    items: [
      {
        category: null,
        id: "note-a",
        snippet: "[[[ahoj]]] světe",
        tags: [],
        title: "První",
        updatedAt: new Date(NOW),
      },
    ],
    page: 1,
    pageSize: 10,
    query: "ahoj",
    total: 1,
  };
}

function setup() {
  const store = new ToolSessionStore(
    createReadServices({
      getNote: async (noteId) => note(noteId, "První", "Ahoj světe."),
      searchNotes: async () => searchResult(),
    }),
    () => NOW,
  );
  const session = store.createSession({
    expiresAt: new Date(NOW + 60_000),
  });
  const route = createVoiceAgentToolRouteHandler({
    rateLimit: { limit: 20, windowMs: 60_000 },
    store,
  });

  return { route, session, store };
}

function request(
  body: unknown,
  options: {
    readonly contentType?: string;
    readonly host?: string;
    readonly method?: string;
    readonly origin?: string;
  } = {},
): Request {
  return new Request(`${APP_ORIGIN}/api/voice-agent/tool`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": options.contentType ?? "application/json",
      host: options.host ?? "127.0.0.1:3000",
      origin: options.origin ?? APP_ORIGIN,
    },
    method: options.method ?? "POST",
  });
}

describe("POST /api/voice-agent/tool", () => {
  it("runs a session-bound search, selection and read", async () => {
    const { route, session } = setup();

    const search = await route(
      request({
        action: "call",
        arguments: { query: "ahoj" },
        callId: "call-1",
        name: "search_notes",
        sessionId: session.sessionId,
        turnId: "turn-1",
      }),
    );
    expect(search.status).toBe(200);
    await expect(search.json()).resolves.toMatchObject({
      callId: "call-1",
      name: "search_notes",
      ok: true,
      response: {
        results: [{ noteId: "note-a", title: "První" }],
      },
    });

    const select = await route(
      request({
        action: "select",
        noteId: "note-a",
        sessionId: session.sessionId,
      }),
    );
    expect(select.status).toBe(200);
    await expect(select.json()).resolves.toMatchObject({
      ok: true,
      selected: { noteId: "note-a", title: "První", version: 1 },
    });

    const read = await route(
      request({
        action: "call",
        arguments: { noteId: "note-a" },
        callId: "call-2",
        name: "get_note",
        sessionId: session.sessionId,
        turnId: "turn-1",
      }),
    );
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      ok: true,
      response: {
        content: "Ahoj světe.",
        noteId: "note-a",
        title: "První",
      },
    });
  });

  it("returns an unknown session as a 404 and ends idempotently", async () => {
    const { route, session } = setup();

    const missing = await route(
      request({
        action: "call",
        arguments: { query: "ahoj" },
        callId: "call-1",
        name: "search_notes",
        sessionId: "x".repeat(43),
        turnId: "turn-1",
      }),
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "tool_session_not_found" },
    });

    const ended = await route(
      request({ action: "end", sessionId: session.sessionId }),
    );
    expect(ended.status).toBe(200);
    await expect(ended.json()).resolves.toMatchObject({
      ended: true,
      ok: true,
    });

    const again = await route(
      request({ action: "end", sessionId: session.sessionId }),
    );
    await expect(again.json()).resolves.toMatchObject({
      ended: false,
      ok: true,
    });
  });

  it("enforces Host, Origin, content type and request shape", async () => {
    const { route, session } = setup();
    const body = {
      action: "call",
      arguments: { query: "ahoj" },
      callId: "call-1",
      name: "search_notes",
      sessionId: session.sessionId,
      turnId: "turn-1",
    };

    expect(
      (await route(request(body, { origin: "https://example.com" }))).status,
    ).toBe(403);
    expect(
      (await route(request(body, { host: "example.com" }))).status,
    ).toBe(403);
    expect(
      (await route(request(body, { contentType: "text/plain" }))).status,
    ).toBe(415);
    expect(
      (
        await route(
          new Request(`${APP_ORIGIN}/api/voice-agent/tool`, {
            headers: {
              host: "127.0.0.1:3000",
              origin: APP_ORIGIN,
            },
            method: "GET",
          }),
        )
      ).status,
    ).toBe(405);
    expect(
      (await route(request({ action: "call" }))).status,
    ).toBe(400);
  });

  it("rate-limits tool calls", async () => {
    const store = new ToolSessionStore(
      createReadServices({
        getNote: async (noteId) => note(noteId, "První", "Ahoj."),
        searchNotes: async () => searchResult(),
      }),
      () => NOW,
    );
    const session = store.createSession({
      expiresAt: new Date(NOW + 60_000),
    });
    const limited = createVoiceAgentToolRouteHandler({
      rateLimit: { limit: 1, windowMs: 60_000 },
      store,
    });
    const body = {
      action: "call",
      arguments: { query: "ahoj" },
      callId: "call-1",
      name: "search_notes",
      sessionId: session.sessionId,
      turnId: "turn-1",
    };

    expect((await limited(request(body))).status).toBe(200);
    expect((await limited(request(body))).status).toBe(429);
  });
});
