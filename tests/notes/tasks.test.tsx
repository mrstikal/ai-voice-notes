// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LlmOperation } from "../../src/lib/ai/schemas";
import type { NoteDetail } from "../../src/lib/notes/client";
import { readStoredDraft } from "../../src/lib/notes/draft";
import {
  ProposalApiError,
  type EditProposal,
} from "../../src/lib/notes/proposal-client";
import { hashNoteSource, resolveOperation } from "../../src/lib/notes/operations";
import { parseTaskVoiceCommand, parseVoiceCommands } from "../../src/lib/voice/commands";
import { INITIAL_VOICE_FORMAT_STATE } from "../../src/lib/voice/format-state";
import { TaskVoiceControls } from "../../src/components/notes/TaskVoiceControls";
import { NoteEditor } from "../../src/components/notes/NoteEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const emptyRectList = [] as unknown as DOMRectList;
const emptyRect = {
  bottom: 0,
  height: 0,
  left: 0,
  right: 0,
  top: 0,
  width: 0,
  x: 0,
  y: 0,
} as DOMRect;

if (!Range.prototype.getClientRects) {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => emptyRectList,
  });
}

if (!("getClientRects" in Text.prototype)) {
  Object.defineProperty(Text.prototype, "getClientRects", {
    configurable: true,
    value: () => emptyRectList,
  });
}

if (!("getBoundingClientRect" in Text.prototype)) {
  Object.defineProperty(Text.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => emptyRect,
  });
}

if (!Range.prototype.getBoundingClientRect) {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => emptyRect,
  });
}

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const PROPOSAL_ID = "22222222-2222-4222-8222-222222222222";

const note: NoteDetail = {
  category: null,
  contentMd: "- [ ] Koupit mléko\n- [x] Zavolat lékaři",
  contentPlain: "Koupit mléko Zavolat lékaři",
  createdAt: "2026-10-27T10:00:00.000Z",
  deletedAt: null,
  id: NOTE_ID,
  tags: [],
  title: "Úkoly",
  updatedAt: "2026-10-27T10:00:00.000Z",
  version: 1,
};

const taskOperation: LlmOperation = {
  checked: true,
  taskText: "Koupit mléko",
  type: "set_task_checked",
};

const proposalClient = vi.hoisted(() => ({
  confirmEditProposal: vi.fn(),
  createEditProposal: vi.fn(),
  rejectEditProposal: vi.fn(),
}));

const scribe = vi.hoisted(() => ({
  options: null as {
    onCommit: (segment: { text: string }, metadata: { commandLatencyMs: number | null }) => void;
  } | null,
  start: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
  clearTranscripts: vi.fn(),
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

vi.mock("@/components/voice/useScribeDictation", () => ({
  useScribeDictation: (options: typeof scribe.options) => {
    scribe.options = options;

    return {
      clearTranscripts: scribe.clearTranscripts,
      commit: vi.fn(),
      incompleteNotice: null,
      isStopping: false,
      partialTranscript: "",
      providerError: null,
      providerStatus: "disconnected",
      session: { error: null, status: "idle" },
      start: scribe.start,
      stop: scribe.stop,
      webLocksSupported: true,
    };
  },
}));

function proposal(overrides: Partial<EditProposal> = {}): EditProposal {
  return {
    afterMd: "- [x] Koupit mléko\n- [x] Zavolat lékaři",
    beforeMd: note.contentMd,
    createdAt: "2026-10-27T10:00:00.000Z",
    diff: {
      end: 4,
      inserted: "x",
      prefix: "- [",
      removed: " ",
      start: 3,
      suffix: "] Koupit mléko\n- [x] Zavolat lékaři",
    },
    expectedVersion: 1,
    expiresAt: "2026-10-27T10:05:00.000Z",
    id: PROPOSAL_ID,
    noteId: NOTE_ID,
    noteTitle: note.title,
    operation: taskOperation,
    originalHash: hashNoteSource(note.contentMd),
    selectedCandidate: null,
    status: "pending",
    updatedAt: "2026-10-27T10:00:00.000Z",
    ...overrides,
  };
}

function resolveTask(content: string, operation: LlmOperation) {
  return resolveOperation({ contentMd: content, operation });
}


beforeEach(() => {
  window.sessionStorage.clear();
  scribe.options = null;
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Czech task voice grammar", () => {
  it("recognizes mark-done and unmark phrases without affecting other commands", () => {
    expect(parseTaskVoiceCommand("Označ úkol Koupit mléko jako hotový.")).toEqual({
      checked: true,
      taskText: "Koupit mléko",
    });
    expect(
      parseTaskVoiceCommand("označit úkol „Zavolat lékaři“ jako splněný"),
    ).toEqual({
      checked: true,
      taskText: "Zavolat lékaři",
    });
    expect(parseTaskVoiceCommand("Zruš označení úkolu Koupit mléko")).toEqual({
      checked: false,
      taskText: "Koupit mléko",
    });
    expect(parseTaskVoiceCommand("zrušit označení úkolu Koupit mléko!")).toEqual({
      checked: false,
      taskText: "Koupit mléko",
    });
    expect(parseTaskVoiceCommand("označ úkol jako hotový")).toBeNull();
    expect(parseTaskVoiceCommand("Připravit migrace.")).toBeNull();
  });

  it("treats vytvoř seznam úkolů as the task-list formatting command", () => {
    const result = parseVoiceCommands(
      "Vytvoř seznam úkolů.",
      INITIAL_VOICE_FORMAT_STATE,
    );

    expect(result.instructions).toEqual([
      { kind: "list_start", variant: "task" },
    ]);
  });
});

describe("P22 task resolution", () => {
  it("toggles only the task whose current state differs", () => {
    const content = [
      "- [ ] Koupit mléko",
      "- [x] Koupit mléko",
      "- [ ] Zavolat lékaři",
    ].join("\n");

    const done = resolveTask(content, taskOperation);

    expect(done.status).toBe("resolved");
    if (done.status !== "resolved") return;
    expect(done.afterMd).toBe(
      [
        "- [x] Koupit mléko",
        "- [x] Koupit mléko",
        "- [ ] Zavolat lékaři",
      ].join("\n"),
    );
    expect(done.diff.inserted).toBe("x");
    expect(done.diff.removed).toBe(" ");

    const undone = resolveTask(content, {
      checked: false,
      taskText: "Koupit mléko",
      type: "set_task_checked",
    });

    expect(undone.status).toBe("resolved");
    if (undone.status !== "resolved") return;
    expect(undone.afterMd).toBe(
      [
        "- [ ] Koupit mléko",
        "- [ ] Koupit mléko",
        "- [ ] Zavolat lékaři",
      ].join("\n"),
    );
  });

  it("keeps duplicate open tasks ambiguous and never treats fenced code as a task", () => {
    const duplicates = "- [ ] Koupit mléko\n- [ ] Koupit mléko";
    const ambiguous = resolveTask(duplicates, taskOperation);

    expect(ambiguous.status).toBe("ambiguous");
    if (ambiguous.status !== "ambiguous") return;
    expect(ambiguous.candidates).toHaveLength(2);
    expect(ambiguous.candidates.map((candidate) => candidate.checked)).toEqual([
      false,
      false,
    ]);

    const fenced = [
      "```",
      "- [ ] Koupit mléko",
      "```",
      "",
      "- [ ] Zavolat lékaři",
    ].join("\n");
    expect(resolveTask(fenced, taskOperation)).toMatchObject({
      status: "no_match",
    });
  });

  it("reports an already-matching task instead of creating an unchanged toggle", () => {
    expect(
      resolveTask("- [x] Koupit mléko", taskOperation),
    ).toMatchObject({
      message: "Úkol už je označený jako hotový.",
      status: "no_match",
    });
  });
});

describe("NoteEditor checkbox toggle", () => {
  it("saves exactly one changed task as a named manual revision without draft noise", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as {
          contentMd: string;
        };

        return new Response(
          JSON.stringify({
            ...note,
            contentMd: payload.contentMd,
            contentPlain: "Koupit mléko Zavolat lékaři",
            updatedAt: "2026-10-27T11:00:00.000Z",
            version: 2,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<NoteEditor note={note} />);

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));
    const visual = await screen.findByRole("textbox", {
      name: "Vizuální editor poznámky",
    });
    const checkboxes = Array.from(
      visual.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );

    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[0]!);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/notes/${NOTE_ID}`);
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      contentMd: "- [x] Koupit mléko\n- [x] Zavolat lékaři",
      expectedVersion: 1,
      title: note.title,
    });

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("verze 2");
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const updatedCheckboxes = Array.from(
      visual.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(updatedCheckboxes.map((checkbox) => checkbox.checked)).toEqual([
      true,
      true,
    ]);

    await user.click(screen.getByRole("button", { name: "Zdrojový režim" }));
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Obsah (Markdown)") as HTMLTextAreaElement)
          .value,
      ).toBe("- [x] Koupit mléko\n- [x] Zavolat lékaři");
    });
  });
});

describe("NoteEditor task toggle detection", () => {
  it("classifies the first toggle as a named save even with links and ordered lists", async () => {
    const content = [
      "- odkaz [Example](https://example.com)",
      "",
      "1. první",
      "2. druhá",
      "",
      "- [ ] Koupit mléko",
      "- [x] Zavolat lékaři",
    ].join("\n");
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as {
          contentMd: string;
          draft?: boolean;
        };

        return new Response(
          JSON.stringify({
            ...note,
            contentMd: payload.contentMd,
            contentPlain: "odkaz první druhá Koupit mléko Zavolat lékaři",
            updatedAt: "2026-10-27T12:00:00.000Z",
            version: 2,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<NoteEditor note={{ ...note, contentMd: content }} />);
    fireEvent.click(screen.getByRole("button", { name: "Vizuální režim" }));
    const visual = await screen.findByRole("textbox", {
      name: "Vizuální editor poznámky",
    });
    fireEvent.click(
      visual.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const payload = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as { contentMd: string; draft?: boolean; expectedVersion: number };

    expect(payload.draft).toBeUndefined();
    expect(payload.expectedVersion).toBe(1);
    expect(payload.contentMd).toContain("- [x] Koupit mléko");
    expect(payload.contentMd).toContain("[Example](https://example.com)");
    expect(payload.contentMd).toContain("1. první");
  });
});

describe("NoteEditor task toggle serialization and recovery", () => {
  it("waits for an in-flight draft autosave before saving the toggle", async () => {
    const draftContent = `${note.contentMd}\n\nDraft`;
    let resolveDraft!: (response: Response) => void;
    const draftResponse = new Promise<Response>((resolve) => {
      resolveDraft = resolve;
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as {
          contentMd: string;
          draft?: boolean;
        };

        if (payload.draft === true) {
          return draftResponse;
        }

        return new Response(
          JSON.stringify({
            ...note,
            contentMd: payload.contentMd,
            contentPlain: "Koupit mléko Zavolat lékaři Draft",
            updatedAt: "2026-10-27T12:00:00.000Z",
            version: 3,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<NoteEditor note={note} />);
    const source = screen.getByLabelText("Obsah (Markdown)") as HTMLTextAreaElement;
    fireEvent.change(source, { target: { value: draftContent } });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).draft,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Vizuální režim" }));
    const visual = await screen.findByRole("textbox", {
      name: "Vizuální editor poznámky",
    });
    fireEvent.click(
      visual.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDraft(
        new Response(
          JSON.stringify({
            ...note,
            contentMd: draftContent,
            contentPlain: "Koupit mléko Zavolat lékaři Draft",
            updatedAt: "2026-10-27T11:30:00.000Z",
            version: 2,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const toggleInit = fetchMock.mock.calls[1]?.[1];
    const togglePayload = JSON.parse(String(toggleInit?.body)) as {
      contentMd: string;
      draft?: boolean;
      expectedVersion: number;
    };

    expect(togglePayload.draft).toBeUndefined();
    expect(togglePayload.expectedVersion).toBe(2);
    expect(togglePayload.contentMd).toBe(
      `- [x] Koupit mléko\n- [x] Zavolat lékaři\n\nDraft`,
    );
  });

  it("keeps a failed toggle as a recoverable draft and re-arms autosave", async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "internal",
              message: "Serverovou změnu se nepodařilo uložit.",
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 500,
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<NoteEditor note={note} />);
    fireEvent.click(screen.getByRole("button", { name: "Vizuální režim" }));
    const visual = await screen.findByRole("textbox", {
      name: "Vizuální editor poznámky",
    });
    fireEvent.click(
      visual.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!,
    );

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "Změna úkolu zůstala v editoru",
      );
    });

    const draft = readStoredDraft(NOTE_ID);
    expect(draft?.contentMd).toBe(
      "- [x] Koupit mléko\n- [x] Zavolat lékaři",
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryPayload = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body),
    ) as { contentMd: string; draft?: boolean };
    expect(retryPayload.draft).toBe(true);
    expect(retryPayload.contentMd).toBe(
      "- [x] Koupit mléko\n- [x] Zavolat lékaři",
    );
  });
});

describe("TaskVoiceControls", () => {
  it("turns a recognized committed phrase into a confirmed one-task change", async () => {
    const user = userEvent.setup();
    const onApplied = vi.fn();
    const onNoteUpdated = vi.fn();
    proposalClient.createEditProposal.mockResolvedValue({
      ...proposal(),
      confirmationNonce: "ui-nonce",
    });
    proposalClient.confirmEditProposal.mockResolvedValue({
      note: { ...note, contentMd: proposal().afterMd, version: 2 },
      proposal: proposal({ status: "applied" }),
    });

    render(
      <TaskVoiceControls
        note={note}
        onApplied={onApplied}
        onNoteUpdated={onNoteUpdated}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Nadiktovat změnu úkolu" }),
    );
    expect(scribe.start).toHaveBeenCalledTimes(1);

    act(() => {
      scribe.options?.onCommit(
        { text: "Označ úkol Koupit mléko jako hotový." },
        { commandLatencyMs: null },
      );
    });

    await waitFor(() => {
      expect(proposalClient.createEditProposal).toHaveBeenCalledWith(NOTE_ID, {
        expectedVersion: 1,
        operation: taskOperation,
      });
    });
    expect(screen.getByTestId("proposal-preview")).not.toBeNull();
    expect(
      screen.getByTestId("proposal-diff").querySelector("ins")?.textContent,
    ).toBe("x");
    expect(onNoteUpdated).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Potvrdit" }));

    await waitFor(() => {
      expect(proposalClient.confirmEditProposal).toHaveBeenCalledWith(
        NOTE_ID,
        PROPOSAL_ID,
        { confirmationNonce: "ui-nonce", expectedVersion: 1 },
      );
    });
    expect(onNoteUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2 }),
    );
    expect(onApplied).toHaveBeenCalledWith("Změna úkolu byla uložena.");
  });

  it("binds duplicate candidates to the version and source hash without changing the note", async () => {
    const user = userEvent.setup();
    const onNoteUpdated = vi.fn();
    proposalClient.createEditProposal
      .mockRejectedValueOnce(
        new ProposalApiError(409, "proposal_ambiguous", "Více úkolů.", {
          candidates: [
            {
              blockIndex: -1,
              checked: false,
              id: "t0",
              ordinal: 1,
              snippet: "Koupit mléko",
              text: "Koupit mléko",
            },
            {
              blockIndex: -1,
              checked: false,
              id: "t2",
              ordinal: 2,
              snippet: "Koupit mléko",
              text: "Koupit mléko",
            },
          ],
          noteVersion: 1,
          sourceHash: hashNoteSource(note.contentMd),
        }),
      )
      .mockResolvedValueOnce({
        ...proposal(),
        confirmationNonce: "candidate-nonce",
      });

    render(
      <TaskVoiceControls note={note} onNoteUpdated={onNoteUpdated} />,
    );

    act(() => {
      scribe.options?.onCommit(
        { text: "označ úkol Koupit mléko jako hotový" },
        { commandLatencyMs: null },
      );
    });

    expect((await screen.findByText("Text úkolu odpovídá více úkolům")).textContent).toContain("Text úkolu odpovídá více úkolům");
    expect(onNoteUpdated).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^2\./ }));

    await waitFor(() => {
      expect(proposalClient.createEditProposal).toHaveBeenLastCalledWith(
        NOTE_ID,
        {
          candidateId: "t2",
          expectedSourceHash: hashNoteSource(note.contentMd),
          expectedVersion: 1,
          operation: taskOperation,
        },
      );
    });
    expect(onNoteUpdated).not.toHaveBeenCalled();
    expect(screen.getByTestId("proposal-preview")).not.toBeNull();
  });

  it("hides a stale proposal instead of offering a confirm that would fail", async () => {
    const onNoteUpdated = vi.fn();
    proposalClient.createEditProposal.mockResolvedValue({
      ...proposal(),
      confirmationNonce: "stale-nonce",
    });

    const view = render(
      <TaskVoiceControls note={note} onNoteUpdated={onNoteUpdated} />,
    );

    act(() => {
      scribe.options?.onCommit(
        { text: "označ úkol Koupit mléko jako hotový" },
        { commandLatencyMs: null },
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("proposal-preview")).not.toBeNull();
    });

    view.rerender(
      <TaskVoiceControls
        note={{ ...note, version: 2 }}
        onNoteUpdated={onNoteUpdated}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("proposal-preview")).toBeNull();
    });
    expect(screen.getByTestId("task-voice-stale").textContent).toContain(
      "Poznámka se mezitím změnila",
    );
    expect(proposalClient.confirmEditProposal).not.toHaveBeenCalled();
  });

  it("shows Czech guidance for an unrecognized command and never creates a proposal", async () => {
    render(<TaskVoiceControls note={note} onNoteUpdated={vi.fn()} />);

    act(() => {
      scribe.options?.onCommit(
        { text: "Připravit migrace." },
        { commandLatencyMs: null },
      );
    });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Příkaz nebyl rozpoznán",
    );
    expect(proposalClient.createEditProposal).not.toHaveBeenCalled();
  });
});
