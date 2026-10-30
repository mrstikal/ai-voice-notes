// @vitest-environment jsdom

import { createElement } from "react";
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
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  GEMINI_LIVE_MODEL_ID,
  GEMINI_LIVE_SESSION_MAX_SECONDS,
} from "../../src/lib/voice-agent/gemini-session";
import {
  GEMINI_INPUT_SAMPLE_RATE,
  GEMINI_OUTPUT_SAMPLE_RATE,
  base64ToBytes,
  bytesToBase64,
  float32ToPcm16,
  pcm16ToFloat32,
  resamplePcm16,
} from "../../src/lib/voice-agent/pcm-audio";
import { MICROPHONE_LOCK_NAME } from "../../src/lib/voice/microphone";
import {
  GeminiConversation,
} from "../../src/components/voice-agent/GeminiConversation";
import {
  FakeAudioContext,
  FakeMediaStreamTrack,
  FakeWebSocket,
  installFakeGeminiBrowser,
  type FakeGeminiHarness,
} from "../helpers/gemini-double";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tokenResponse(voice = "Aoede"): Response {
  return jsonResponse(200, {
    token: "fake-token",
    sessionId: "fake-tool-session",
    model: GEMINI_LIVE_MODEL_ID,
    voice,
    maxSessionSeconds: GEMINI_LIVE_SESSION_MAX_SECONDS,
    expiresAt: new Date(Date.now() + GEMINI_LIVE_SESSION_MAX_SECONDS * 1000)
      .toISOString(),
  });
}

let browser: FakeGeminiHarness;
let fetchMock: ReturnType<typeof vi.fn>;
let tokenBodies: Array<{ voice: string }>;

async function connectGemini(
  voice?: string,
  buttonIndex = 0,
): Promise<{
  readonly socket: FakeWebSocket;
  readonly output: FakeAudioContext;
  readonly input: FakeAudioContext;
  readonly localTrack: FakeMediaStreamTrack;
}> {
  if (voice) {
    fireEvent.change(screen.getByLabelText("Hlas Gemini"), {
      target: { value: voice },
    });
  }

  fireEvent.click(
    screen.getAllByRole("button", { name: "Připojit" })[buttonIndex]!,
  );

  await waitFor(() => expect(browser.sockets).toHaveLength(1));
  const socket = browser.sockets[0] as FakeWebSocket;
  act(() => socket.open());
  expect(socket.sent[0]).toBe(JSON.stringify({ setup: {} }));

  await act(async () => {
    socket.message({ setupComplete: {} });
  });
  await waitFor(() => expect(screen.getByText("Připojeno")).toBeTruthy());

  const output = browser.audioContexts.find(
    (context) => context.sampleRate === GEMINI_OUTPUT_SAMPLE_RATE,
  );
  const input = browser.audioContexts.find(
    (context) => context.sampleRate === GEMINI_INPUT_SAMPLE_RATE,
  );

  if (!output || !input) {
    throw new Error("Chybí AudioContext.");
  }

  const localTrack =
    browser.media.mediaDevices.streams[0]?.getAudioTracks()[0];

  if (!localTrack) {
    throw new Error("Chybí mikrofonní stopa.");
  }

  return { socket, output, input, localTrack };
}

beforeEach(() => {
  browser = installFakeGeminiBrowser();
  tokenBodies = [];
  fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { voice: string };
    tokenBodies.push(body);
    return tokenResponse(body.voice);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  browser.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Gemini PCM helpers", () => {
  it("round-trips PCM16, resamples and base64 without losing frame size", () => {
    const input = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const pcm = float32ToPcm16(input);
    expect(pcm.byteLength).toBe(10);
    const decoded = pcm16ToFloat32(pcm);
    expect(decoded[1]).toBeCloseTo(0.5, 3);
    expect(decoded[2]).toBeCloseTo(-0.5, 3);
    expect(decoded[3]).toBeCloseTo(1, 3);

    const resampled = resamplePcm16(pcm, 48_000, 16_000);
    expect(resampled.byteLength).toBeLessThan(pcm.byteLength);
    expect(resampled.byteLength % 2).toBe(0);

    const encoded = bytesToBase64(pcm);
    expect(Array.from(base64ToBytes(encoded))).toEqual(Array.from(pcm));
  });
});

describe("GeminiConversation", () => {
  it("connects with the selected voice, streams 16 kHz PCM and plays 24 kHz output", async () => {
    render(createElement(GeminiConversation));
    const { socket, output, input } = await connectGemini("Kore");

    expect(tokenBodies).toEqual([{ voice: "Kore" }]);
    expect(socket.url).toContain("BidiGenerateContentConstrained");
    expect(socket.url).toContain("access_token=fake-token");
    expect(screen.getByTestId("voice-agent-connection-status").textContent).toContain(
      "Mikrofon: aktivní",
    );
    expect(screen.getByText(/Relace se automaticky ukončí/)).toBeTruthy();

    const processor = input.processors[0];

    if (!processor) {
      throw new Error("Chybí vstupní processor.");
    }

    act(() => processor.emit(new Float32Array(1600).fill(0.25)));

    const audioMessage = socket.sent
      .map((value) => JSON.parse(value) as Record<string, unknown>)
      .find((value) => "realtimeInput" in value) as
      | { realtimeInput: { audio: { mimeType: string; data: string } } }
      | undefined;

    expect(audioMessage?.realtimeInput.audio.mimeType).toBe(
      "audio/pcm;rate=16000",
    );
    expect(
      base64ToBytes(audioMessage?.realtimeInput.audio.data ?? "").byteLength,
    ).toBe(3200);

    const outputPcm = bytesToBase64(
      float32ToPcm16(new Float32Array(240).fill(0.1)),
    );
    await act(async () => {
      socket.message({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { data: outputPcm } }] },
          outputTranscription: { text: "Dobrý den." },
          turnComplete: true,
        },
      });
    });

    expect(output.bufferSources).toHaveLength(1);
    expect(output.bufferSources[0]?.startedAt).not.toBeNull();
    expect(screen.getByText(/Dobrý den\./)).toBeTruthy();
    expect(
      (screen.getByRole("combobox", { name: "Hlas Gemini" }) as HTMLSelectElement)
        .disabled,
    ).toBe(true);
  });

  it("shows two transient Czech turns without persisting them", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(createElement(GeminiConversation));
    const { socket } = await connectGemini();

    await act(async () => {
      socket.message({
        serverContent: {
          inputTranscription: { text: "Ahoj, jak se máš?" },
          outputTranscription: { text: "Mám se dobře." },
          turnComplete: true,
        },
      });
    });

    expect(screen.getByText(/Ahoj, jak se máš\?/)).toBeTruthy();
    expect(screen.getByText(/Mám se dobře\./)).toBeTruthy();

    await act(async () => {
      socket.message({
        serverContent: {
          inputTranscription: { text: "Řekni ještě jedno slovo." },
          outputTranscription: { text: "Slovo." },
          turnComplete: true,
        },
      });
    });

    expect(screen.getByText(/Řekni ještě jedno slovo\./)).toBeTruthy();
    expect(screen.getByText(/Slovo\./)).toBeTruthy();
    expect(setItem).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.every(([input]) =>
        String(input).endsWith("/api/voice-agent/gemini-token"),
      ),
    ).toBe(true);
  });

  it("stops mic, audio, socket and lock on Stop without reconnecting", async () => {
    render(createElement(GeminiConversation));
    const { socket, output, input, localTrack } = await connectGemini();

    fireEvent.click(screen.getByRole("button", { name: "Ukončit" }));

    expect(localTrack.readyState).toBe("ended");
    expect(socket.closeCalls).toHaveLength(1);
    expect(input.processors[0]?.onaudioprocess).not.toBeNull();
    expect(output.bufferSources.every((source) => source.stopped || source.startedAt === null)).toBe(true);
    await waitFor(() =>
      expect(browser.media.locks.isHeld(MICROPHONE_LOCK_NAME)).toBe(false),
    );
    await waitFor(() => expect(screen.getByText("Odpojeno")).toBeTruthy());
    expect(browser.sockets).toHaveLength(1);
  });

  it("prevents two tabs from capturing the mic at once", async () => {
    render(
      createElement(
        "div",
        null,
        createElement(GeminiConversation),
        createElement(GeminiConversation),
      ),
    );

    await connectGemini();

    fireEvent.click(screen.getAllByRole("button", { name: "Připojit" })[1]!);
    await waitFor(() => expect(screen.getAllByText("Chyba")).toHaveLength(1));
    expect(screen.getByText(/Mikrofon už používá jiná karta/)).toBeTruthy();
    expect(browser.sockets).toHaveLength(1);
    expect(tokenBodies).toHaveLength(1);
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it("shows a Czech error if the browser cannot create the output audio context", async () => {
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new Error("AudioContext unavailable");
        }
      },
    );

    render(createElement(GeminiConversation));
    fireEvent.click(screen.getByRole("button", { name: "Připojit" }));

    await waitFor(() => expect(screen.getByText("Chyba")).toBeTruthy());
    expect(
      screen.getByText(/Prohlížeč nepovolil zvukový výstup/),
    ).toBeTruthy();
    expect(browser.sockets).toHaveLength(0);
    expect(browser.media.mediaDevices.requests).toHaveLength(0);
  });

  it("cleans up if the microphone graph fails after setupComplete", async () => {
    class BrokenInputContext extends FakeAudioContext {
      createMediaStreamSource(): {
        connect: () => void;
        disconnect: () => void;
      } {
        if (this.sampleRate === GEMINI_INPUT_SAMPLE_RATE) {
          throw new Error("input graph failed");
        }

        return super.createMediaStreamSource();
      }
    }

    vi.stubGlobal("AudioContext", BrokenInputContext);

    render(createElement(GeminiConversation));
    fireEvent.click(screen.getByRole("button", { name: "Připojit" }));

    await waitFor(() => expect(browser.sockets).toHaveLength(1));
    const socket = browser.sockets[0] as FakeWebSocket;
    act(() => socket.open());

    await act(async () => {
      socket.message({ setupComplete: {} });
    });

    await waitFor(() => expect(screen.getByText("Chyba")).toBeTruthy());
    expect(
      screen.getByText(/Mikrofon nebo zvukový výstup/),
    ).toBeTruthy();
    expect(socket.closeCalls).toHaveLength(1);
    await waitFor(() =>
      expect(browser.media.locks.isHeld(MICROPHONE_LOCK_NAME)).toBe(false),
    );
  });

  it("shows a precise token error without opening a socket", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(503, {
        error: {
          code: "gemini_not_configured",
          message: "Konverzační asistent není nakonfigurovaný.",
        },
      }),
    );

    render(createElement(GeminiConversation));
    fireEvent.click(screen.getByRole("button", { name: "Připojit" }));

    await waitFor(() => expect(screen.getByText("Chyba")).toBeTruthy());
    expect(
      screen.getByText("Konverzační asistent není nakonfigurovaný."),
    ).toBeTruthy();
    expect(browser.sockets).toHaveLength(0);
    await waitFor(() =>
      expect(browser.media.locks.isHeld(MICROPHONE_LOCK_NAME)).toBe(false),
    );
  });

  it("round-trips search and selected read tool calls without persisting notes", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const toolBodies: Array<Record<string, unknown>> = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;

      if (url.endsWith("/api/voice-agent/gemini-token")) {
        tokenBodies.push(body as { voice: string });
        return tokenResponse(body.voice as string);
      }

      if (url.endsWith("/api/voice-agent/tool")) {
        toolBodies.push(body);

        if (body.action === "select") {
          return jsonResponse(200, {
            ok: true,
            selected: { noteId: "note-b", title: "Druhá", version: 2 },
          });
        }

        if (body.name === "search_notes") {
          return jsonResponse(200, {
            ok: true,
            response: {
              empty: false,
              query: "ahoj",
              results: [
                {
                  noteId: "note-a",
                  preview: "Ahoj z první poznámky.",
                  title: "První",
                },
                {
                  noteId: "note-b",
                  preview: "Ahoj z druhé poznámky.",
                  title: "Druhá",
                },
              ],
              total: 2,
            },
          });
        }

        if (body.name === "get_note") {
          return jsonResponse(200, {
            ok: true,
            response: {
              content: "Druhý text.",
              empty: false,
              noteId: "note-b",
              title: "Druhá",
              truncated: false,
              version: 2,
            },
          });
        }
      }

      return jsonResponse(404, {
        error: { code: "not_found", message: "Nenalezeno." },
      });
    });

    render(createElement(GeminiConversation));
    const { socket } = await connectGemini();

    await act(async () => {
      socket.message({
        toolCall: {
          functionCalls: [
            { args: { query: "ahoj" }, id: "call-1", name: "search_notes" },
          ],
        },
      });
    });

    expect(await screen.findByText("První")).toBeTruthy();
    expect(screen.getByText("Druhá")).toBeTruthy();
    expect(screen.getByText("Ahoj z první poznámky.")).toBeTruthy();
    expect(screen.getByText("Ahoj z druhé poznámky.")).toBeTruthy();
    expect(toolBodies[0]).toMatchObject({
      action: "call",
      callId: "call-1",
      name: "search_notes",
      sessionId: "fake-tool-session",
      turnId: expect.any(String),
    });

    const searchResponse = socket.sent
      .map((value) => JSON.parse(value) as Record<string, unknown>)
      .find((value) => "toolResponse" in value) as
      | {
          toolResponse: {
            functionResponses: Array<{
              id: string;
              name: string;
              response: unknown;
            }>;
          };
        }
      | undefined;

    expect(searchResponse?.toolResponse.functionResponses[0]).toMatchObject({
      id: "call-1",
      name: "search_notes",
      response: {
        results: [{ noteId: "note-a" }, { noteId: "note-b" }],
      },
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Vybrat" })[1]!);

    await waitFor(() =>
      expect(
        toolBodies.some((body) => body.action === "select"),
      ).toBe(true),
    );
    expect(
      await screen.findByText(/Vybraná poznámka: Druhá\. Nyní/),
    ).toBeTruthy();
    const selectionMessage = socket.sent
      .map((value) => JSON.parse(value) as Record<string, unknown>)
      .find((value) => "clientContent" in value) as
      | {
          clientContent: {
            turns: Array<{ parts: Array<{ text: string }> }>;
          };
        }
      | undefined;
    expect(selectionMessage?.clientContent.turns[0]?.parts[0]?.text).toContain(
      "note-b",
    );
    expect(selectionMessage?.clientContent.turns[0]?.parts[0]?.text).not.toContain(
      "Druhý text.",
    );
    expect(
      (selectionMessage as { clientContent?: { turnComplete?: boolean } })
        .clientContent?.turnComplete,
    ).toBe(false);

    await act(async () => {
      socket.message({
        toolCall: {
          functionCalls: [
            { args: { noteId: "note-b" }, id: "call-2", name: "get_note" },
          ],
        },
      });
    });

    await waitFor(() =>
      expect(
        toolBodies.some(
          (body) => body.name === "get_note" && body.callId === "call-2",
        ),
      ).toBe(true),
    );

    const readResponse = socket.sent
      .map((value) => JSON.parse(value) as Record<string, unknown>)
      .filter((value) => "toolResponse" in value)
      .at(-1) as
      | {
          toolResponse: {
            functionResponses: Array<{
              id: string;
              name: string;
              response: unknown;
            }>;
          };
        }
      | undefined;

    expect(readResponse?.toolResponse.functionResponses[0]).toMatchObject({
      id: "call-2",
      name: "get_note",
      response: { content: "Druhý text.", noteId: "note-b" },
    });
    expect(setItem).not.toHaveBeenCalled();
  });

  it("marks a passage, keeps the paid summary blocked and approves it only on click", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const toolBodies: Array<Record<string, unknown>> = [];
    let markCalls = 0;
    let approveCalls = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;

      if (url.endsWith("/api/voice-agent/gemini-token")) {
        tokenBodies.push(body as { voice: string });
        return tokenResponse(body.voice as string);
      }

      if (url.endsWith("/api/voice-agent/tool")) {
        toolBodies.push(body);

        if (body.action === "select") {
          return jsonResponse(200, {
            ok: true,
            selected: {
              noteId: "note-b",
              preview: "Druhý text pro shrnutí.",
              previewTruncated: false,
              title: "Druhá",
              version: 2,
            },
          });
        }

        if (body.action === "mark") {
          markCalls += 1;

          if (markCalls === 2) {
            return jsonResponse(409, {
              error: {
                code: "note_stale",
                message: "Vybraná poznámka se mezitím změnila.",
              },
            });
          }

          return jsonResponse(200, {
            marked: body.selection !== null,
            ok: true,
            selected: {
              noteId: "note-b",
              preview: "Druhý text pro shrnutí.",
              previewTruncated: false,
              selection: body.selection,
              title: "Druhá",
              version: 2,
            },
          });
        }

        if (body.action === "approve_summary") {
          approveCalls += 1;

          if (approveCalls === 2) {
            return jsonResponse(409, {
              error: {
                code: "note_stale",
                message: "Vybraná poznámka se mezitím změnila.",
              },
            });
          }

          return jsonResponse(200, {
            ok: true,
            summary: {
              noteId: "note-b",
              noteTitle: "Druhá",
              noteVersion: 2,
              sourceGraphemes: 6,
              status: "generated",
              summaryText: "Shrnutí druhé poznámky.",
            },
          });
        }

        if (body.name === "search_notes") {
          return jsonResponse(200, {
            ok: true,
            response: {
              empty: false,
              query: "ahoj",
              results: [
                {
                  noteId: "note-a",
                  preview: "Ahoj z první poznámky.",
                  title: "První",
                },
                {
                  noteId: "note-b",
                  preview: "Ahoj z druhé poznámky.",
                  title: "Druhá",
                },
              ],
              total: 2,
            },
          });
        }

        if (body.name === "get_note") {
          return jsonResponse(200, {
            ok: false,
            response: {
              error: {
                code: "note_stale",
                message: "Vybraná poznámka se mezitím změnila.",
              },
            },
          });
        }

        if (body.name === "summarize_note") {
          return jsonResponse(200, {
            ok: true,
            response: {
              blockedReason: null,
              configured: true,
              estimatedMaxCostUsd: 0.004,
              message: "Shrnutí čeká na povolení.",
              model: "deepseek/test",
              noteId: "note-b",
              noteTitle: "Druhá",
              noteVersion: 2,
              selection: { end: 6, start: 0 },
              sourceGraphemes: 6,
              status: "needs_user_cost_confirmation",
            },
          });
        }

        if (body.name === "read_note_section") {
          return jsonResponse(200, {
            ok: true,
            response: {
              message: null,
              noteId: "note-b",
              section: "tasks",
              status: "ok",
              text: "Ověřit databázi",
              title: "Druhá",
              truncated: false,
              version: 2,
            },
          });
        }
      }

      return jsonResponse(404, {
        error: { code: "not_found", message: "Nenalezeno." },
      });
    });

    render(createElement(GeminiConversation));
    const { socket } = await connectGemini();

    await act(async () => {
      socket.message({
        toolCall: {
          functionCalls: [
            { args: { query: "ahoj" }, id: "call-search", name: "search_notes" },
          ],
        },
      });
    });
    expect(await screen.findByText("První")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Vybrat" })[1]!);
    const preview = (await screen.findByTestId(
      "voice-agent-selected-preview",
    )) as HTMLTextAreaElement;
    expect(preview.value).toBe("Druhý text pro shrnutí.");

    preview.setSelectionRange(0, 6);
    fireEvent.click(screen.getByTestId("voice-agent-mark-selection"));

    await waitFor(() =>
      expect(
        toolBodies.some(
          (body) =>
            body.action === "mark" &&
            (body.selection as { start: number; end: number }).start === 0 &&
            (body.selection as { start: number; end: number }).end === 6,
        ),
      ).toBe(true),
    );
    expect(
      await screen.findByText(/Označená pasáž \(6 znaků\)/),
    ).toBeTruthy();

    await act(async () => {
      socket.message({
        toolCall: {
          functionCalls: [
            {
              args: { noteId: "note-b" },
              id: "call-summary",
              name: "summarize_note",
            },
          ],
        },
      });
    });

    const consent = await screen.findByTestId("voice-agent-summary-consent");
    expect(consent.textContent).toContain("Druhá");
    expect(consent.textContent).toContain("deepseek/test");
    expect(consent.textContent).toContain("0,00");
    expect(screen.queryByTestId("voice-agent-summary")).toBeNull();
    expect(
      toolBodies.some((body) => body.action === "approve_summary"),
    ).toBe(false);

    fireEvent.click(screen.getByTestId("voice-agent-approve-summary"));

    expect(await screen.findByTestId("voice-agent-summary")).toBeTruthy();
    expect(screen.getByText("Shrnutí druhé poznámky.")).toBeTruthy();
    expect(
      toolBodies.some((body) => body.action === "approve_summary"),
    ).toBe(true);

    const summaryTurn = socket.sent
      .map((value) => JSON.parse(value) as Record<string, unknown>)
      .find(
        (value) =>
          "clientContent" in value &&
          JSON.stringify(value).includes("Shrnutí druhé poznámky."),
      ) as { clientContent?: { turnComplete?: boolean } } | undefined;
    expect(summaryTurn?.clientContent?.turnComplete).toBe(false);

    await act(async () => {
      socket.message({
        toolCall: {
          functionCalls: [
            {
              args: { noteId: "note-b", section: "tasks" },
              id: "call-section",
              name: "read_note_section",
            },
          ],
        },
      });
    });
    expect(await screen.findByText(/Přečtená část \(úkoly\)/)).toBeTruthy();

    await act(async () => {
      socket.message({
        toolCall: {
          functionCalls: [
            { args: { noteId: "note-b" }, id: "call-stale", name: "get_note" },
          ],
        },
      });
    });

    expect(
      await screen.findByText("Vybraná poznámka se mezitím změnila."),
    ).toBeTruthy();
    expect(screen.queryByTestId("voice-agent-selected-note")).toBeNull();
    const secondItem = screen.getByText("Druhá").closest("li");
    expect(secondItem).not.toBeNull();
    expect(
      within(secondItem as HTMLElement).getByRole("button", { name: "Vybrat" }),
    ).toBeTruthy();

    fireEvent.click(
      within(secondItem as HTMLElement).getByRole("button", { name: "Vybrat" }),
    );
    const previewAgain = (await screen.findByTestId(
      "voice-agent-selected-preview",
    )) as HTMLTextAreaElement;
    previewAgain.setSelectionRange(0, 6);
    fireEvent.click(screen.getByTestId("voice-agent-mark-selection"));

    await waitFor(() =>
      expect(
        toolBodies.filter((body) => body.action === "mark"),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("voice-agent-selected-note")).toBeNull(),
    );
    expect(
      await screen.findByText("Vybraná poznámka se mezitím změnila."),
    ).toBeTruthy();

    const secondItemAfterMark = screen.getByText("Druhá").closest("li");
    expect(secondItemAfterMark).not.toBeNull();
    fireEvent.click(
      within(secondItemAfterMark as HTMLElement).getByRole("button", {
        name: "Vybrat",
      }),
    );
    const previewThird = (await screen.findByTestId(
      "voice-agent-selected-preview",
    )) as HTMLTextAreaElement;
    previewThird.setSelectionRange(0, 6);
    fireEvent.click(screen.getByTestId("voice-agent-mark-selection"));

    await waitFor(() =>
      expect(
        toolBodies.filter((body) => body.action === "mark"),
      ).toHaveLength(3),
    );

    await act(async () => {
      socket.message({
        toolCall: {
          functionCalls: [
            {
              args: { noteId: "note-b" },
              id: "call-summary-2",
              name: "summarize_note",
            },
          ],
        },
      });
    });
    await screen.findByTestId("voice-agent-summary-consent");
    fireEvent.click(screen.getByTestId("voice-agent-approve-summary"));

    await waitFor(() =>
      expect(
        toolBodies.filter((body) => body.action === "approve_summary"),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("voice-agent-selected-note")).toBeNull(),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Vybraná poznámka se mezitím změnila.",
    );
    expect(screen.queryByTestId("voice-agent-summary-consent")).toBeNull();
    expect(screen.queryByTestId("voice-agent-summary")).toBeNull();

    const secondItemAfterApprove = screen.getByText("Druhá").closest("li");
    expect(secondItemAfterApprove).not.toBeNull();
    expect(
      within(secondItemAfterApprove as HTMLElement).getByRole("button", {
        name: "Vybrat",
      }),
    ).toBeTruthy();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("shows an agent proposal as a preview, rejects it and never confirms from the model", async () => {
    const NONCE = "n".repeat(43);
    const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";
    const NOTE_ID = "22222222-2222-4222-8222-222222222222";
    const toolBodies: Array<Record<string, unknown>> = [];

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;

      if (url.endsWith("/api/voice-agent/gemini-token")) {
        tokenBodies.push(body as { voice: string });
        return tokenResponse(body.voice as string);
      }

      if (url.includes("/api/voice-agent/pending/")) {
        if (body.action === "reject") {
          return jsonResponse(200, {
            expiresAt: "2026-10-30T12:05:00.000Z",
            ok: true,
            proposalId: PROPOSAL_ID,
            status: "rejected",
          });
        }

        return jsonResponse(200, {
          ok: true,
          proposal: {
            afterMd: "Ahoj světe.\n\n- [ ] Koupit mléko",
            beforeMd: "Ahoj světe.",
            confirmationNonce: NONCE,
            diff: {
              end: 11,
              inserted: "\n\n- [ ] Koupit mléko",
              prefix: "Ahoj světe.",
              removed: "",
              start: 11,
              suffix: "",
            },
            expectedVersion: 1,
            expiresAt: "2026-10-30T12:05:00.000Z",
            noteId: NOTE_ID,
            noteTitle: "Nákupní poznámka",
            operation: {
              text: "- [ ] Koupit mléko",
              type: "append_bounded_section",
            },
            proposalId: PROPOSAL_ID,
            selectedCandidate: null,
            status: "pending",
          },
        });
      }

      if (url.endsWith("/api/voice-agent/tool")) {
        toolBodies.push(body);

        if (body.action === "select") {
          return jsonResponse(200, {
            ok: true,
            selected: {
              noteId: NOTE_ID,
              preview: "Ahoj světe.",
              previewTruncated: false,
              title: "Nákupní poznámka",
              version: 1,
            },
          });
        }

        if (body.name === "search_notes") {
          return jsonResponse(200, {
            ok: true,
            response: {
              empty: false,
              query: "nákup",
              results: [
                {
                  noteId: NOTE_ID,
                  preview: "Ahoj světe.",
                  title: "Nákupní poznámka",
                },
              ],
              total: 1,
            },
          });
        }

        if (body.name === "add_todo") {
          return jsonResponse(200, {
            ok: true,
            response: {
              expectedVersion: 1,
              expiresAt: "2026-10-30T12:05:00.000Z",
              message: "Návrh je jen náhled.",
              noteId: NOTE_ID,
              noteTitle: "Nákupní poznámka",
              operationType: "append_bounded_section",
              proposalId: PROPOSAL_ID,
              requiresUserClick: true,
              status: "pending",
              target: "Konec poznámky",
            },
          });
        }

        if (body.name === "confirm_edit") {
          return jsonResponse(200, {
            ok: true,
            response: {
              expiresAt: "2026-10-30T12:05:00.000Z",
              message: "Uživatel musí kliknout.",
              noteId: NOTE_ID,
              noteTitle: "Nákupní poznámka",
              proposalId: PROPOSAL_ID,
              requiresUserClick: true,
              status: "requires_user_click",
            },
          });
        }
      }

      return jsonResponse(404, {
        error: { code: "not_found", message: "Nenalezeno." },
      });
    });

    render(createElement(GeminiConversation));
    const { socket } = await connectGemini();

    await act(async () => {
      socket.message({
        toolCall: {
          functionCalls: [
            { args: { query: "nákup" }, id: "call-search", name: "search_notes" },
          ],
        },
      });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Vybrat" }));

    await act(async () => {
      socket.message({
        toolCall: {
          functionCalls: [
            {
              args: { noteId: NOTE_ID, text: "Koupit mléko" },
              id: "call-todo",
              name: "add_todo",
            },
          ],
        },
      });
    });

    const panel = await screen.findByTestId("voice-agent-pending-edit");
    expect(panel.textContent).toContain("Nákupní poznámka");
    expect(panel.textContent).toContain("Konec poznámky");
    expect(screen.getByTestId("voice-agent-pending-diff").textContent).toContain(
      "- [ ] Koupit mléko",
    );
    expect(document.body.textContent).not.toContain(NONCE);
    expect(screen.getByRole("button", { name: "Potvrdit" })).toHaveProperty(
      "disabled",
      true,
    );

    fireEvent.click(screen.getByTestId("voice-agent-pending-reject"));
    await waitFor(() =>
      expect(screen.getByText("Zamítnuto")).toBeDefined(),
    );
    expect(
      toolBodies.some((value) => value.name === "add_todo"),
    ).toBe(true);

    await act(async () => {
      socket.message({
        toolCall: {
          functionCalls: [
            {
              args: { proposalId: PROPOSAL_ID },
              id: "call-confirm",
              name: "confirm_edit",
            },
          ],
        },
      });
    });
    expect(
      await screen.findByText(/Změnu nejde potvrdit hlasem/),
    ).toBeDefined();
  });

  it("stops the mic and socket on unmount", async () => {
    const view = render(createElement(GeminiConversation));
    const { socket, localTrack } = await connectGemini();

    view.unmount();

    expect(localTrack.readyState).toBe("ended");
    expect(socket.closeCalls).toHaveLength(1);
    await waitFor(() =>
      expect(browser.media.locks.isHeld(MICROPHONE_LOCK_NAME)).toBe(false),
    );
  });

  it("ends the session automatically at the token expiry", async () => {
    fetchMock.mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { voice: string };
      tokenBodies.push(body);
      return jsonResponse(200, {
        token: "fake-token",
        sessionId: "fake-tool-session",
        model: GEMINI_LIVE_MODEL_ID,
        voice: body.voice,
        maxSessionSeconds: GEMINI_LIVE_SESSION_MAX_SECONDS,
        expiresAt: new Date(Date.now() + 40).toISOString(),
      });
    });

    render(createElement(GeminiConversation));
    const { socket } = await connectGemini();

    await waitFor(() => expect(screen.getByText("Odpojeno")).toBeTruthy(), {
      timeout: 1000,
    });
    expect(socket.closeCalls).toHaveLength(1);
  });
});
