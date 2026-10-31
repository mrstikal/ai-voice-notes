// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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

import { NoteEditor } from "../../src/components/notes/NoteEditor";
import {
  getVoiceDiagnosticsSnapshot,
  resetVoiceDiagnostics,
} from "../../src/lib/voice/diagnostics";
import type { NoteDetail } from "../../src/lib/notes/client";
import {
  CONTENT_MAX_GRAPHEMES,
  countGraphemes,
} from "../../src/lib/notes/limits";
import { parseNoteMarkdown } from "../../src/lib/notes/markdown";
import {
  VoiceFormattingSession,
  applyVoicePartsToMarkdown,
} from "../../src/lib/voice/transcript-session";
import { CZECH_COMMAND_FIXTURES } from "../fixtures/czech-commands";
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
type CommittedListener = (data: { text: string; id?: string }) => void;

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
      instance.options?.onPartialTranscript?.({ text });
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
const LIMIT_LABEL = CONTENT_MAX_GRAPHEMES.toLocaleString("cs-CZ");

function baseNote(contentMd: string): NoteDetail {
  return {
    category: null,
    contentMd,
    contentPlain: contentMd,
    createdAt: "2026-10-25T10:00:00.000Z",
    deletedAt: null,
    id: NOTE_ID,
    tags: [],
    title: "Testovací poznámka",
    updatedAt: "2026-10-25T10:00:00.000Z",
    version: 1,
  };
}

interface PatchCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

let fetchMock: ReturnType<typeof vi.fn>;
let locks: ReturnType<typeof createFakeLockManager>;
let tokenCalls: number;
let patchCalls: PatchCall[];

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
  tokenCalls = 0;
  patchCalls = [];
  resetVoiceDiagnostics();
  window.localStorage.clear();
  window.sessionStorage.clear();
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
        return jsonResponse({ token: `sutkn_integration_${tokenCalls}` });
      }

      if (url.includes(`/api/notes/${NOTE_ID}`) && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patchCalls.push({ url, body });

        return jsonResponse({
          ...baseNote(String(body.contentMd ?? "")),
          updatedAt: "2026-10-26T12:00:00.000Z",
          version: Number(body.expectedVersion) + 1,
        });
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();

  if (originalLocksDescriptor) {
    Object.defineProperty(navigator, "locks", originalLocksDescriptor);
  } else {
    delete (navigator as { locks?: unknown }).locks;
  }
});

function sourceTextarea(): HTMLTextAreaElement {
  return screen.getByLabelText("Obsah (Markdown)") as HTMLTextAreaElement;
}

function insertAtEndCheckbox(): HTMLInputElement {
  return screen.getByRole("checkbox", {
    name: "Vložit na konec",
  }) as HTMLInputElement;
}

async function startBodyDictation(
  container: HTMLElement,
): Promise<MockScribeInstance> {
  const start = within(container).getByRole("button", {
    name: "Diktovat text",
  }) as HTMLButtonElement;

  await waitFor(() => expect(start.disabled).toBe(false));
  fireEvent.click(start);
  await waitFor(() =>
    expect(scribeInstances[0]?.connect).toHaveBeenCalledTimes(1),
  );

  return scribeInstances[0]!;
}

async function emitCommitted(
  instance: MockScribeInstance,
  text: string,
  id?: string,
): Promise<void> {
  await act(async () => {
    instance.emitCommitted(text, id);
  });
}

async function emitPartial(
  instance: MockScribeInstance,
  text: string,
): Promise<void> {
  await act(async () => {
    instance.emitPartial(text);
  });
}

const scriptASegments = CZECH_COMMAND_FIXTURES.find(
  (fixture) =>
    fixture.name === "Script A produces the expected semantic instructions",
)!.segments;

const scriptAExpected = [
  "Ruční text.",
  "",
  "## Plán migrace",
  "",
  "V první fázi ověříme databázi.",
  "",
  "**Pozor na kompatibilitu API.**",
  "",
  "- [ ] Připravit migrace",
  "- [ ] Napsat testy",
].join("\n");

describe("P17 formatting integration", () => {
  it("renders Script A only from committed segments as Markdown and tasks", async () => {
    const { container } = render(<NoteEditor note={baseNote("Ruční text.")} />);
    fireEvent.click(insertAtEndCheckbox());
    const instance = await startBodyDictation(container);

    await emitPartial(instance, "Nadpis. Plán migrace.");
    expect(sourceTextarea().value).toBe("Ruční text.");
    expect(screen.queryByTestId("voice-command-feedback")).toBeNull();

    for (const segment of scriptASegments) {
      await emitCommitted(instance, segment);
    }

    expect(sourceTextarea().value).toBe(scriptAExpected);
    expect(screen.getByTestId("voice-command-feedback").textContent).toContain(
      "Nadpis H2: Plán migrace",
    );
    expect(screen.getByTestId("voice-command-feedback").textContent).toContain(
      "Konec úkolů",
    );
    expect(screen.getByTestId("voice-insert-mode").textContent).toContain(
      "na konec",
    );

    const expectedCount = parseNoteMarkdown(scriptAExpected).graphemeCount;
    await waitFor(() =>
      expect(screen.getByTestId("note-grapheme-counter").textContent).toContain(
        `${expectedCount.toLocaleString("cs-CZ")} / ${LIMIT_LABEL}`,
      ),
    );

    await waitFor(() => expect(patchCalls.length).toBeGreaterThan(0), {
      timeout: 3_000,
    });
    expect(patchCalls.at(-1)?.body.contentMd).toBe(scriptAExpected);
  });

  it("keeps an embedded stop word as text and releases the mic on standalone stop", async () => {
    const { container } = render(<NoteEditor note={baseNote("Ruční text.")} />);
    fireEvent.click(insertAtEndCheckbox());
    const instance = await startBodyDictation(container);

    await emitCommitted(instance, "Slovo stop použijeme v ukázce.");
    expect(sourceTextarea().value).toContain("Slovo stop použijeme v ukázce.");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();

    await emitCommitted(instance, "Stop.");
    await waitFor(() => expect(instance.disconnect).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull(),
    );
    expect(sourceTextarea().value).not.toContain("Stop.");

    const beforeLate = sourceTextarea().value;
    await act(async () => {
      instance.emitLateCommittedFrom(0, "Pozdní věta.");
    });
    expect(sourceTextarea().value).toBe(beforeLate);
    expect(getVoiceDiagnosticsSnapshot().manualReconnectCount).toBe(0);
  });

  it("marks the live partial count as approximate and counts saved graphemes exactly", async () => {
    const { container } = render(<NoteEditor note={baseNote("Ruční text.")} />);
    fireEvent.click(insertAtEndCheckbox());
    const instance = await startBodyDictation(container);
    const partial = "Příliš žluťoučký kůň 🐎";
    const baseCount = parseNoteMarkdown("Ruční text.").graphemeCount;
    const expectedApproximate = baseCount + countGraphemes(partial);

    await emitPartial(instance, partial);
    const approximate = screen.getByTestId("voice-approximate-count").textContent;

    expect(approximate).toContain("Přibližně");
    expect(approximate).toContain(
      `${expectedApproximate.toLocaleString("cs-CZ")} / ${LIMIT_LABEL}`,
    );
    expect(sourceTextarea().value).toBe("Ruční text.");

    const committed = "Příliš žluťoučký kůň 🐎.";
    await emitCommitted(instance, committed);
    const expectedSaved = `Ruční text. ${committed}`;
    expect(sourceTextarea().value).toBe(expectedSaved);

    const savedCount = parseNoteMarkdown(expectedSaved).graphemeCount;
    await waitFor(() =>
      expect(screen.getByTestId("note-grapheme-counter").textContent).toContain(
        `${savedCount.toLocaleString("cs-CZ")} / ${LIMIT_LABEL}`,
      ),
    );
  });

  it("rejects an over-limit voice insert without deleting earlier content", async () => {
    const initial = "a".repeat(CONTENT_MAX_GRAPHEMES - 10);
    const { container } = render(<NoteEditor note={baseNote(initial)} />);
    fireEvent.click(insertAtEndCheckbox());
    const instance = await startBodyDictation(container);

    await emitCommitted(instance, "b".repeat(20));

    expect((await screen.findByRole("alert")).textContent).toContain(
      `Diktovaný text by překročil limit ${LIMIT_LABEL} viditelných znaků`,
    );
    expect(sourceTextarea().value).toBe(initial);
    await waitFor(() => expect(instance.disconnect).toHaveBeenCalled());

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(patchCalls).toHaveLength(0);
  });

  it("passes the selected VAD threshold to the next Scribe session", async () => {
    const { container } = render(<NoteEditor note={baseNote("Ruční text.")} />);
    const select = screen.getByTestId("vad-silence-select") as HTMLSelectElement;

    expect(select.value).toBe("1.2");
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      "0.8",
      "1.2",
      "1.5",
    ]);

    fireEvent.change(select, { target: { value: "1.5" } });
    expect(select.value).toBe("1.5");

    const instance = await startBodyDictation(container);
    expect(instance.connect).toHaveBeenCalledWith(
      expect.objectContaining({ vadSilenceThresholdSecs: 1.5 }),
    );
  });

  it("counts manual reconnects only on a new Start and records EOU latency", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(1_000));

    const { container } = render(<NoteEditor note={baseNote("Ruční text.")} />);
    const instance = await startBodyDictation(container);

    expect(getVoiceDiagnosticsSnapshot().manualReconnectCount).toBe(0);

    await emitPartial(instance, "První");
    vi.setSystemTime(new Date(1_250));
    await emitCommitted(instance, "První věta.");

    expect(getVoiceDiagnosticsSnapshot().lastCommitLatencyMs).toBe(250);
    expect(getVoiceDiagnosticsSnapshot().lastCommandLatencyMs).toBe(250);

    await act(async () => {
      instance.emitError(
        new Error("WebSocket closed unexpectedly: 1006 - No reason provided"),
      );
    });
    await waitFor(() =>
      expect(screen.getByText(/Spojení se přerušilo/)).toBeTruthy(),
    );
    expect(getVoiceDiagnosticsSnapshot().manualReconnectCount).toBe(0);

    fireEvent.click(
      within(container).getByRole("button", { name: "Diktovat text" }),
    );
    await waitFor(() => expect(instance.connect).toHaveBeenCalledTimes(2));

    expect(getVoiceDiagnosticsSnapshot().manualReconnectCount).toBe(1);
    expect(screen.getByTestId("voice-diagnostics").textContent).toContain(
      "ruční reconnecty (všechna diktování) 1",
    );
  });
});

describe("P17 pure Markdown rendering", () => {
  it("applies the Script A instruction stream without losing list continuation", () => {
    const session = new VoiceFormattingSession();
    let markdown = "Ruční text.";
    let cursor = markdown.length;

    for (const segment of scriptASegments) {
      const batch = session.accept(segment);
      const applied = applyVoicePartsToMarkdown(
        markdown,
        cursor,
        batch.parts,
      );
      markdown = applied.content;
      cursor = applied.cursor;
    }

    expect(markdown).toBe(scriptAExpected);
  });

  it("keeps a paragraph boundary after a closed list when a line break follows", () => {
    const session = new VoiceFormattingSession();
    let markdown = "";
    let cursor = 0;

    for (const segment of [
      "Začni seznam.",
      "První položka.",
      "Konec seznamu.",
      "Nový řádek.",
      "Další věta.",
    ]) {
      const batch = session.accept(segment);
      const applied = applyVoicePartsToMarkdown(
        markdown,
        cursor,
        batch.parts,
      );
      markdown = applied.content;
      cursor = applied.cursor;
    }

    expect(markdown).toBe("- První položka\n\nDalší věta.");
  });

  it("keeps an explicit list end across a spoken stop and a new session", () => {
    const session = new VoiceFormattingSession();
    let markdown = "";
    let cursor = 0;

    for (const segment of [
      "Začni seznam.",
      "První položka.",
      "Konec seznamu.",
      "Stop.",
    ]) {
      const batch = session.accept(segment);
      const applied = applyVoicePartsToMarkdown(
        markdown,
        cursor,
        batch.parts,
      );
      markdown = applied.content;
      cursor = applied.cursor;
    }

    session.flush();
    session.startNewSession();

    const batch = session.accept("Další věta.");
    const applied = applyVoicePartsToMarkdown(markdown, cursor, batch.parts);

    expect(applied.content).toBe("- První položka\n\nDalší věta.");
  });

  it("strips only final sentence punctuation from composed list items", () => {
    const session = new VoiceFormattingSession();
    const parts = [
      ...session.accept("Začni seznam.").parts,
      ...session.accept("Koupit mléko.").parts,
      ...session.accept("Chléb.").parts,
      ...session.accept("Konec seznamu.").parts,
    ];
    const applied = applyVoicePartsToMarkdown("", 0, parts);

    expect(applied.content).toBe("- Koupit mléko. Chléb");
  });
});
