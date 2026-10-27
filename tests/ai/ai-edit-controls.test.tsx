// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiEditControls } from "../../src/components/ai/AiEditControls";
import type { NoteDetail } from "../../src/lib/notes/client";
import {
  ProposalApiError,
  type EditProposal,
} from "../../src/lib/notes/proposal-client";
import type { RevisionHistory } from "../../src/lib/notes/revision-client";
import type { LlmOperation } from "../../src/lib/ai/schemas";
import type { LlmProviderStatus } from "../../src/lib/ai/structured";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const proposalClient = vi.hoisted(() => ({
  createEditProposal: vi.fn(),
  confirmEditProposal: vi.fn(),
  rejectEditProposal: vi.fn(),
}));
const revisionClient = vi.hoisted(() => ({
  fetchRevisions: vi.fn(),
  restoreRevision: vi.fn(),
}));
const dictation = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/notes/proposal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notes/proposal-client")>();
  return {
    ...actual,
    createEditProposal: proposalClient.createEditProposal,
    confirmEditProposal: proposalClient.confirmEditProposal,
    rejectEditProposal: proposalClient.rejectEditProposal,
  };
});

vi.mock("@/lib/notes/revision-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notes/revision-client")>();
  return {
    ...actual,
    fetchRevisions: revisionClient.fetchRevisions,
    restoreRevision: revisionClient.restoreRevision,
  };
});

vi.mock("@/components/voice/useScribeDictation", () => ({
  useScribeDictation: () => ({
    session: { status: "idle", error: null },
    start: dictation.start,
    stop: dictation.stop,
  }),
}));

const llmStatus: LlmProviderStatus = {
  configured: true,
  model: "deepseek/deepseek-v4.1-flash-1017",
  structuredOutputs: true,
  liveStatus: "verified",
  maxInputCodeUnits: 12_000,
  maxOutputTokens: 1_200,
  timeoutMs: 20_000,
  estimatedMaxCostUsd: 0.011187,
  checkedAt: "2026-10-27",
  blockedReason: null,
};

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const PROPOSAL_ID = "22222222-2222-4222-8222-222222222222";

const note: NoteDetail = {
  id: NOTE_ID,
  title: "AI poznámka",
  contentMd: "První věta. Druhá věta.",
  contentPlain: "První věta. Druhá věta.",
  category: null,
  tags: [],
  version: 1,
  createdAt: "2026-10-27T10:00:00.000Z",
  updatedAt: "2026-10-27T10:00:00.000Z",
  deletedAt: null,
};

const operation: LlmOperation = {
  type: "replace_sentence",
  target: { startPhrase: "První", endPhrase: "věta" },
  text: "Nová věta.",
};

function proposal(status: EditProposal["status"] = "pending"): EditProposal {
  return {
    id: PROPOSAL_ID,
    noteId: NOTE_ID,
    noteTitle: note.title,
    expectedVersion: 1,
    originalHash: "a".repeat(64),
    operation,
    beforeMd: note.contentMd,
    afterMd: "Nová věta. Druhá věta.",
    selectedCandidate: null,
    status,
    expiresAt: "2026-10-27T10:05:00.000Z",
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T10:00:00.000Z",
    diff: {
      start: 0,
      end: 5,
      prefix: "",
      removed: "První",
      inserted: "Nová",
      suffix: " věta. Druhá věta.",
    },
  };
}

function history(): RevisionHistory {
  return {
    currentVersion: 2,
    currentSnapshot: {
      title: note.title,
      contentMd: "Druhá verze.",
      category: null,
      tags: [],
    },
    undoRevisionId: PROPOSAL_ID,
    canUndo: true,
    revisions: [
      {
        id: PROPOSAL_ID,
        noteVersion: 2,
        reason: "manual",
        createdAt: "2026-10-27T10:00:00.000Z",
        beforeSnapshot: {
          title: note.title,
          contentMd: "První verze.",
          category: null,
          tags: [],
        },
        afterSnapshot: {
          title: note.title,
          contentMd: "Druhá verze.",
          category: null,
          tags: [],
        },
        diff: {
          start: 0,
          end: 5,
          prefix: "",
          removed: "První",
          inserted: "Druhá",
          suffix: " verze.",
        },
      },
    ],
  };
}

function mockInterpret(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

async function renderAndInterpret() {
  const onNoteUpdated = vi.fn();
  render(
    <AiEditControls
      llmStatus={llmStatus}
      note={note}
      onNoteUpdated={onNoteUpdated}
    />,
  );
  fireEvent.change(screen.getByLabelText("Český příkaz"), {
    target: { value: "Nahraď první větu." },
  });
  fireEvent.change(screen.getByLabelText(/Vybraný text pro AI/), {
    target: { value: "První věta." },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Interpretovat příkaz" }),
  );
  return onNoteUpdated;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("AiEditControls", () => {
  it("discloses the model and estimated cost and blocks the action without a provider", async () => {
    const { rerender } = render(
      <AiEditControls
        llmStatus={llmStatus}
        note={note}
        onNoteUpdated={vi.fn()}
      />,
    );

    expect(screen.getByText(/deepseek\/deepseek-v4.1-flash-1017/)).toBeDefined();
    expect(screen.getByText(/odhad.*USD/)).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Interpretovat příkaz" }),
    ).toHaveProperty("disabled", false);

    rerender(
      <AiEditControls
        llmError="Stav AI se nepodařilo načíst."
        llmStatus={null}
        note={note}
        onNoteUpdated={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Interpretovat příkaz" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByText("Stav AI se nepodařilo načíst.")).toBeDefined();

    fireEvent.change(screen.getByLabelText("Český příkaz"), {
      target: { value: "Vrať poslední změnu." },
    });
    expect(
      screen.getByRole("button", { name: "Interpretovat příkaz" }),
    ).toHaveProperty("disabled", false);
  });

  it("turns an interpreted operation into a P23 proposal and confirms the persisted note", async () => {
    mockInterpret({ kind: "operation", operation });
    proposalClient.createEditProposal.mockResolvedValue({
      ...proposal(),
      confirmationNonce: "ai-nonce-0123456789",
    });
    const updatedNote = { ...note, version: 2, contentMd: proposal().afterMd };
    proposalClient.confirmEditProposal.mockResolvedValue({
      proposal: proposal("applied"),
      note: updatedNote,
    });
    const onNoteUpdated = await renderAndInterpret();

    await screen.findByTestId("proposal-preview");
    fireEvent.click(screen.getByRole("button", { name: "Potvrdit" }));

    await waitFor(() => {
      expect(proposalClient.confirmEditProposal).toHaveBeenCalledWith(
        NOTE_ID,
        PROPOSAL_ID,
        {
          confirmationNonce: "ai-nonce-0123456789",
          expectedVersion: 1,
        },
      );
    });
    expect(onNoteUpdated).toHaveBeenCalledWith(updatedNote);
    expect(proposalClient.createEditProposal).toHaveBeenCalledWith(
      NOTE_ID,
      { operation, expectedVersion: 1 },
    );
  });

  it("shows numbered candidates for an ambiguous target and binds the retry", async () => {
    mockInterpret({ kind: "operation", operation });
    proposalClient.createEditProposal.mockRejectedValueOnce(
      new ProposalApiError(
        409,
        "proposal_ambiguous",
        "Cíl odpovídá více místům.",
        {
          candidates: [
            {
              id: "p0:s0",
              ordinal: 1,
              text: "První věta.",
              snippet: "První věta.",
              blockIndex: 0,
              sentenceIndex: 0,
            },
            {
              id: "p0:s1",
              ordinal: 2,
              text: "První věta.",
              snippet: "První věta.",
              blockIndex: 0,
              sentenceIndex: 1,
            },
          ],
          noteVersion: 1,
          sourceHash: "b".repeat(64),
        },
      ),
    );
    proposalClient.createEditProposal.mockResolvedValueOnce({
      ...proposal(),
      confirmationNonce: "ai-nonce-ambiguous",
    });
    await renderAndInterpret();

    expect(
      await screen.findByText("Cíl odpovídá více místům"),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /2\./ }));

    await waitFor(() => {
      expect(proposalClient.createEditProposal).toHaveBeenLastCalledWith(
        NOTE_ID,
        {
          operation,
          candidateId: "p0:s1",
          expectedVersion: 1,
          expectedSourceHash: "b".repeat(64),
        },
      );
    });
    expect(await screen.findByTestId("proposal-preview")).toBeDefined();
  });

  it("opens the P25 Undo preview for an undo command without an LLM operation", async () => {
    mockInterpret({ kind: "undo" });
    revisionClient.fetchRevisions.mockResolvedValue(history());
    const onNoteUpdated = vi.fn();
    render(
      <AiEditControls
        llmStatus={llmStatus}
        note={note}
        onNoteUpdated={onNoteUpdated}
      />,
    );

    fireEvent.change(screen.getByLabelText("Český příkaz"), {
      target: { value: "Vrať poslední změnu." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Interpretovat příkaz" }),
    );

    expect(
      await screen.findByText("Vrátit poslední změnu?"),
    ).toBeDefined();
    expect(proposalClient.createEditProposal).not.toHaveBeenCalled();

    revisionClient.restoreRevision.mockResolvedValue({
      ...note,
      version: 3,
      contentMd: "První verze.",
    });
    fireEvent.click(screen.getByRole("button", { name: "Potvrdit vrácení" }));

    await waitFor(() => {
      expect(revisionClient.restoreRevision).toHaveBeenCalledWith(
        NOTE_ID,
        PROPOSAL_ID,
        { mode: "undo", expectedVersion: 2 },
      );
    });
    expect(onNoteUpdated).toHaveBeenCalled();
  });
});
