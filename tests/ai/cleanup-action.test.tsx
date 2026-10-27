// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CleanupAction } from "../../src/components/ai/CleanupAction";
import type { LlmProviderStatus } from "../../src/lib/ai/structured";
import type { NoteDetail } from "../../src/lib/notes/client";
import {
  ProposalApiError,
  type EditProposal,
} from "../../src/lib/notes/proposal-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const proposalClient = vi.hoisted(() => ({
  confirmEditProposal: vi.fn(),
  createEditProposal: vi.fn(),
  rejectEditProposal: vi.fn(),
}));

vi.mock("@/lib/notes/proposal-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/notes/proposal-client")>();

  return {
    ...actual,
    confirmEditProposal: proposalClient.confirmEditProposal,
    createEditProposal: proposalClient.createEditProposal,
    rejectEditProposal: proposalClient.rejectEditProposal,
  };
});

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const PROPOSAL_ID = "22222222-2222-4222-8222-222222222222";
const original =
  "Já jsem já jsem se včera ehm sešel s Janem Novákem a měl jsem 3 schůzky.";
const cleaned =
  "Včera jsem se sešel s Janem Novákem a měl jsem 3 schůzky.";

const note: NoteDetail = {
  category: null,
  contentMd: `${original}\n\nDruhý odstavec zůstává beze změny.`,
  contentPlain: `${original} Druhý odstavec zůstává beze změny.`,
  createdAt: "2026-10-27T10:00:00.000Z",
  deletedAt: null,
  id: NOTE_ID,
  tags: [],
  title: "Diktát",
  updatedAt: "2026-10-27T10:00:00.000Z",
  version: 1,
};

const llmStatus: LlmProviderStatus = {
  blockedReason: null,
  checkedAt: "2026-10-27",
  configured: true,
  estimatedMaxCostUsd: 0.011187,
  liveStatus: "verified",
  maxInputCodeUnits: 12_000,
  maxOutputTokens: 1_200,
  model: "deepseek/deepseek-v4.1-flash-1017",
  structuredOutputs: true,
  timeoutMs: 20_000,
};

const operation = {
  type: "replace_paragraph" as const,
  target: { endPhrase: original, startPhrase: original },
  text: cleaned,
};

function proposal(status: EditProposal["status"] = "pending"): EditProposal {
  return {
    afterMd: `${cleaned}\n\nDruhý odstavec zůstává beze změny.`,
    beforeMd: note.contentMd,
    createdAt: "2026-10-27T10:00:00.000Z",
    diff: {
      end: original.length,
      inserted: cleaned,
      prefix: "",
      removed: original,
      start: 0,
      suffix: "\n\nDruhý odstavec zůstává beze změny.",
    },
    expectedVersion: 1,
    expiresAt: "2026-10-27T10:05:00.000Z",
    id: PROPOSAL_ID,
    noteId: NOTE_ID,
    noteTitle: note.title,
    operation,
    originalHash: "a".repeat(64),
    selectedCandidate: null,
    status,
    updatedAt: "2026-10-27T10:00:00.000Z",
  };
}

function successfulFetch() {
  return vi.fn<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >(async () => {
    return new Response(
      JSON.stringify({
        candidateId: "p0",
        cleanedText: cleaned,
        kind: "cleanup",
        noteVersion: 1,
        operation,
        originalText: original,
        sourceHash: "a".repeat(64),
      }),
      { headers: { "content-type": "application/json" }, status: 200 },
    );
  });
}

beforeEach(() => {
  proposalClient.createEditProposal.mockReset();
  proposalClient.confirmEditProposal.mockReset();
  proposalClient.rejectEditProposal.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CleanupAction", () => {
  it("sends only the selected paragraph and creates a proposal only after the provider succeeds", async () => {
    const user = userEvent.setup();
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    proposalClient.createEditProposal.mockResolvedValue({
      ...proposal(),
      confirmationNonce: "cleanup-nonce",
    });

    render(<CleanupAction llmStatus={llmStatus} note={note} onNoteUpdated={vi.fn()} />);

    await user.selectOptions(
      screen.getByTestId("cleanup-paragraph"),
      screen.getByRole("option", { name: /^1\./ }),
    );
    await user.click(screen.getByTestId("cleanup-submit"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/notes/${NOTE_ID}/ai-suggest`,
    );
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { blockIndex: number; kind: string; properNames: string[] };
    expect(body).toEqual({ blockIndex: 0, kind: "cleanup", properNames: [] });
    expect(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)).not.toContain(
      "Druhý odstavec",
    );

    await waitFor(() => {
      expect(proposalClient.createEditProposal).toHaveBeenCalledWith(NOTE_ID, {
        candidateId: "p0",
        expectedSourceHash: "a".repeat(64),
        expectedVersion: 1,
        operation,
      });
    });
    expect(screen.getByTestId("proposal-preview")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("confirms one approval and never changes the note on reject", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", successfulFetch());
    const onApplied = vi.fn();
    const onNoteUpdated = vi.fn();
    const updated = {
      ...note,
      contentMd: proposal().afterMd,
      version: 2,
    };
    proposalClient.createEditProposal.mockResolvedValue({
      ...proposal(),
      confirmationNonce: "cleanup-nonce",
    });
    proposalClient.rejectEditProposal.mockResolvedValue(
      proposal("rejected"),
    );
    proposalClient.confirmEditProposal.mockResolvedValue({
      note: updated,
      proposal: proposal("applied"),
    });

    render(
      <CleanupAction
        llmStatus={llmStatus}
        note={note}
        onApplied={onApplied}
        onNoteUpdated={onNoteUpdated}
      />,
    );

    await user.selectOptions(
      screen.getByTestId("cleanup-paragraph"),
      screen.getByRole("option", { name: /^1\./ }),
    );
    await user.click(screen.getByTestId("cleanup-submit"));
    await screen.findByTestId("proposal-preview");

    await user.click(screen.getByRole("button", { name: "Zamítnout návrh" }));
    await waitFor(() => {
      expect(proposalClient.rejectEditProposal).toHaveBeenCalledWith(
        NOTE_ID,
        PROPOSAL_ID,
      );
    });
    expect(onNoteUpdated).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("cleanup-submit"));
    await screen.findByTestId("proposal-preview");
    await user.click(screen.getByRole("button", { name: "Potvrdit" }));

    await waitFor(() => {
      expect(proposalClient.confirmEditProposal).toHaveBeenCalledWith(
        NOTE_ID,
        PROPOSAL_ID,
        { confirmationNonce: "cleanup-nonce", expectedVersion: 1 },
      );
    });
    expect(onNoteUpdated).toHaveBeenCalledWith(updated);
    expect(onApplied).toHaveBeenCalledWith("Vyčištění odstavce bylo uloženo.");
  });

  it("shows provider failure, name mismatch and stale proposal without changing the note", async () => {
    const user = userEvent.setup();
    const failureFetch = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => {
      return new Response(
        JSON.stringify({
          error: { message: "Poskytovatel AI selhal." },
        }),
        { headers: { "content-type": "application/json" }, status: 502 },
      );
    });
    vi.stubGlobal("fetch", failureFetch);
    const onNoteUpdated = vi.fn();

    render(
      <CleanupAction
        llmStatus={llmStatus}
        note={note}
        onNoteUpdated={onNoteUpdated}
      />,
    );

    fireEvent.change(screen.getByTestId("cleanup-names"), {
      target: { value: "Karel" },
    });
    await user.selectOptions(
      screen.getByTestId("cleanup-paragraph"),
      screen.getByRole("option", { name: /^1\./ }),
    );
    await user.click(screen.getByTestId("cleanup-submit"));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Karel",
    );
    expect(failureFetch).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("cleanup-names"), {
      target: { value: "" },
    });
    await user.click(screen.getByTestId("cleanup-submit"));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Poskytovatel AI selhal.",
    );
    expect(proposalClient.createEditProposal).not.toHaveBeenCalled();
    expect(onNoteUpdated).not.toHaveBeenCalled();
  });

  it("shows a P23 conflict without applying anything", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", successfulFetch());
    proposalClient.createEditProposal.mockRejectedValue(
      new ProposalApiError(409, "proposal_stale", "Poznámka se změnila."),
    );

    render(<CleanupAction llmStatus={llmStatus} note={note} onNoteUpdated={vi.fn()} />);

    await user.selectOptions(
      screen.getByTestId("cleanup-paragraph"),
      screen.getByRole("option", { name: /^1\./ }),
    );
    await user.click(screen.getByTestId("cleanup-submit"));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Poznámka se změnila.",
    );
    expect(screen.queryByTestId("proposal-preview")).toBeNull();
  });
});
