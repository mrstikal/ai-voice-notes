// @vitest-environment jsdom

import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scribe = vi.hoisted(() => ({
  incompleteNotice: null as string | null,
  onIncompleteNotice: null as ((notice: string | null) => void) | null,
  partialTranscript: "",
  start: vi.fn(),
  stop: vi.fn(async () => undefined),
}));

vi.mock("@/components/voice/useScribeDictation", () => ({
  useScribeDictation: (options: {
    onIncompleteNotice?: (notice: string | null) => void;
  }) => {
    scribe.onIncompleteNotice = options.onIncompleteNotice ?? null;

    return {
    commit: vi.fn(),
    clearTranscripts: vi.fn(),
    incompleteNotice: scribe.incompleteNotice,
    isStopping: false,
    partialTranscript: scribe.partialTranscript,
    providerError: null,
    providerStatus: "disconnected",
    session: {
      error: null,
      notice: null,
      startedAt: null,
      status: "idle",
    },
    start: scribe.start,
    stop: scribe.stop,
    webLocksSupported: true,
    };
  },
}));

import { ChainedComparison } from "../../src/components/voice-agent/ChainedComparison";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

class FakeAudio {
  static readonly instances: FakeAudio[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = false;
  src = "";

  constructor() {
    FakeAudio.instances.push(this);
  }

  pause(): void {
    this.paused = true;
  }
  play(): Promise<void> {
    return Promise.resolve();
  }
}

let fetchMock: ReturnType<typeof vi.fn>;
let turn = 0;
let confirmCalls = 0;

function outcome(body: Record<string, unknown>) {
  return jsonResponse({ kind: "turn", outcome: body });
}

function installFetch(): void {
  turn = 0;
  confirmCalls = 0;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url === "/api/tts") {
      return {
        blob: async () => new Blob(["mp3"]),
        headers: new Headers({ "content-type": "audio/mpeg" }),
        json: async () => ({}),
        ok: true,
        status: 200,
      } as Response;
    }

    if (url === "/api/voice-agent/chained") {
      turn += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;

      if (body.kind === "summary") {
        return jsonResponse({
          kind: "summary",
          summary: {
            noteId: "11111111-1111-4111-8111-111111111111",
            noteTitle: "Migrace",
            noteVersion: 3,
            sourceGraphemes: 10,
            speechText: "Shrnutí migrace.",
            summaryText: "Shrnutí migrace.",
          },
        });
      }

      if (turn === 1) {
        return outcome({
          empty: false,
          intent: { action: "search_notes", query: "migrace" },
          kind: "search",
          query: "migrace",
          results: [
            {
              noteId: "11111111-1111-4111-8111-111111111111",
              preview: "Migrace databáze.",
              title: "Migrace",
            },
            {
              noteId: "22222222-2222-4222-8222-222222222222",
              preview: "Migrace API.",
              title: "Migrace API",
            },
          ],
          speechText: null,
        });
      }

      if (turn === 2) {
        return outcome({
          intent: {
            action: "read_note_section",
            section: "last_paragraph",
          },
          kind: "section",
          section: {
            message: null,
            noteId: "11111111-1111-4111-8111-111111111111",
            section: "last_paragraph",
            status: "ok",
            text: "Poslední odstavec o API.",
            title: "Migrace",
            truncated: false,
            version: 3,
          },
          speechText: "Poslední odstavec o API.",
        });
      }

      return outcome({
        intent: {
          action: "propose_edit",
          operation: {
            text: "- [ ] Koupit mléko",
            type: "append_bounded_section",
          },
        },
        kind: "proposal",
        proposal: {
          afterMd: "Migrace\n\n- [ ] Koupit mléko",
          beforeMd: "Migrace",
          confirmationNonce: "n".repeat(43),
          createdAt: "2026-10-30T12:00:00.000Z",
          diff: {
            end: 8,
            inserted: "\n\n- [ ] Koupit mléko",
            prefix: "Migrace",
            removed: "",
            start: 8,
            suffix: "",
          },
          expectedVersion: 3,
          expiresAt: "2026-10-30T12:05:00.000Z",
          id: "33333333-3333-4333-8333-333333333333",
          noteId: "11111111-1111-4111-8111-111111111111",
          noteTitle: "Migrace",
          operation: {
            text: "- [ ] Koupit mléko",
            type: "append_bounded_section",
          },
          originalHash: "a".repeat(64),
          selectedCandidate: null,
          status: "pending",
          updatedAt: "2026-10-30T12:00:00.000Z",
        },
        speechText: "Návrh je připravený v panelu.",
      });
    }

    if (url.includes("/confirm")) {
      confirmCalls += 1;

      return jsonResponse({
        note: { id: "11111111-1111-4111-8111-111111111111", version: 4 },
        ok: true,
        proposal: { status: "applied" },
      });
    }

    if (url.endsWith("/revisions")) {
      return jsonResponse({
        canUndo: true,
        currentSnapshot: {
          category: null,
          contentMd: "Migrace",
          tags: [],
          title: "Migrace",
        },
        currentVersion: 4,
        revisions: [],
        undoRevisionId: "44444444-4444-4444-8444-444444444444",
      });
    }

    if (url.includes("/restore")) {
      return jsonResponse({
        category: null,
        contentMd: "Migrace",
        contentPlain: "Migrace",
        createdAt: "2026-10-30T12:00:00.000Z",
        deletedAt: null,
        id: "11111111-1111-4111-8111-111111111111",
        tags: [],
        title: "Migrace",
        updatedAt: "2026-10-30T12:00:00.000Z",
        version: 5,
      });
    }

    return jsonResponse(
      { error: { code: "not_found", message: "Nenalezeno." } },
      404,
    );
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  FakeAudio.instances.length = 0;
  scribe.incompleteNotice = null;
  scribe.partialTranscript = "";
  installFetch();
  vi.stubGlobal("Audio", FakeAudio);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderMode() {
  return render(
    createElement(ChainedComparison, {
      defaultTtsVoice: "sarah",
      ttsConfigured: true,
      ttsVoices: [
        { availability: "available", id: "sarah", label: "Sarah" },
        { availability: "available", id: "george", label: "George" },
      ],
    }),
  );
}

async function send(text: string): Promise<void> {
  fireEvent.change(screen.getByLabelText("Přepis příkazu"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: "Odeslat příkaz" }));
}

describe("P52 chained comparison UI", () => {
  it("runs find -> select -> read -> proposal -> approve -> Undo without a session", async () => {
    renderMode();

    await send("Najdi migraci.");
    expect(await screen.findByText("Migrace API")).toBeDefined();
    fireEvent.click(screen.getAllByRole("button", { name: "Vybrat" })[0]!);
    expect(screen.getAllByText(/Vybraná poznámka/).length).toBeGreaterThan(0);

    await send("Přečti poslední odstavec.");
    expect(
      await screen.findByText("Poslední odstavec o API."),
    ).toBeDefined();

    await send("Přidej úkol koupit mléko.");
    expect(await screen.findByTestId("chained-proposal")).toBeDefined();
    expect(confirmCalls).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Potvrdit" }));
    expect(await screen.findByText(/verzi 4/)).toBeDefined();
    expect(confirmCalls).toBe(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Vrátit poslední změnu" }),
    );
    expect(await screen.findByText(/verzi 5/)).toBeDefined();

    const chainedBodies = fetchMock.mock.calls
      .filter(([input]) => String(input).includes("/api/voice-agent/chained"))
      .map(
        ([, init]) =>
          JSON.parse(String((init as RequestInit).body)) as Record<
            string,
            unknown
          >,
      );
    expect(chainedBodies.every((body) => !("sessionId" in body))).toBe(true);
    expect(chainedBodies.every((body) => !("openaiSessionId" in body))).toBe(
      true,
    );
  });

  it("stops chained TTS before opening the microphone for the next turn", async () => {
    fetchMock.mockImplementationOnce(async () =>
      outcome({
        intent: {
          action: "read_note_section",
          section: "last_paragraph",
        },
        kind: "section",
        section: {
          message: null,
          noteId: "11111111-1111-4111-8111-111111111111",
          section: "last_paragraph",
          status: "ok",
          text: "Poslední odstavec o API.",
          title: "Migrace",
          truncated: false,
          version: 3,
        },
        speechText: "Poslední odstavec o API.",
      }),
    );
    renderMode();
    await send("Přečti poslední odstavec.");
    expect(await screen.findByText("Poslední odstavec o API.")).toBeDefined();
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));

    fireEvent.pointerDown(screen.getByTestId("chained-push-to-talk"));

    expect(FakeAudio.instances[0]?.paused).toBe(true);
    expect(scribe.start).toHaveBeenCalledTimes(1);
  });

  it("includes a trailing partial and shows the incomplete-turn notice", async () => {
    scribe.partialTranscript = "poslední slova";
    scribe.stop.mockImplementationOnce(async () => {
      scribe.onIncompleteNotice?.(
        "Poslední promluva se nemusela dokončit. Zkontrolujte text před uložením.",
      );
    });
    renderMode();

    fireEvent.pointerDown(screen.getByTestId("chained-push-to-talk"));
    fireEvent.pointerUp(screen.getByTestId("chained-push-to-talk"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(
      String(
        (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body ?? "{}",
      ),
    ) as { transcript?: string };
    expect(body.transcript).toContain("poslední slova");
    expect(
      screen.getByText(/Poslední promluva se nemusela dokončit/),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Přepis příkazu") as HTMLTextAreaElement).value,
    ).toContain("poslední slova");
  });

  it("keeps the draft and names the failed provider", async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(
        {
          error: {
            code: "llm_not_configured",
            message: "OpenRouter není nakonfigurovaný.",
            provider: "openrouter",
          },
        },
        503,
      ),
    );
    renderMode();
    fireEvent.change(screen.getByLabelText("Přepis příkazu"), {
      target: { value: "Najdi migraci." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Odeslat příkaz" }));

    expect(
      (await screen.findByRole("alert")).textContent,
    ).toContain("openrouter: OpenRouter není nakonfigurovaný.");
    expect(
      (screen.getByLabelText("Přepis příkazu") as HTMLTextAreaElement).value,
    ).toBe("Najdi migraci.");
  });

  it("starts and stops the Scribe turn from push-to-talk", () => {
    renderMode();
    const button = screen.getByTestId("chained-push-to-talk");

    fireEvent.pointerDown(button);
    expect(scribe.start).toHaveBeenCalledTimes(1);

    fireEvent.pointerUp(button);
    expect(scribe.stop).toHaveBeenCalledTimes(1);
  });
});
