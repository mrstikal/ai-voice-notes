// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import {
  type ScribeHookOptions,
  type ScribeStatus,
  type TranscriptSegment,
  type UseScribeReturn,
} from "@elevenlabs/react";
import { useEffect, useState } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import { DictationControls } from "../../src/components/voice/DictationControls";
import type { NoteDetail } from "../../src/lib/notes/client";
import { TITLE_MAX_GRAPHEMES } from "../../src/lib/notes/limits";
import { writeVadSilencePreference } from "../../src/lib/voice/preferences";
import { createFakeLockManager } from "../helpers/provider-mocks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const useScribeMock = vi.hoisted(() => vi.fn());

vi.mock("@elevenlabs/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elevenlabs/react")>();

  return { ...actual, useScribe: useScribeMock };
});

type ScribeConnection = NonNullable<
  ReturnType<UseScribeReturn["getConnection"]>
>;
type CommittedListener = (data: { text: string }) => void;

interface FakeConnection {
  readonly active: Set<CommittedListener>;
  readonly errorListeners: Set<(data: { error: string }) => void>;
  readonly registered: CommittedListener[];
  readonly handle: ScribeConnection;
}

function createFakeConnection(): FakeConnection {
  const active = new Set<CommittedListener>();
  const errorListeners = new Set<(data: { error: string }) => void>();
  const registered: CommittedListener[] = [];
  const handle = {
    on(event: string, listener: CommittedListener) {
      if (event === "committed_transcript") {
        active.add(listener);
        registered.push(listener);
      }

      if (event === "error") {
        errorListeners.add(
          listener as unknown as (data: { error: string }) => void,
        );
      }
    },
    off(event: string, listener: CommittedListener) {
      if (event === "committed_transcript") {
        active.delete(listener);
      }

      if (event === "error") {
        errorListeners.delete(
          listener as unknown as (data: { error: string }) => void,
        );
      }
    },
  } as unknown as ScribeConnection;

  return { active, errorListeners, registered, handle };
}

interface MockScribeInstance {
  options: ScribeHookOptions | null;
  readonly connections: FakeConnection[];
  readonly connect: Mock<UseScribeReturn["connect"]>;
  readonly disconnect: Mock<UseScribeReturn["disconnect"]>;
  readonly clearTranscripts: Mock<UseScribeReturn["clearTranscripts"]>;
  readonly getConnection: () => ScribeConnection | null;
  readonly emitPartial: (text: string) => void;
  readonly emitCommitted: (text: string, id?: string) => void;
  readonly emitLateCommittedFrom: (
    connectionIndex: number,
    text: string,
  ) => void;
  readonly emitError: (error: Error | Event) => void;
  readonly emitDisconnect: () => void;
}

const scribeInstances: MockScribeInstance[] = [];

function createMockScribeInstance(
  setStatus: (status: ScribeStatus) => void,
  setPartialTranscript: (text: string) => void,
  setCommittedTranscripts: (
    update: (current: TranscriptSegment[]) => TranscriptSegment[],
  ) => void,
  setProviderError: (error: string | null) => void,
): MockScribeInstance {
  const connections: FakeConnection[] = [];
  const instance: MockScribeInstance = {
    options: null,
    connections,
    connect: vi.fn<UseScribeReturn["connect"]>(async () => {
      connections.push(createFakeConnection());
      setStatus("connecting");
      setProviderError(null);
      instance.options?.onSessionStarted?.();
      setStatus("connected");
    }),
    disconnect: vi.fn<UseScribeReturn["disconnect"]>(() => {
      setStatus("disconnected");
      instance.options?.onDisconnect?.();
    }),
    clearTranscripts: vi.fn<UseScribeReturn["clearTranscripts"]>(() => {
      setPartialTranscript("");
      setCommittedTranscripts(() => []);
    }),
    getConnection: () => connections.at(-1)?.handle ?? null,
    emitPartial: (text) => {
      setPartialTranscript(text);
    },
    emitCommitted: (text, id = "segment-1") => {
      setCommittedTranscripts((current) => [
        ...current,
        {
          id,
          text,
          timestamp: Date.now(),
          isFinal: true,
        },
      ]);
      const connection = connections.at(-1);

      for (const listener of connection?.active ?? []) {
        listener({ text });
      }
    },
    emitLateCommittedFrom: (connectionIndex, text) => {
      const connection = connections[connectionIndex];

      for (const listener of connection?.registered ?? []) {
        listener({ text });
      }
    },
    emitError: (error) => {
      const message =
        error instanceof Error ? error.message : "Neznámá chyba poskytovatele.";
      setProviderError(message);
      const connection = connections.at(-1);

      if (connection && connection.errorListeners.size > 0) {
        for (const listener of connection.errorListeners) {
          listener({ error: message });
        }
        return;
      }

      instance.options?.onError?.(error);
    },
    emitDisconnect: () => {
      instance.options?.onDisconnect?.();
    },
  };

  return instance;
}

function useMockScribe(options: ScribeHookOptions): UseScribeReturn {
  const [status, setStatus] = useState<ScribeStatus>("disconnected");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [committedTranscripts, setCommittedTranscripts] = useState<
    TranscriptSegment[]
  >([]);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [instanceIndex] = useState(() => {
    scribeInstances.push(
      createMockScribeInstance(
        setStatus,
        setPartialTranscript,
        setCommittedTranscripts,
        setProviderError,
      ),
    );
    return scribeInstances.length - 1;
  });
  const instance = scribeInstances[instanceIndex]!;

  useEffect(() => {
    instance.options = options;
  }, [instance, options]);

  return {
    status,
    isConnected: status === "connected" || status === "transcribing",
    isTranscribing: status === "transcribing",
    isMuted: false,
    partialTranscript,
    committedTranscripts,
    error: providerError,
    connect: instance.connect,
    disconnect: instance.disconnect,
    mute: vi.fn(),
    unmute: vi.fn(),
    sendAudio: vi.fn(),
    commit: vi.fn(),
    clearTranscripts: instance.clearTranscripts,
    getConnection: instance.getConnection,
  };
}

const NOTE_ID = "11111111-1111-4111-8111-111111111111";

const baseNote: NoteDetail = {
  category: null,
  contentMd: "Text poznámky",
  contentPlain: "Text poznámky",
  createdAt: "2026-10-25T10:00:00.000Z",
  deletedAt: null,
  id: NOTE_ID,
  tags: [],
  title: "Původní název",
  updatedAt: "2026-10-25T10:00:00.000Z",
  version: 1,
};

interface PatchCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

let fetchMock: ReturnType<typeof vi.fn>;
let locks: ReturnType<typeof createFakeLockManager>;
let tokenCalls: number;
let patchCalls: PatchCall[];
let onNoteUpdated: Mock<(note: NoteDetail) => void>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const originalLocksDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "locks",
);

beforeEach(() => {
  scribeInstances.length = 0;
  window.localStorage.clear();
  tokenCalls = 0;
  patchCalls = [];
  onNoteUpdated = vi.fn<(note: NoteDetail) => void>();
  useScribeMock.mockImplementation((options: ScribeHookOptions) =>
    useMockScribe(options),
  );
  locks = createFakeLockManager();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks,
  });
  fetchMock = vi.fn().mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes("/api/elevenlabs/scribe-token")) {
        tokenCalls += 1;
        return jsonResponse({ token: `sutkn_title_${tokenCalls}` });
      }

      if (url.includes(`/api/notes/${NOTE_ID}/title`)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        patchCalls.push({ url, body });

        return jsonResponse({
          ...baseNote,
          contentMd: baseNote.contentMd,
          title: body.title,
          updatedAt: "2026-10-26T12:00:00.000Z",
          version: Number(body.expectedVersion) + 1,
        });
      }

      if (url === `/api/notes/${NOTE_ID}` && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patchCalls.push({ url, body });

        return jsonResponse({
          ...baseNote,
          contentMd: String(body.contentMd ?? baseNote.contentMd),
          title: String(body.title),
          updatedAt: "2026-10-26T12:00:00.000Z",
          version: Number(body.expectedVersion) + 1,
        });
      }

      if (url === `/api/notes/${NOTE_ID}` && init?.method === "GET") {
        return jsonResponse(baseNote);
      }

      return jsonResponse(
        { error: { code: "not_found", message: "Nenalezeno." } },
        404,
      );
    },
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();

  if (originalLocksDescriptor) {
    Object.defineProperty(navigator, "locks", originalLocksDescriptor);
  } else {
    delete (navigator as { locks?: unknown }).locks;
  }
});

function renderControls(
  overrides: {
    note?: NoteDetail;
    disabled?: boolean;
    onNoteUpdated?: (note: NoteDetail) => void;
  } = {},
) {
  return render(
    <DictationControls
      note={overrides.note ?? baseNote}
      onNoteUpdated={overrides.onNoteUpdated ?? onNoteUpdated}
      disabled={overrides.disabled}
    />,
  );
}

async function startDictation(container: HTMLElement) {
  const start = within(container).getByRole("button", {
    name: "Nadiktovat název",
  }) as HTMLButtonElement;

  await waitFor(() => expect(start.disabled).toBe(false));
  fireEvent.click(start);
  await waitFor(() =>
    expect(scribeInstances[0]?.connect).toHaveBeenCalledTimes(1),
  );
}

describe("DictationControls title capture", () => {
  it("uses the stored VAD threshold for the title session", async () => {
    writeVadSilencePreference(1.5);
    const { container } = renderControls();
    await startDictation(container);

    expect(scribeInstances[0]?.connect).toHaveBeenCalledWith(
      expect.objectContaining({ vadSilenceThresholdSecs: 1.5 }),
    );
  });

  it("does not mutate the title from partial text or an aborted capture", async () => {
    const { container } = renderControls();
    await startDictation(container);

    act(() => {
      scribeInstances[0]?.emitPartial("Nadiktovaný");
    });
    expect(within(container).getByTestId("title-partial").textContent).toBe(
      "Nadiktovaný",
    );

    act(() => {
      scribeInstances[0]?.emitPartial("Nadiktovaný název");
    });
    expect(within(container).getByTestId("title-partial").textContent).toBe(
      "Nadiktovaný název",
    );

    fireEvent.click(
      within(container).getByRole("button", { name: "Stop" }),
    );

    await waitFor(() =>
      expect(scribeInstances[0]?.disconnect).toHaveBeenCalledTimes(1),
    );
    expect(
      (within(container).getByRole("textbox", { name: "Název poznámky" }) as HTMLInputElement)
        .value,
    ).toBe("Původní název");
    expect(patchCalls).toHaveLength(0);
    expect(onNoteUpdated).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it("ignores a late committed transcript from a stopped session", async () => {
    const { container } = renderControls();
    await startDictation(container);

    fireEvent.click(
      within(container).getByRole("button", { name: "Stop" }),
    );
    await waitFor(() =>
      expect(scribeInstances[0]?.disconnect).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(
      within(container).getByRole("button", { name: "Nadiktovat název" }),
    );
    await waitFor(() =>
      expect(scribeInstances[0]?.connect).toHaveBeenCalledTimes(2),
    );

    act(() => {
      scribeInstances[0]?.emitLateCommittedFrom(
        0,
        "Text z předchozí relace",
      );
    });

    expect(
      (within(container).getByRole("textbox", { name: "Název poznámky" }) as HTMLInputElement)
        .value,
    ).toBe("Původní název");
    expect(patchCalls).toHaveLength(0);
    expect(
      within(container).getByRole("button", { name: "Stop" }),
    ).toBeTruthy();

    act(() => {
      scribeInstances[0]?.emitCommitted("Nový název");
    });

    await waitFor(() =>
      expect(
        (within(container).getByRole("textbox", { name: "Název poznámky" }) as HTMLInputElement)
          .value,
      ).toBe("Nový název"),
    );
  });

  it("persists a dictated title once with a voice revision", async () => {
    const { container } = renderControls();
    await startDictation(container);

    act(() => {
      scribeInstances[0]?.emitCommitted("Nadiktovaný název");
    });

    await waitFor(() =>
      expect(
        (within(container).getByRole("textbox", { name: "Název poznámky" }) as HTMLInputElement)
          .value,
      ).toBe("Nadiktovaný název"),
    );

    const saveButton = within(container).getByRole("button", {
      name: "Uložit název",
    });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);

    await waitFor(() => expect(patchCalls).toHaveLength(1));
    expect(patchCalls[0]?.url).toBe(`/api/notes/${NOTE_ID}/title`);
    expect(patchCalls[0]?.body).toEqual({
      title: "Nadiktovaný název",
      expectedVersion: 1,
    });
    expect(onNoteUpdated).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(within(container).getByText("Název byl uložen.")).toBeTruthy(),
    );
  });

  it("saves a manually typed title with a manual revision", async () => {
    const { container } = renderControls();
    const input = within(container).getByRole("textbox", {
      name: "Název poznámky",
    }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "Ruční název" } });
    expect(patchCalls).toHaveLength(0);

    fireEvent.click(
      within(container).getByRole("button", { name: "Uložit název" }),
    );

    await waitFor(() => expect(patchCalls).toHaveLength(1));
    expect(patchCalls[0]?.url).toBe(`/api/notes/${NOTE_ID}`);
    expect(patchCalls[0]?.body).toEqual({
      title: "Ruční název",
      contentMd: "Text poznámky",
      expectedVersion: 1,
    });
    expect(onNoteUpdated).toHaveBeenCalledTimes(1);
  });

  it("shows Czech permission guidance for the SDK's normalized error", async () => {
    const { container } = renderControls();
    await startDictation(container);

    act(() => {
      scribeInstances[0]?.emitError(new Error("Permission denied"));
    });

    await waitFor(() =>
      expect(
        within(container).getByText(/Přístup k mikrofonu byl zamítnut/u),
      ).toBeTruthy(),
    );
    expect(patchCalls).toHaveLength(0);
    expect(locks.heldNames.size).toBe(0);
  });

  it("requires a new Start and a new token after a lost connection", async () => {
    const { container } = renderControls();
    await startDictation(container);

    act(() => {
      scribeInstances[0]?.emitDisconnect();
    });

    await waitFor(() =>
      expect(
        within(container).getByText(/Spojení se přerušilo/u),
      ).toBeTruthy(),
    );
    expect(patchCalls).toHaveLength(0);
    expect(tokenCalls).toBe(1);
    expect(scribeInstances[0]?.connect).toHaveBeenCalledTimes(1);

    fireEvent.click(
      within(container).getByRole("button", { name: "Nadiktovat název" }),
    );
    await waitFor(() => expect(tokenCalls).toBe(2));
    expect(scribeInstances[0]?.connect).toHaveBeenCalledTimes(2);
  });

  it("disables Start with Czech guidance when Web Locks are unavailable", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
    const { container } = renderControls();

    await waitFor(() =>
      expect(within(container).getByText(/Web Locks/u)).toBeTruthy(),
    );
    const start = within(container).getByRole("button", {
      name: "Nadiktovat název",
    }) as HTMLButtonElement;

    expect(start.disabled).toBe(true);
    fireEvent.click(start);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(scribeInstances[0]?.connect).not.toHaveBeenCalled();
  });

  it("shares the cross-tab microphone lease with another note view", async () => {
    const first = renderControls();
    const second = renderControls();
    const firstStart = within(first.container).getByRole("button", {
      name: "Nadiktovat název",
    }) as HTMLButtonElement;
    const secondStart = within(second.container).getByRole("button", {
      name: "Nadiktovat název",
    }) as HTMLButtonElement;

    await waitFor(() => expect(firstStart.disabled).toBe(false));
    await waitFor(() => expect(secondStart.disabled).toBe(false));

    fireEvent.click(firstStart);
    await waitFor(() =>
      expect(scribeInstances[0]?.connect).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(secondStart);
    await waitFor(() =>
      expect(within(second.container).getByText(/jiná karta/u)).toBeTruthy(),
    );
    expect(scribeInstances[1]?.connect).not.toHaveBeenCalled();
    expect(tokenCalls).toBe(1);

    fireEvent.click(
      within(first.container).getByRole("button", { name: "Stop" }),
    );
    await waitFor(() => expect(locks.heldNames.size).toBe(0));

    fireEvent.click(secondStart);
    await waitFor(() =>
      expect(scribeInstances[1]?.connect).toHaveBeenCalledTimes(1),
    );
    expect(tokenCalls).toBe(2);
  });

  it("releases the microphone lease on unmount", async () => {
    const { container, unmount } = renderControls();
    await startDictation(container);
    expect(locks.heldNames.size).toBe(1);

    unmount();

    await waitFor(() =>
      expect(scribeInstances[0]?.disconnect).toHaveBeenCalledTimes(1),
    );
    expect(locks.heldNames.size).toBe(0);
  });

  it("updates an untouched title input when the note title changes", async () => {
    const { container, rerender } = renderControls();

    rerender(
      <DictationControls
        note={{ ...baseNote, title: "Jiný název", version: 2 }}
        onNoteUpdated={onNoteUpdated}
      />,
    );

    await waitFor(() =>
      expect(
        (within(container).getByRole("textbox", { name: "Název poznámky" }) as HTMLInputElement)
          .value,
      ).toBe("Jiný název"),
    );
    expect(patchCalls).toHaveLength(0);
  });

  it("keeps a dirty title input when the note changes externally", async () => {
    const { container, rerender } = renderControls();
    const input = within(container).getByRole("textbox", {
      name: "Název poznámky",
    }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "Rozpracovaný název" } });

    rerender(
      <DictationControls
        note={{ ...baseNote, title: "Jiný název", version: 2 }}
        onNoteUpdated={onNoteUpdated}
      />,
    );

    expect(input.value).toBe("Rozpracovaný název");
    expect(patchCalls).toHaveLength(0);
  });

  it("rejects an overlong dictated title without mutation", async () => {
    const { container } = renderControls();
    await startDictation(container);

    act(() => {
      scribeInstances[0]?.emitCommitted("a".repeat(TITLE_MAX_GRAPHEMES + 1));
    });

    await waitFor(() =>
      expect(
        within(container).getByText(/maximum je/u),
      ).toBeTruthy(),
    );
    expect(
      (within(container).getByRole("textbox", { name: "Název poznámky" }) as HTMLInputElement)
        .value,
    ).toBe("Původní název");
    expect(patchCalls).toHaveLength(0);
    expect(onNoteUpdated).not.toHaveBeenCalled();
  });

  it("disables capture while the editor has unsaved text", () => {
    const { container } = renderControls({ disabled: true });
    const start = within(container).getByRole("button", {
      name: "Nadiktovat název",
    }) as HTMLButtonElement;

    expect(start.disabled).toBe(true);
    expect(
      within(container).getByText(/Nejprve uložte nebo zrušte/u),
    ).toBeTruthy();
  });
});
