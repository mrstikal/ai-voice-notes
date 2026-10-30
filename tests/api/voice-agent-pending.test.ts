import { describe, expect, it } from "vitest";

import type { NoteDetailDto } from "../../src/lib/notes/service";
import { parseNoteMarkdown } from "../../src/lib/notes/markdown";
import { hashNoteSource } from "../../src/lib/notes/operations";
import type { CreatedEditProposalDto } from "../../src/lib/notes/proposals";
import type { SearchResult } from "../../src/lib/search/fts";
import { createReadServices } from "../../src/lib/voice-agent/read-services";
import { ToolSessionStore } from "../../src/lib/voice-agent/tool-dispatch";
import { createVoiceAgentPendingRouteHandler } from "../../src/app/api/voice-agent/pending/[id]/route";

const APP_ORIGIN = "http://127.0.0.1:3000";
const NOW = Date.parse("2026-10-30T12:00:00Z");
const NONCE = "n".repeat(43);
const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";
const CONTENT = "Ahoj světe.";

function note(): NoteDetailDto {
  return {
    category: null,
    contentMd: CONTENT,
    contentPlain: parseNoteMarkdown(CONTENT).plainText,
    createdAt: new Date(NOW),
    deletedAt: null,
    id: "note-a",
    tags: [],
    title: "První",
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
        snippet: "[[[První]]]",
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

function created(): CreatedEditProposalDto {
  return {
    afterMd: `${CONTENT}\n\n- [ ] Koupit mléko`,
    beforeMd: CONTENT,
    confirmationNonce: NONCE,
    createdAt: new Date(NOW),
    diff: {
      end: CONTENT.length,
      inserted: "\n\n- [ ] Koupit mléko",
      prefix: CONTENT,
      removed: "",
      start: CONTENT.length,
      suffix: "",
    },
    expectedVersion: 1,
    expiresAt: new Date(NOW + 5 * 60_000),
    id: PROPOSAL_ID,
    noteId: "note-a",
    noteTitle: "První",
    operation: { text: "- [ ] Koupit mléko", type: "append_bounded_section" },
    originalHash: hashNoteSource(CONTENT),
    selectedCandidate: null,
    status: "pending",
    updatedAt: new Date(NOW),
  };
}

async function setup() {
  const services = createReadServices({
    getNote: async () => note(),
    searchNotes: async () => searchResult(),
  });
  const store = new ToolSessionStore(
    services,
    () => NOW,
    async () => ({ sourceGraphemes: 1, summaryText: "Shrnutí." }),
    () => ({
      createForSession: async () => created(),
      getForOwner: async () => created(),
      reject: async () => ({ ...created(), status: "rejected" }),
    }),
  );
  const session = store.createSession({ expiresAt: new Date(NOW + 60_000) });
  await store.dispatch({
    arguments: { query: "ahoj" },
    callId: "search",
    name: "search_notes",
    sessionId: session.sessionId,
    turnId: "turn-search",
  });
  await store.selectNote(session.sessionId, "note-a");
  await store.dispatch({
    arguments: { noteId: "note-a", text: "Koupit mléko" },
    callId: "add-todo",
    name: "add_todo",
    sessionId: session.sessionId,
    turnId: "turn-add",
  });

  return {
    handler: createVoiceAgentPendingRouteHandler({
      rateLimit: { limit: 1_000, windowMs: 60_000 },
      store,
    }),
    session,
    store,
  };
}

function request(
  body: unknown,
  options: { readonly origin?: string } = {},
): Request {
  return new Request(`${APP_ORIGIN}/api/voice-agent/pending/${PROPOSAL_ID}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      origin: options.origin ?? APP_ORIGIN,
    },
    method: "POST",
  });
}

function context(id = PROPOSAL_ID) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/voice-agent/pending/[id]", () => {
  it("returns the full diff and nonce only to the owning session", async () => {
    const { handler, session, store } = await setup();

    const response = await handler(
      request({ sessionId: session.sessionId }),
      context(),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      proposal: Record<string, unknown>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.proposal).toMatchObject({
      beforeMd: CONTENT,
      confirmationNonce: NONCE,
      expectedVersion: 1,
      noteTitle: "První",
      proposalId: PROPOSAL_ID,
      status: "pending",
    });
    expect(
      (payload.proposal.diff as { inserted: string }).inserted,
    ).toContain("- [ ] Koupit mléko");

    const other = store.createSession({ expiresAt: new Date(NOW + 60_000) });
    const wrongTab = await handler(
      request({ sessionId: other.sessionId }),
      context(),
    );
    expect(wrongTab.status).toBe(404);
    await expect(wrongTab.json()).resolves.toMatchObject({
      error: { code: "proposal_not_found" },
    });
  });

  it("rejects only for the owning session and then hides the proposal", async () => {
    const { handler, session, store } = await setup();
    const other = store.createSession({ expiresAt: new Date(NOW + 60_000) });

    const wrongTab = await handler(
      request({ action: "reject", sessionId: other.sessionId }),
      context(),
    );
    expect(wrongTab.status).toBe(404);

    const rejected = await handler(
      request({ action: "reject", sessionId: session.sessionId }),
      context(),
    );
    expect(rejected.status).toBe(200);
    await expect(rejected.json()).resolves.toMatchObject({
      ok: true,
      proposalId: PROPOSAL_ID,
      status: "rejected",
    });

    const gone = await handler(
      request({ sessionId: session.sessionId }),
      context(),
    );
    expect(gone.status).toBe(404);
  });

  it("rejects a wrong origin and an unknown proposal", async () => {
    const { handler, session } = await setup();

    const crossOrigin = await handler(
      request({ sessionId: session.sessionId }, { origin: "http://evil.test" }),
      context(),
    );
    expect(crossOrigin.status).toBe(403);

    const missing = await handler(
      request({ sessionId: session.sessionId }),
      context("22222222-2222-4222-8222-222222222222"),
    );
    expect(missing.status).toBe(404);
  });
});
