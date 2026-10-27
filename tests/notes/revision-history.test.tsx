// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RevisionHistory } from "../../src/components/notes/RevisionHistory";
import { NoteApiError, type NoteDetail } from "../../src/lib/notes/client";
import type {
  RevisionHistory as RevisionHistoryData,
} from "../../src/lib/notes/revision-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const client = vi.hoisted(() => ({
  fetchRevisions: vi.fn(),
  restoreRevision: vi.fn(),
}));

vi.mock("@/lib/notes/revision-client", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/lib/notes/revision-client")
  >();

  return {
    ...actual,
    fetchRevisions: client.fetchRevisions,
    restoreRevision: client.restoreRevision,
  };
});

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const MANUAL_ID = "22222222-2222-4222-8222-222222222222";
const INITIAL_ID = "33333333-3333-4333-8333-333333333333";
const AI_ID = "44444444-4444-4444-8444-444444444444";

function history(): RevisionHistoryData {
  return {
    currentVersion: 2,
    currentSnapshot: {
      title: "Historie",
      contentMd: "Druhá verze.",
      category: null,
      tags: [],
    },
    undoRevisionId: MANUAL_ID,
    canUndo: true,
    revisions: [
      {
        id: MANUAL_ID,
        noteVersion: 2,
        reason: "manual",
        createdAt: "2026-10-27T10:01:00.000Z",
        beforeSnapshot: {
          title: "Historie",
          contentMd: "První verze.",
          category: null,
          tags: [],
        },
        afterSnapshot: {
          title: "Historie",
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
      {
        id: INITIAL_ID,
        noteVersion: 1,
        reason: "initial",
        createdAt: "2026-10-27T10:00:00.000Z",
        beforeSnapshot: {
          title: "Historie",
          contentMd: "",
          category: null,
          tags: [],
        },
        afterSnapshot: {
          title: "Historie",
          contentMd: "První verze.",
          category: null,
          tags: [],
        },
        diff: {
          start: 0,
          end: 0,
          prefix: "",
          removed: "",
          inserted: "První verze.",
          suffix: "",
        },
      },
    ],
  };
}

function note(version = 3): NoteDetail {
  return {
    id: NOTE_ID,
    title: "Historie",
    contentMd: "První verze.",
    contentPlain: "První verze.",
    category: null,
    tags: [],
    version,
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T10:01:00.000Z",
    deletedAt: null,
  };
}

async function renderHistory(disabled = false) {
  const onNoteUpdated = vi.fn();
  client.fetchRevisions.mockResolvedValue(history());
  render(
    <RevisionHistory
      disabled={disabled}
      noteId={NOTE_ID}
      noteVersion={2}
      onNoteUpdated={onNoteUpdated}
    />,
  );
  await screen.findByTestId("revision-history");
  return { onNoteUpdated };
}

afterEach(cleanup);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("RevisionHistory", () => {
  it("shows reasons, escaped diff and only one-click Undo for the latest change", async () => {
    await renderHistory();

    expect(screen.getByText(/Ruční úprava/)).toBeDefined();
    expect(screen.getByText(/Počáteční verze/)).toBeDefined();
    expect(screen.getAllByText("Vrátit poslední změnu")).toHaveLength(1);
    expect(screen.getByText("Druhá")).toBeDefined();
    expect(screen.queryByText("<script>")).toBeNull();
  });

  it("shows and restores the original transcript only for an AI revision", async () => {
    const onNoteUpdated = vi.fn();
    const data: RevisionHistoryData = {
      currentVersion: 2,
      currentSnapshot: {
        title: "Historie",
        contentMd: "Druhá verze.",
        category: null,
        tags: [],
      },
      undoRevisionId: null,
      canUndo: false,
      revisions: [
        {
          id: AI_ID,
          noteVersion: 2,
          reason: "ai",
          createdAt: "2026-10-27T10:01:00.000Z",
          beforeSnapshot: {
            title: "Historie",
            contentMd: "Původní přepis.",
            category: null,
            tags: [],
          },
          afterSnapshot: {
            title: "Historie",
            contentMd: "Druhá verze.",
            category: null,
            tags: [],
          },
          diff: {
            start: 0,
            end: 15,
            prefix: "",
            removed: "Původní přepis.",
            inserted: "Druhá verze.",
            suffix: "",
          },
        },
        history().revisions[1]!,
      ],
    };
    client.fetchRevisions.mockResolvedValue(data);
    client.restoreRevision.mockResolvedValue(note());

    render(
      <RevisionHistory
        noteId={NOTE_ID}
        noteVersion={2}
        onNoteUpdated={onNoteUpdated}
      />,
    );

    await screen.findByTestId("revision-history");
    expect(
      screen.queryByTestId("revision-before-toggle-1"),
    ).toBeNull();

    const aiItem = screen.getByTestId("revision-2");
    fireEvent.click(
      within(aiItem).getByRole("button", {
        name: "Zobrazit původní přepis",
      }),
    );
    expect(screen.getByTestId("revision-before-2").textContent).toContain(
      "Původní přepis.",
    );

    fireEvent.click(
      within(aiItem).getByRole("button", {
        name: "Obnovit původní přepis",
      }),
    );
    expect(
      screen.getByTestId("revision-restore-preview").textContent,
    ).toContain("Obnovit původní přepis před verzí 2");

    fireEvent.click(
      within(aiItem).getByRole("button", {
        name: "Skrýt původní přepis",
      }),
    );
    expect(screen.queryByTestId("revision-restore-preview")).toBeNull();

    fireEvent.click(
      within(aiItem).getByRole("button", {
        name: "Zobrazit původní přepis",
      }),
    );
    fireEvent.click(
      within(aiItem).getByRole("button", {
        name: "Obnovit původní přepis",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Potvrdit obnovení" }),
    );

    await waitFor(() => {
      expect(client.restoreRevision).toHaveBeenCalledWith(NOTE_ID, AI_ID, {
        mode: "restore_before",
        expectedVersion: 2,
      });
    });
    expect(onNoteUpdated).toHaveBeenCalledWith(note());
  });

  it("calls undo with the version and mode and accepts persisted note", async () => {
    const { onNoteUpdated } = await renderHistory();
    client.restoreRevision.mockResolvedValue(note());

    fireEvent.click(screen.getByRole("button", { name: "Vrátit poslední změnu" }));

    await waitFor(() => {
      expect(client.restoreRevision).toHaveBeenCalledWith(
        NOTE_ID,
        MANUAL_ID,
        { mode: "undo", expectedVersion: 2 },
      );
    });
    expect(onNoteUpdated).toHaveBeenCalledWith(note());
  });

  it("previews an older after-snapshot only after explicit confirmation", async () => {
    const { onNoteUpdated } = await renderHistory();
    client.restoreRevision.mockResolvedValue(note());

    fireEvent.click(
      within(screen.getByTestId("revision-1")).getByRole("button", {
        name: "Obnovit tuto verzi",
      }),
    );
    expect(screen.getByTestId("revision-restore-preview")).toBeDefined();
    expect(client.restoreRevision).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Potvrdit obnovení" }));

    await waitFor(() => {
      expect(client.restoreRevision).toHaveBeenCalledWith(
        NOTE_ID,
        INITIAL_ID,
        { mode: "restore", expectedVersion: 2 },
      );
    });
    expect(onNoteUpdated).toHaveBeenCalledWith(note());
  });

  it("clears a stale restore preview and refetches history on 409", async () => {
    await renderHistory();
    client.restoreRevision.mockRejectedValue(
      new NoteApiError(409, "version_conflict", "Poznámka se změnila.", 3),
    );

    fireEvent.click(
      within(screen.getByTestId("revision-1")).getByRole("button", {
        name: "Obnovit tuto verzi",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Potvrdit obnovení" }));

    expect(
      await screen.findByText(/Poznámka se změnila.*Aktuální verze: 3/),
    ).toBeDefined();
    expect(screen.queryByTestId("revision-restore-preview")).toBeNull();
    expect(client.fetchRevisions).toHaveBeenCalledTimes(2);
  });

  it("disables undo and restore while the editor is dirty", async () => {
    await renderHistory(true);

    expect(
      screen.getByRole("button", { name: "Vrátit poslední změnu" }),
    ).toHaveProperty("disabled", true);
    expect(
      within(screen.getByTestId("revision-1")).getByRole("button", {
        name: "Obnovit tuto verzi",
      }),
    ).toHaveProperty("disabled", true);
  });
});
