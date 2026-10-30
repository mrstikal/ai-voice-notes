import { describe, expect, it, vi } from "vitest";

import {
  NoteNotFoundError,
  type NoteDetailDto,
} from "../../src/lib/notes/service";
import { hashNoteSource } from "../../src/lib/notes/operations";
import { parseNoteMarkdown } from "../../src/lib/notes/markdown";
import {
  EditProposalAmbiguousError,
  EditProposalStaleError,
  PROPOSAL_EXPIRY_MS,
  type CreatedEditProposalDto,
  type EditProposalDto,
  type EditProposalStatus,
} from "../../src/lib/notes/proposals";
import type { SearchResult } from "../../src/lib/search/fts";
import { createReadServices } from "../../src/lib/voice-agent/read-services";
import {
  ToolSessionError,
  ToolSessionStore,
  type ToolSessionHandle,
  type VoiceProposalService,
} from "../../src/lib/voice-agent/tool-dispatch";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const CONTENT = "První věta. Druhá věta.";
const NONCE = "n".repeat(43);

function note(overrides: Partial<NoteDetailDto> = {}): NoteDetailDto {
  return {
    category: null,
    contentMd: CONTENT,
    contentPlain: parseNoteMarkdown(CONTENT).plainText,
    createdAt: new Date(NOW),
    deletedAt: null,
    id: "note-a",
    tags: [],
    title: "Poznámka",
    updatedAt: new Date(NOW),
    version: 1,
    ...overrides,
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
        snippet: "[[[Poznámka]]]",
        tags: [],
        title: "Poznámka",
        updatedAt: new Date(NOW),
      },
    ],
    page: 1,
    pageSize: 10,
    query: "poznámka",
    total: 1,
  };
}

function proposal(
  id: string,
  status: EditProposalStatus = "pending",
  version = 1,
): EditProposalDto {
  return {
    afterMd: `${CONTENT}\n\n- [ ] Koupit mléko`,
    beforeMd: CONTENT,
    createdAt: new Date(NOW),
    diff: {
      end: CONTENT.length,
      inserted: "\n\n- [ ] Koupit mléko",
      prefix: CONTENT,
      removed: "",
      start: CONTENT.length,
      suffix: "",
    },
    expectedVersion: version,
    expiresAt: new Date(NOW + PROPOSAL_EXPIRY_MS),
    id,
    noteId: "note-a",
    noteTitle: "Poznámka",
    operation: { text: "- [ ] Koupit mléko", type: "append_bounded_section" },
    originalHash: hashNoteSource(CONTENT),
    selectedCandidate: null,
    status,
    updatedAt: new Date(NOW),
  };
}

function created(id: string): CreatedEditProposalDto {
  return { ...proposal(id), confirmationNonce: NONCE };
}

interface Harness {
  readonly store: ToolSessionStore;
  readonly session: ToolSessionHandle;
  readonly notes: Map<string, NoteDetailDto>;
  readonly createForSession: ReturnType<typeof vi.fn>;
  readonly getForOwner: ReturnType<typeof vi.fn>;
  readonly setNow: (value: number) => void;
}

function harness(options: {
  readonly create?: VoiceProposalService["createForSession"];
  readonly get?: VoiceProposalService["getForOwner"];
} = {}): Harness {
  const notes = new Map([["note-a", note()]]);
  let now = NOW;
  let counter = 0;
  const createForSession = vi.fn(
    options.create ??
      (async (noteId, input) => {
        counter += 1;

        return {
          ...created(`proposal-${counter}`),
          noteId,
          operation: input.operation,
        };
      }),
  );
  const getForOwner = vi.fn(
    options.get ??
      (async (_noteId: string, proposalId: string) =>
        proposal(proposalId)),
  );
  const services = createReadServices({
    getNote: async (noteId) => {
      const value = notes.get(noteId);

      if (!value) {
        throw new NoteNotFoundError();
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
      createForSession,
      getForOwner,
      reject: async (_noteId: string, proposalId: string) =>
        proposal(proposalId, "rejected"),
    }),
  );
  const session = store.createSession({
    expiresAt: new Date(NOW + 10 * 60_000),
  });

  return {
    createForSession: createForSession as ReturnType<typeof vi.fn>,
    getForOwner: getForOwner as ReturnType<typeof vi.fn>,
    notes,
    session,
    setNow: (value) => {
      now = value;
    },
    store,
  };
}

async function select(current: Harness): Promise<void> {
  await current.store.dispatch({
    arguments: { query: "poznámka" },
    callId: "search",
    name: "search_notes",
    sessionId: current.session.sessionId,
    turnId: "turn-search",
  });
  await current.store.selectNote(current.session.sessionId, "note-a");
}

function call(
  current: Harness,
  name: string,
  args: unknown,
  turn = `turn-${Math.random()}`,
): ReturnType<ToolSessionStore["dispatch"]> {
  return current.store.dispatch({
    arguments: args,
    callId: `call-${Math.random()}`,
    name,
    sessionId: current.session.sessionId,
    turnId: turn,
  });
}

describe("P49 agent proposals", () => {
  it("turns add_todo into a sanitized preview without a note mutation or nonce", async () => {
    const current = harness();
    await select(current);

    const outcome = await call(current, "add_todo", {
      noteId: "note-a",
      text: "Koupit mléko",
    });

    expect(outcome.ok).toBe(true);
    const response = outcome.response as Record<string, unknown>;
    expect(response).toMatchObject({
      noteId: "note-a",
      noteTitle: "Poznámka",
      operationType: "append_bounded_section",
      proposalId: "proposal-1",
      requiresUserClick: true,
      status: "pending",
      target: "Konec poznámky",
    });
    const serialized = JSON.stringify(outcome.response);
    expect(serialized).not.toContain(NONCE);
    expect(serialized).not.toContain("confirmationNonce");
    expect(serialized).not.toContain("beforeMd");
    expect(serialized).not.toContain("afterMd");
    expect(serialized).not.toContain("diff");

    expect(current.createForSession).toHaveBeenCalledWith(
      "note-a",
      {
        expectedSourceHash: hashNoteSource(CONTENT),
        expectedVersion: 1,
        operation: {
          text: "- [ ] Koupit mléko",
          type: "append_bounded_section",
        },
      },
      current.session.sessionId,
    );
    expect(current.notes.get("note-a")?.contentMd).toBe(CONTENT);
    expect(current.notes.get("note-a")?.version).toBe(1);
  });

  it("keeps at most one unresolved proposal so repeated calls cannot orphan a preview", async () => {
    const current = harness();
    await select(current);

    const first = await call(current, "add_todo", {
      noteId: "note-a",
      text: "První úkol",
    });
    expect(first.ok).toBe(true);

    const repeated = await call(current, "add_todo", {
      noteId: "note-a",
      text: "Druhý úkol",
    });
    expect(repeated).toMatchObject({
      ok: false,
      response: { error: { code: "proposal_pending" } },
    });
    expect(current.createForSession).toHaveBeenCalledTimes(1);

    await current.store.rejectPendingProposal(
      current.session.sessionId,
      "proposal-1",
    );
    const afterReject = await call(current, "add_todo", {
      noteId: "note-a",
      text: "Druhý úkol",
    });
    expect(afterReject.ok).toBe(true);
    expect(current.createForSession).toHaveBeenCalledTimes(2);
    expect(current.notes.get("note-a")?.contentMd).toBe(CONTENT);
  });

  it("rejects model-supplied versions and clarifies ambiguous targets", async () => {
    const current = harness();
    await select(current);

    const injected = await call(current, "propose_edit", {
      noteId: "note-a",
      operation: {
        text: "Nová věta.",
        type: "replace_sentence",
        target: { endPhrase: "věta", startPhrase: "První" },
        expectedVersion: 1,
      },
    });
    expect(injected).toMatchObject({
      ok: false,
      response: { error: { code: "invalid_arguments" } },
    });

    const topLevel = await call(current, "propose_edit", {
      noteId: "note-a",
      operation: {
        text: "Nová věta.",
        type: "replace_sentence",
        target: { endPhrase: "věta", startPhrase: "První" },
      },
      expectedVersion: 1,
    });
    expect(topLevel).toMatchObject({
      ok: false,
      response: { error: { code: "invalid_arguments" } },
    });
    expect(current.createForSession).not.toHaveBeenCalled();

    const ambiguous = harness({
      create: async () => {
        throw new EditProposalAmbiguousError(
          [
            {
              blockIndex: 0,
              id: "p0:s0",
              ordinal: 1,
              sentenceIndex: 0,
              snippet: "První věta.",
              text: "První věta.",
            },
          ],
          1,
          hashNoteSource(CONTENT),
        );
      },
    });
    await select(ambiguous);
    const clarified = await call(ambiguous, "propose_edit", {
      noteId: "note-a",
      operation: {
        text: "Nová věta.",
        type: "replace_sentence",
        target: { endPhrase: "věta", startPhrase: "První" },
      },
    });
    expect(clarified).toMatchObject({
      ok: false,
      response: {
        error: {
          candidates: [{ ordinal: 1, snippet: "První věta." }],
          code: "proposal_ambiguous",
        },
      },
    });
  });

  it("rejects stale selected notes before creating a proposal", async () => {
    const current = harness();
    await select(current);
    current.notes.set("note-a", note({ version: 2 }));

    const stale = await call(current, "add_todo", {
      noteId: "note-a",
      text: "Koupit mléko",
    });
    expect(stale).toMatchObject({
      ok: false,
      response: { error: { code: "note_stale" } },
    });
    expect(current.createForSession).not.toHaveBeenCalled();

    const unselected = await call(current, "add_todo", {
      noteId: "note-a",
      text: "Koupit mléko",
    });
    expect(unselected).toMatchObject({
      ok: false,
      response: { error: { code: "note_not_selected" } },
    });
  });

  it("maps stale proposal creation to note_stale and clears the selection", async () => {
    const current = harness({
      create: async () => {
        throw new EditProposalStaleError("version_mismatch");
      },
    });
    await select(current);

    const stale = await call(current, "add_todo", {
      noteId: "note-a",
      text: "Koupit mléko",
    });
    expect(stale).toMatchObject({
      ok: false,
      response: { error: { code: "note_stale" } },
    });

    const after = await call(current, "add_todo", {
      noteId: "note-a",
      text: "Koupit mléko",
    });
    expect(after).toMatchObject({
      ok: false,
      response: { error: { code: "note_not_selected" } },
    });
  });

  it("never confirms from the model and exposes only sanitized status", async () => {
    const current = harness();
    await select(current);
    await call(current, "add_todo", {
      noteId: "note-a",
      text: "Koupit mléko",
    });

    const confirmed = await call(current, "confirm_edit", {
      proposalId: "proposal-1",
    });
    expect(confirmed).toMatchObject({
      ok: true,
      response: {
        proposalId: "proposal-1",
        requiresUserClick: true,
        status: "requires_user_click",
      },
    });
    expect(JSON.stringify(confirmed.response)).not.toContain(NONCE);

    const wrong = await call(current, "confirm_edit", {
      proposalId: "proposal-unknown",
    });
    expect(wrong).toMatchObject({
      ok: false,
      response: { error: { code: "proposal_not_found" } },
    });
  });

  it("rejects a proposal only through its owning session and frees the slot", async () => {
    const current = harness();
    await select(current);
    await call(current, "add_todo", {
      noteId: "note-a",
      text: "Koupit mléko",
    });

    const other = current.store.createSession({
      expiresAt: new Date(NOW + 10 * 60_000),
    });
    await expect(
      current.store.rejectPendingProposal(other.sessionId, "proposal-1"),
    ).rejects.toMatchObject({ code: "proposal_not_found", status: 404 });

    await expect(
      current.store.rejectPendingProposal(
        current.session.sessionId,
        "proposal-1",
      ),
    ).resolves.toMatchObject({ proposalId: "proposal-1", status: "rejected" });
    await expect(
      current.store.getPendingProposal(
        current.session.sessionId,
        "proposal-1",
      ),
    ).rejects.toMatchObject({ code: "proposal_not_found" });

    const afterReject = await call(current, "add_todo", {
      noteId: "note-a",
      text: "Další úkol",
    });
    expect(afterReject.ok).toBe(true);
  });

  it("returns the full diff and nonce only to the owning session", async () => {
    const current = harness();
    await select(current);
    await call(current, "add_todo", {
      noteId: "note-a",
      text: "Koupit mléko",
    });

    const pending = await current.store.getPendingProposal(
      current.session.sessionId,
      "proposal-1",
    );
    expect(pending).toMatchObject({
      beforeMd: CONTENT,
      confirmationNonce: NONCE,
      noteTitle: "Poznámka",
      proposalId: "proposal-1",
      status: "pending",
    });
    expect(pending.diff.inserted).toContain("- [ ] Koupit mléko");

    const other = current.store.createSession({
      expiresAt: new Date(NOW + 60_000),
    });
    await expect(
      current.store.getPendingProposal(other.sessionId, "proposal-1"),
    ).rejects.toMatchObject({ code: "proposal_not_found", status: 404 });
  });

  it("shows expiry and never returns a nonce after it", async () => {
    const current = harness();
    await select(current);
    await call(current, "add_todo", {
      noteId: "note-a",
      text: "Koupit mléko",
    });

    current.setNow(NOW + PROPOSAL_EXPIRY_MS + 1);
    await expect(
      current.store.getPendingProposal(
        current.session.sessionId,
        "proposal-1",
      ),
    ).rejects.toMatchObject({ code: "proposal_expired", status: 409 });
    await expect(
      current.store.getPendingProposal(
        current.session.sessionId,
        "proposal-1",
      ),
    ).rejects.toBeInstanceOf(ToolSessionError);

    const confirm = await call(current, "confirm_edit", {
      proposalId: "proposal-1",
    });
    expect(confirm).toMatchObject({
      ok: false,
      response: { error: { code: "proposal_not_found" } },
    });
  });

  it("strips the nonce once the proposal is rejected or applied", async () => {
    const current = harness({
      get: async (_noteId, proposalId) =>
        proposal(proposalId, "rejected"),
    });
    await select(current);
    await call(current, "add_todo", {
      noteId: "note-a",
      text: "Koupit mléko",
    });

    const pending = await current.store.getPendingProposal(
      current.session.sessionId,
      "proposal-1",
    );
    expect(pending).toMatchObject({
      confirmationNonce: null,
      status: "rejected",
    });
    expect(pending.beforeMd).toBe(CONTENT);

    await expect(
      current.store.getPendingProposal(
        current.session.sessionId,
        "proposal-1",
      ),
    ).rejects.toMatchObject({ code: "proposal_not_found" });
  });
});
