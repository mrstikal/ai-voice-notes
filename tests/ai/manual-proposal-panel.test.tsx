// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManualProposalPanel } from "../../src/components/ai/ManualProposalPanel";
import type { NoteDetail } from "../../src/lib/notes/client";
import type {
  CreatedEditProposal,
  EditProposal,
} from "../../src/lib/notes/proposal-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const client = vi.hoisted(() => ({
  createEditProposal: vi.fn(),
  confirmEditProposal: vi.fn(),
  rejectEditProposal: vi.fn(),
}));

vi.mock("@/lib/notes/proposal-client", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/lib/notes/proposal-client")
  >();

  return {
    ...actual,
    createEditProposal: client.createEditProposal,
    confirmEditProposal: client.confirmEditProposal,
    rejectEditProposal: client.rejectEditProposal,
  };
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

beforeEach(() => {
  vi.resetAllMocks();
});

const NOTE_ID = "11111111-1111-4111-8111-111111111111";

function proposal(
  overrides: Partial<EditProposal> = {},
): EditProposal {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    noteId: NOTE_ID,
    noteTitle: "Panel poznámka",
    expectedVersion: 1,
    originalHash: "a".repeat(64),
    operation: {
      type: "replace_sentence",
      target: { startPhrase: "První", endPhrase: "věta" },
      text: "Nová věta.",
    },
    beforeMd: "První věta. Druhá věta.",
    afterMd: "Nová věta. Druhá věta.",
    selectedCandidate: null,
    status: "pending",
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
    ...overrides,
  };
}

function created(
  overrides: Partial<CreatedEditProposal> = {},
): CreatedEditProposal {
  return {
    ...proposal(),
    confirmationNonce: "raw-panel-nonce-0123456789",
    ...overrides,
  };
}

function note(): NoteDetail {
  return {
    id: NOTE_ID,
    title: "Panel poznámka",
    contentMd: "Nová věta. Druhá věta.",
    contentPlain: "Nová věta. Druhá věta.",
    category: null,
    tags: [],
    version: 2,
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T10:01:00.000Z",
    deletedAt: null,
  };
}

async function prepareProposal() {
  const onNoteUpdated = vi.fn();
  render(
    <ManualProposalPanel
      noteId={NOTE_ID}
      noteTitle="Panel poznámka"
      noteVersion={1}
      onNoteUpdated={onNoteUpdated}
    />,
  );

  fireEvent.change(screen.getByLabelText("Začátek cíle"), {
    target: { value: "První" },
  });
  fireEvent.change(screen.getByLabelText("Konec cíle"), {
    target: { value: "věta" },
  });
  fireEvent.change(screen.getByLabelText("Text operace"), {
    target: { value: "Nová věta." },
  });
  client.createEditProposal.mockResolvedValue(created());
  fireEvent.click(
    screen.getByRole("button", {
      name: "Vytvořit návrh a zobrazit diff",
    }),
  );
  await screen.findByTestId("proposal-preview");

  return { onNoteUpdated };
}

describe("ManualProposalPanel confirm wiring", () => {
  it("sends the one-time nonce only on confirm and updates the editor result", async () => {
    const { onNoteUpdated } = await prepareProposal();

    expect(client.createEditProposal).toHaveBeenCalledWith(NOTE_ID, {
      operation: {
        type: "replace_sentence",
        target: { startPhrase: "První", endPhrase: "věta" },
        text: "Nová věta.",
      },
      expectedVersion: 1,
    });
    expect(screen.queryByText(/raw-panel-nonce/u)).toBeNull();

    client.confirmEditProposal.mockResolvedValue({
      proposal: proposal({ status: "applied" }),
      note: note(),
    });
    fireEvent.click(screen.getByRole("button", { name: "Potvrdit" }));

    await waitFor(() => {
      expect(client.confirmEditProposal).toHaveBeenCalledWith(
        NOTE_ID,
        proposal().id,
        {
          confirmationNonce: "raw-panel-nonce-0123456789",
          expectedVersion: 1,
        },
      );
    });
    expect(onNoteUpdated).toHaveBeenCalledWith(note());
    expect(screen.queryByRole("button", { name: "Potvrdit" })).toBeNull();
  });

  it("does not send the nonce on reject and does not update the note", async () => {
    const { onNoteUpdated } = await prepareProposal();
    client.rejectEditProposal.mockResolvedValue(
      proposal({ status: "rejected" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Zamítnout návrh" }));

    await waitFor(() => {
      expect(client.rejectEditProposal).toHaveBeenCalledWith(
        NOTE_ID,
        proposal().id,
      );
    });
    expect(client.confirmEditProposal).not.toHaveBeenCalled();
    expect(onNoteUpdated).not.toHaveBeenCalled();
    expect(screen.getByText("Zamítnuto")).toBeDefined();
    expect(client.createEditProposal.mock.calls[0]?.[1]).not.toHaveProperty(
      "confirmationNonce",
    );
  });

  it("keeps the pending proposal and editor result untouched when confirm fails stale", async () => {
    const { onNoteUpdated } = await prepareProposal();
    client.confirmEditProposal.mockRejectedValue(
      new Error("Poznámka byla mezitím změněna. Vytvořte nový návrh."),
    );

    fireEvent.click(screen.getByRole("button", { name: "Potvrdit" }));

    expect(
      await screen.findByText(
        "Poznámka byla mezitím změněna. Vytvořte nový návrh.",
      ),
    ).toBeDefined();
    expect(onNoteUpdated).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Potvrdit" })).toBeDefined();
    expect(screen.getByTestId("proposal-preview")).toBeDefined();
  });
});
