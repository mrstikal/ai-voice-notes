import { describe, expect, it, vi } from "vitest";

import type { NoteDetailDto } from "../../src/lib/notes/service";
import { parseNoteMarkdown } from "../../src/lib/notes/markdown";
import { hashNoteSource } from "../../src/lib/notes/operations";
import {
  EditProposalAlreadyAppliedError,
  EditProposalStaleError,
  PROPOSAL_EXPIRY_MS,
  type CreatedEditProposalDto,
  type EditProposalDto,
  type EditProposalStatus,
} from "../../src/lib/notes/proposals";
import type { SearchResult } from "../../src/lib/search/fts";
import { createReadServices } from "../../src/lib/voice-agent/read-services";
import {
  ToolSessionStore,
  type ToolSessionHandle,
} from "../../src/lib/voice-agent/tool-dispatch";
import { createVoiceAgentConfirmRouteHandler } from "../../src/app/api/voice-agent/confirm/route";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const CONTENT = "Ahoj světe.";
const NONCE = "n".repeat(43);
const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "note-a";
const SESSION_ID = "s".repeat(43);
const APP_ORIGIN = "http://127.0.0.1:3000";

function note(version = 1): NoteDetailDto {
  return {
    category: null,
    contentMd: CONTENT,
    contentPlain: parseNoteMarkdown(CONTENT).plainText,
    createdAt: new Date(NOW),
    deletedAt: null,
    id: NOTE_ID,
    tags: [],
    title: "První",
    updatedAt: new Date(NOW),
    version,
  };
}

function searchResult(): SearchResult {
  return {
    empty: false,
    hasNext: false,
    items: [
      {
        category: null,
        id: NOTE_ID,
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

function proposal(
  status: EditProposalStatus = "pending",
): EditProposalDto {
  return {
    afterMd: "Nový text.",
    beforeMd: CONTENT,
    createdAt: new Date(NOW),
    diff: {
      end: CONTENT.length,
      inserted: "Nový text.",
      prefix: "",
      removed: CONTENT,
      start: 0,
      suffix: "",
    },
    expectedVersion: 1,
    expiresAt: new Date(NOW + PROPOSAL_EXPIRY_MS),
    id: PROPOSAL_ID,
    noteId: NOTE_ID,
    noteTitle: "První",
    operation: { text: "Nový text.", type: "replace_last_sentence" },
    originalHash: hashNoteSource(CONTENT),
    selectedCandidate: null,
    status,
    updatedAt: new Date(NOW),
  };
}

function created(): CreatedEditProposalDto {
  return { ...proposal(), confirmationNonce: NONCE };
}

interface Harness {
  readonly store: ToolSessionStore;
  readonly session: ToolSessionHandle;
  readonly confirm: ReturnType<typeof vi.fn>;
  readonly reject: ReturnType<typeof vi.fn>;
  readonly notes: Map<string, NoteDetailDto>;
  readonly setNow: (value: number) => void;
}

function harness(options: {
  readonly confirmImpl?: () => Promise<{
    readonly proposal: EditProposalDto;
    readonly note: NoteDetailDto;
  }>;
} = {}): Harness {
  const notes = new Map([[NOTE_ID, note()]]);
  let now = NOW;
  const confirm = vi.fn(
    options.confirmImpl ??
      (async () => ({ note: note(2), proposal: proposal("applied") })),
  );
  const reject = vi.fn(async () => proposal("rejected"));
  const services = createReadServices({
    getNote: async (noteId) => {
      const value = notes.get(noteId);

      if (!value) {
        throw new Error("missing");
      }

      return value;
    },
    searchNotes: async () => searchResult(),
  });
  const store = new ToolSessionStore(
    services,
    () => now,
    async () => ({ sourceGraphemes: 1, summaryText: "Shrnutí." }),
    () => ({
      confirm,
      createForSession: async () => created(),
      getForOwner: async () => proposal(),
      reject,
    }),
  );
  const session = store.createSession({
    expiresAt: new Date(NOW + 10 * 60_000),
  });

  return {
    confirm: confirm as ReturnType<typeof vi.fn>,
    notes,
    reject: reject as ReturnType<typeof vi.fn>,
    session,
    setNow: (value) => {
      now = value;
    },
    store,
  };
}

async function prepare(current: Harness): Promise<void> {
  await current.store.dispatch({
    arguments: { query: "ahoj" },
    callId: "search",
    name: "search_notes",
    sessionId: current.session.sessionId,
    turnId: "turn-search",
  });
  await current.store.selectNote(current.session.sessionId, NOTE_ID);
  await current.store.dispatch({
    arguments: { noteId: NOTE_ID, text: "Koupit mléko" },
    callId: "add-todo",
    name: "add_todo",
    sessionId: current.session.sessionId,
    turnId: "turn-add",
  });
}

function request(
  body: unknown,
  options: { readonly origin?: string } = {},
): Request {
  return new Request(`${APP_ORIGIN}/api/voice-agent/confirm`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      origin: options.origin ?? APP_ORIGIN,
    },
    method: "POST",
  });
}

describe("P50 on-screen confirmation", () => {
  it("applies once through P24 with the server-held nonce and version", async () => {
    const current = harness();
    await prepare(current);

    const result = await current.store.confirmProposal(
      current.session.sessionId,
      PROPOSAL_ID,
      NONCE,
    );

    expect(current.confirm).toHaveBeenCalledWith(NOTE_ID, PROPOSAL_ID, {
      confirmationNonce: NONCE,
      expectedVersion: 1,
    });
    expect(result.note.version).toBe(2);
    await expect(
      current.store.confirmProposal(
        current.session.sessionId,
        PROPOSAL_ID,
        NONCE,
      ),
    ).rejects.toMatchObject({ code: "proposal_not_found" });
    expect(current.confirm).toHaveBeenCalledTimes(1);
    expect(current.notes.get(NOTE_ID)?.version).toBe(1);
    expect(JSON.stringify(result)).not.toContain(NONCE);
  });

  it("keeps the selected note usable at the applied version", async () => {
    const current = harness();
    await prepare(current);

    await current.store.confirmProposal(
      current.session.sessionId,
      PROPOSAL_ID,
      NONCE,
    );
    current.notes.set(NOTE_ID, note(2));

    const read = await current.store.dispatch({
      arguments: { noteId: NOTE_ID },
      callId: "read-after-apply",
      name: "get_note",
      sessionId: current.session.sessionId,
      turnId: "turn-read",
    });
    expect(read).toMatchObject({
      ok: true,
      response: { noteId: NOTE_ID, version: 2 },
    });
  });

  it("rejects a forged nonce without applying and keeps the preview retryable", async () => {
    const current = harness();
    await prepare(current);

    await expect(
      current.store.confirmProposal(
        current.session.sessionId,
        PROPOSAL_ID,
        "x".repeat(43),
      ),
    ).rejects.toMatchObject({ code: "proposal_invalid_nonce", status: 403 });
    expect(current.confirm).not.toHaveBeenCalled();

    await expect(
      current.store.confirmProposal(
        current.session.sessionId,
        PROPOSAL_ID,
        NONCE,
      ),
    ).resolves.toBeDefined();
  });

  it("blocks a concurrent double click while P24 is running", async () => {
    let release: ((value: {
      proposal: EditProposalDto;
      note: NoteDetailDto;
    }) => void) | null = null;
    const current = harness({
      confirmImpl: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    await prepare(current);

    const first = current.store.confirmProposal(
      current.session.sessionId,
      PROPOSAL_ID,
      NONCE,
    );
    await expect(
      current.store.confirmProposal(
        current.session.sessionId,
        PROPOSAL_ID,
        NONCE,
      ),
    ).rejects.toMatchObject({ code: "confirm_in_progress", status: 409 });

    release!({ note: note(2), proposal: proposal("applied") });
    await expect(first).resolves.toBeDefined();
    expect(current.confirm).toHaveBeenCalledTimes(1);
  });

  it("reports expired, applied and stale outcomes truthfully", async () => {
    const expired = harness();
    await prepare(expired);
    expired.setNow(NOW + PROPOSAL_EXPIRY_MS + 1);
    await expect(
      expired.store.confirmProposal(
        expired.session.sessionId,
        PROPOSAL_ID,
        NONCE,
      ),
    ).rejects.toMatchObject({ code: "proposal_expired", status: 409 });
    expect(expired.confirm).not.toHaveBeenCalled();

    const applied = harness({
      confirmImpl: async () => {
        throw new EditProposalAlreadyAppliedError();
      },
    });
    await prepare(applied);
    await expect(
      applied.store.confirmProposal(
        applied.session.sessionId,
        PROPOSAL_ID,
        NONCE,
      ),
    ).rejects.toMatchObject({ code: "proposal_already_applied", status: 409 });
    await expect(
      applied.store.getPendingProposal(
        applied.session.sessionId,
        PROPOSAL_ID,
      ),
    ).rejects.toMatchObject({ code: "proposal_not_found" });

    const stale = harness({
      confirmImpl: async () => {
        throw new EditProposalStaleError("version_mismatch");
      },
    });
    await prepare(stale);
    await expect(
      stale.store.confirmProposal(
        stale.session.sessionId,
        PROPOSAL_ID,
        NONCE,
      ),
    ).rejects.toMatchObject({ code: "proposal_stale", status: 409 });
    await expect(
      stale.store.getPendingProposal(stale.session.sessionId, PROPOSAL_ID),
    ).resolves.toMatchObject({ status: "pending" });
  });

  it("invalidates the session's unconfirmed proposal on end", async () => {
    const current = harness();
    await prepare(current);

    await expect(
      current.store.endSession(current.session.sessionId),
    ).resolves.toBe(true);
    expect(current.reject).toHaveBeenCalledWith(NOTE_ID, PROPOSAL_ID);
    await expect(
      current.store.getPendingProposal(current.session.sessionId, PROPOSAL_ID),
    ).rejects.toMatchObject({ code: "tool_session_not_found" });
  });

  it("guards the confirm route by origin, session and stored nonce", async () => {
    const current = harness();
    await prepare(current);
    const handler = createVoiceAgentConfirmRouteHandler({
      rateLimit: { limit: 1_000, windowMs: 60_000 },
      store: current.store,
    });
    const body = {
      confirmationNonce: NONCE,
      proposalId: PROPOSAL_ID,
      sessionId: current.session.sessionId,
    };

    const crossOrigin = await handler(
      request(body, { origin: "http://evil.test" }),
    );
    expect(crossOrigin.status).toBe(403);

    const wrongSession = await handler(
      request({ ...body, sessionId: SESSION_ID }),
    );
    expect(wrongSession.status).toBe(404);

    const wrongNonce = await handler(
      request({ ...body, confirmationNonce: "x".repeat(43) }),
    );
    expect(wrongNonce.status).toBe(403);

    const ok = await handler(request(body));
    expect(ok.status).toBe(200);
    const payload = (await ok.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      note: { id: NOTE_ID, version: 2 },
      ok: true,
      proposal: { status: "applied" },
    });
    expect(JSON.stringify(payload)).not.toContain(NONCE);
    expect(current.confirm).toHaveBeenCalledTimes(1);

    const replay = await handler(request(body));
    expect(replay.status).toBe(404);
    expect(current.confirm).toHaveBeenCalledTimes(1);
  });
});
