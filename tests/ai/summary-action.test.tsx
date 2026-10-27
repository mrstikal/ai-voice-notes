// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SummaryAction } from "../../src/components/ai/SummaryAction";
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
const summaryText = "Shrnutí: včera proběhla schůzka a tři další kroky.";
const contentPlain =
  "První odstavec obsahuje kontext a tři úkoly. Druhý odstavec zůstává mimo výběr.";

const note: NoteDetail = {
  category: null,
  contentMd: contentPlain,
  contentPlain,
  createdAt: "2026-10-27T10:00:00.000Z",
  deletedAt: null,
  id: NOTE_ID,
  tags: [],
  title: "Shrnutí",
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

function proposal(): EditProposal {
  return {
    afterMd: `${contentPlain}\n\n${summaryText}`,
    beforeMd: contentPlain,
    createdAt: "2026-10-27T10:00:00.000Z",
    diff: {
      end: contentPlain.length,
      inserted: `\n\n${summaryText}`,
      prefix: contentPlain,
      removed: "",
      start: contentPlain.length,
      suffix: "",
    },
    expectedVersion: 1,
    expiresAt: "2026-10-27T10:05:00.000Z",
    id: PROPOSAL_ID,
    noteId: NOTE_ID,
    noteTitle: note.title,
    operation: { type: "append_bounded_section", text: summaryText },
    originalHash: "a".repeat(64),
    selectedCandidate: null,
    status: "pending",
    updatedAt: "2026-10-27T10:00:00.000Z",
  };
}

function summaryFetch() {
  return vi.fn<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >(async () => {
    return new Response(
      JSON.stringify({
        kind: "summary",
        noteId: NOTE_ID,
        noteVersion: 1,
        sourceGraphemes: 70,
        summaryText,
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

describe("SummaryAction", () => {
  it("generates an unsaved artifact and reading it creates no proposal or note change", async () => {
    const user = userEvent.setup();
    const fetchMock = summaryFetch();
    vi.stubGlobal("fetch", fetchMock);
    const onReadSummary = vi.fn();
    const onNoteUpdated = vi.fn();

    render(
      <SummaryAction
        llmStatus={llmStatus}
        note={note}
        onNoteUpdated={onNoteUpdated}
        onReadSummary={onReadSummary}
      />,
    );

    await user.click(screen.getByTestId("summary-generate"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(
      JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)),
    ).toEqual({ kind: "summary", scope: "full" });
    expect(screen.getByTestId("summary-artifact").textContent).toContain(
      summaryText,
    );
    expect(proposalClient.createEditProposal).not.toHaveBeenCalled();
    expect(onNoteUpdated).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Přečíst shrnutí" }));

    expect(onReadSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        noteId: NOTE_ID,
        noteVersion: 1,
        summaryText,
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(proposalClient.createEditProposal).not.toHaveBeenCalled();
  });

  it("inserts through one P23 proposal and one confirmation", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", summaryFetch());
    const onNoteUpdated = vi.fn();
    proposalClient.createEditProposal.mockResolvedValue({
      ...proposal(),
      confirmationNonce: "summary-nonce",
    });
    proposalClient.confirmEditProposal.mockResolvedValue({
      note: { ...note, contentMd: proposal().afterMd, version: 2 },
      proposal: { ...proposal(), status: "applied" },
    });

    render(
      <SummaryAction
        llmStatus={llmStatus}
        note={note}
        onNoteUpdated={onNoteUpdated}
      />,
    );

    await user.click(screen.getByTestId("summary-generate"));
    await screen.findByTestId("summary-artifact");
    await user.click(screen.getByRole("button", { name: "Vložit shrnutí" }));

    await waitFor(() => {
      expect(proposalClient.createEditProposal).toHaveBeenCalledWith(NOTE_ID, {
        expectedVersion: 1,
        operation: { type: "append_bounded_section", text: summaryText },
      });
    });
    expect(screen.getByTestId("proposal-preview")).not.toBeNull();
    expect(onNoteUpdated).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Potvrdit" }));

    await waitFor(() => {
      expect(proposalClient.confirmEditProposal).toHaveBeenCalledWith(
        NOTE_ID,
        PROPOSAL_ID,
        { confirmationNonce: "summary-nonce", expectedVersion: 1 },
      );
    });
    expect(onNoteUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2 }),
    );
  });

  it("blocks long full notes, stale artifacts, provider failure and rejects safely", async () => {
    const user = userEvent.setup();
    const fetchMock = summaryFetch();
    vi.stubGlobal("fetch", fetchMock);
    const longNote = {
      ...note,
      contentPlain: "a".repeat(8_001),
      contentMd: "a".repeat(8_001),
    };

    const view = render(
      <SummaryAction llmStatus={llmStatus} note={longNote} onNoteUpdated={vi.fn()} />,
    );

    expect(screen.getByText(/Poznámka je delší než limit/)).not.toBeNull();
    expect(
      (screen.getByTestId("summary-generate") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    view.rerender(
      <SummaryAction llmStatus={llmStatus} note={note} onNoteUpdated={vi.fn()} />,
    );
    await user.click(screen.getByTestId("summary-generate"));
    await screen.findByTestId("summary-artifact");

    view.rerender(
      <SummaryAction
        llmStatus={llmStatus}
        note={{ ...note, version: 2 }}
        onNoteUpdated={vi.fn()}
      />,
    );
    expect(screen.getByText(/Poznámka se mezitím změnila/)).not.toBeNull();
    expect(
      (screen.getByRole("button", { name: "Vložit shrnutí" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Přečíst shrnutí" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    view.unmount();
    cleanup();

    const failureFetch = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => {
      return new Response(
        JSON.stringify({ error: { message: "Poskytovatel AI selhal." } }),
        { headers: { "content-type": "application/json" }, status: 502 },
      );
    });
    vi.stubGlobal("fetch", failureFetch);

    render(
      <SummaryAction llmStatus={llmStatus} note={note} onNoteUpdated={vi.fn()} />,
    );
    await user.click(screen.getByTestId("summary-generate"));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Poskytovatel AI selhal.",
    );
    expect(proposalClient.createEditProposal).not.toHaveBeenCalled();
  });

  it("shows a P23 rejection without changing the note", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", summaryFetch());
    proposalClient.createEditProposal.mockRejectedValue(
      new ProposalApiError(409, "proposal_stale", "Poznámka se změnila."),
    );

    render(
      <SummaryAction llmStatus={llmStatus} note={note} onNoteUpdated={vi.fn()} />,
    );

    await user.click(screen.getByTestId("summary-generate"));
    await screen.findByTestId("summary-artifact");
    await user.click(screen.getByRole("button", { name: "Vložit shrnutí" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Poznámka se změnila.",
    );
    expect(screen.queryByTestId("proposal-preview")).toBeNull();
  });
});
