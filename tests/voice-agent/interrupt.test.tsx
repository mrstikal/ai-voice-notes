// @vitest-environment jsdom

import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { GeminiConversation } from "../../src/components/voice-agent/GeminiConversation";
import {
  GEMINI_INPUT_SAMPLE_RATE,
  GEMINI_OUTPUT_SAMPLE_RATE,
  base64ToBytes,
  bytesToBase64,
  float32ToPcm16,
} from "../../src/lib/voice-agent/pcm-audio";
import {
  GEMINI_LIVE_MODEL_ID,
  GEMINI_LIVE_SESSION_MAX_SECONDS,
} from "../../src/lib/voice-agent/gemini-session";
import { MICROPHONE_LOCK_NAME } from "../../src/lib/voice/microphone";
import {
  FakeWebSocket,
  installFakeGeminiBrowser,
  type FakeAudioContext,
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

function tokenResponse(
  options: {
    readonly maxSessionSeconds?: number;
    readonly expiresInMs?: number;
    readonly voice?: string;
  } = {},
): Response {
  const maxSessionSeconds =
    options.maxSessionSeconds ?? GEMINI_LIVE_SESSION_MAX_SECONDS;
  const expiresInMs =
    options.expiresInMs ?? GEMINI_LIVE_SESSION_MAX_SECONDS * 1000;

  return jsonResponse(200, {
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    maxSessionSeconds,
    model: GEMINI_LIVE_MODEL_ID,
    sessionId: "fake-tool-session",
    token: "fake-token",
    voice: options.voice ?? "Aoede",
  });
}

let browser: FakeGeminiHarness;
let fetchMock: ReturnType<typeof vi.fn>;
let tokenCalls: number;
let tokenVoices: string[];

async function connect(): Promise<{
  readonly socket: FakeWebSocket;
  readonly input: FakeAudioContext;
  readonly output: FakeAudioContext;
}> {
  render(createElement(GeminiConversation));
  fireEvent.click(screen.getByTestId("voice-agent-connect"));

  await waitFor(() => expect(browser.sockets).toHaveLength(1));
  const socket = browser.sockets[0] as FakeWebSocket;
  act(() => socket.open());
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

  return { input, output, socket };
}

function lastAudioBytes(socket: FakeWebSocket): Uint8Array {
  const message = socket.sent
    .map((value) => JSON.parse(value) as Record<string, unknown>)
    .filter((value) => "realtimeInput" in value)
    .at(-1) as
    | { realtimeInput?: { audio?: { data?: unknown } } }
    | undefined;
  const data = message?.realtimeInput?.audio?.data;

  if (typeof data !== "string") {
    throw new Error("Chybí audio frame.");
  }

  return base64ToBytes(data);
}

function emit(samples: Float32Array): void {
  act(() => {
    const input = browser.audioContexts.find(
      (context) => context.sampleRate === GEMINI_INPUT_SAMPLE_RATE,
    );
    input?.processors[0]?.emit(samples);
  });
}

function playFakeOutput(socket: FakeWebSocket): void {
  const pcm = float32ToPcm16(new Float32Array(2400).fill(0.2));
  act(() => {
    socket.message({
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: {
                data: bytesToBase64(pcm),
                mimeType: "audio/pcm;rate=24000",
              },
            },
          ],
        },
      },
    });
  });
}

beforeEach(() => {
  browser = installFakeGeminiBrowser();
  tokenCalls = 0;
  tokenVoices = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/voice-agent/gemini-token")) {
      tokenCalls += 1;
      tokenVoices.push(
        (JSON.parse(String(init?.body ?? "{}")) as { voice?: string }).voice ??
          "",
      );

      if (tokenCalls === 1 && options.firstTokenFails) {
        return jsonResponse(503, {
          error: { code: "gemini_unavailable", message: "První pokus selhal." },
        });
      }

      const voice =
        (JSON.parse(String(init?.body ?? "{}")) as { voice?: string }).voice ??
        "Aoede";

      return tokenResponse({ ...options.token, voice });
    }

    return jsonResponse(404, {
      error: { code: "not_found", message: "Nenalezeno." },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

let options: {
  readonly firstTokenFails?: boolean;
  readonly token?: { maxSessionSeconds?: number; expiresInMs?: number };
} = {};

afterEach(() => {
  cleanup();
  browser.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  options = {};
});

describe("P51 bounded Gemini session controls", () => {
  it("clears locally scheduled speech immediately on loud microphone input", async () => {
    const { input, output, socket } = await connect();
    playFakeOutput(socket);
    const first = output.bufferSources[0];
    expect(first).toBeDefined();
    expect(first?.stopped).toBe(false);

    emit(new Float32Array(4096).fill(0.5));

    expect(first?.stopped).toBe(true);
    expect(lastAudioBytes(socket).some((byte) => byte !== 0)).toBe(true);

    playFakeOutput(socket);
    expect(output.bufferSources).toHaveLength(2);
    expect(output.bufferSources[1]?.stopped).toBe(false);
    expect(input.processors).toHaveLength(1);
  });

  it("mutes the microphone by sending silence and restores it on click", async () => {
    const { socket } = await connect();
    emit(new Float32Array(4096).fill(0.4));
    expect(lastAudioBytes(socket).some((byte) => byte !== 0)).toBe(true);

    fireEvent.click(screen.getByTestId("voice-agent-mute"));
    emit(new Float32Array(4096).fill(0.4));
    expect(lastAudioBytes(socket).every((byte) => byte === 0)).toBe(true);
    expect(screen.getByTestId("voice-agent-input-state").textContent).toContain(
      "ztlumený",
    );

    fireEvent.click(screen.getByTestId("voice-agent-mute"));
    emit(new Float32Array(4096).fill(0.4));
    expect(lastAudioBytes(socket).some((byte) => byte !== 0)).toBe(true);
  });

  it("keeps a mute chosen while the session is still connecting", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/voice-agent/gemini-token")) {
        await gate;

        return tokenResponse();
      }

      return jsonResponse(404, {
        error: { code: "not_found", message: "Nenalezeno." },
      });
    });

    render(createElement(GeminiConversation));
    fireEvent.click(screen.getByTestId("voice-agent-connect"));
    await waitFor(() =>
      expect(screen.getByText("Připojuji")).toBeTruthy(),
    );
    expect(screen.getByTestId("voice-agent-mute")).toHaveProperty(
      "disabled",
      false,
    );
    fireEvent.click(screen.getByTestId("voice-agent-mute"));
    expect(screen.getByTestId("voice-agent-mute").textContent).toBe(
      "Zapnout mikrofon",
    );

    release!();
    await waitFor(() => expect(browser.sockets).toHaveLength(1));
    const socket = browser.sockets[0] as FakeWebSocket;
    act(() => socket.open());
    await act(async () => {
      socket.message({ setupComplete: {} });
    });
    await waitFor(() => expect(screen.getByText("Připojeno")).toBeTruthy());

    emit(new Float32Array(4096).fill(0.4));
    expect(lastAudioBytes(socket).every((byte) => byte === 0)).toBe(true);
    expect(screen.getByTestId("voice-agent-input-state").textContent).toContain(
      "ztlumený",
    );
  });

  it("opens push-to-talk only while the button is held", async () => {
    const { socket } = await connect();
    fireEvent.change(screen.getByTestId("voice-agent-input-mode"), {
      target: { value: "push" },
    });
    const button = screen.getByTestId("voice-agent-push-to-talk");
    expect(button.textContent).toBe("Držet a mluvit");

    emit(new Float32Array(4096).fill(0.4));
    expect(lastAudioBytes(socket).every((byte) => byte === 0)).toBe(true);

    fireEvent.pointerDown(button);
    emit(new Float32Array(4096).fill(0.4));
    expect(lastAudioBytes(socket).some((byte) => byte !== 0)).toBe(true);

    fireEvent.pointerUp(button);
    emit(new Float32Array(4096).fill(0.4));
    expect(lastAudioBytes(socket).every((byte) => byte === 0)).toBe(true);
  });

  it("disables double start and double stop and keeps the voice fixed while connected", async () => {
    const { socket } = await connect();

    expect(
      screen.getByLabelText("Hlas Gemini"),
    ).toHaveProperty("disabled", true);
    expect(screen.getByTestId("voice-agent-connect")).toHaveProperty(
      "disabled",
      true,
    );

    fireEvent.click(screen.getByTestId("voice-agent-connect"));
    expect(browser.sockets).toHaveLength(1);
    expect(tokenCalls).toBe(1);

    playFakeOutput(socket);
    const output = browser.audioContexts.find(
      (context) => context.sampleRate === GEMINI_OUTPUT_SAMPLE_RATE,
    );
    fireEvent.click(screen.getByTestId("voice-agent-stop"));
    fireEvent.click(screen.getByTestId("voice-agent-stop"));
    expect(socket.closeCalls).toHaveLength(1);
    expect(output?.bufferSources.every((source) => source.stopped)).toBe(true);
    await waitFor(() =>
      expect(browser.media.locks.isHeld(MICROPHONE_LOCK_NAME)).toBe(false),
    );
  });

  it("ends a timeout, silences audio and releases the lock", async () => {
    options = { token: { expiresInMs: 50, maxSessionSeconds: 0.05 } };
    const { socket, output } = await connect();
    playFakeOutput(socket);

    await waitFor(() =>
      expect(screen.getByTestId("voice-agent-connection-status").textContent).toContain(
        "Odpojeno",
      ),
    );
    expect(screen.getByText(/Časový limit relace vypršel/)).toBeTruthy();
    expect(
      output.bufferSources.every((source) => source.stopped),
    ).toBe(true);
    await waitFor(() =>
      expect(browser.media.locks.isHeld(MICROPHONE_LOCK_NAME)).toBe(false),
    );
    expect(screen.queryByTestId("voice-agent-retry")).toBeNull();
  });

  it("hides and shows captions without stopping the audio session", async () => {
    const { socket } = await connect();
    act(() => {
      socket.message({
        serverContent: { outputTranscription: { text: "Ahoj z Gemini." } },
      });
    });
    expect(screen.getByText(/Ahoj z Gemini\./)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Zobrazit titulky"));
    expect(screen.queryByText(/Ahoj z Gemini\./)).toBeNull();

    fireEvent.click(screen.getByLabelText("Zobrazit titulky"));
    expect(screen.getByText(/Ahoj z Gemini\./)).toBeTruthy();
    expect(screen.getByText("Připojeno")).toBeTruthy();
  });

  it("restarts with a new voice only in a new session", async () => {
    const { socket } = await connect();
    expect(tokenVoices).toEqual(["Aoede"]);
    expect(screen.getByLabelText("Hlas Gemini")).toHaveProperty(
      "disabled",
      true,
    );

    fireEvent.click(screen.getByTestId("voice-agent-stop"));
    expect(socket.closeCalls).toHaveLength(1);
    await waitFor(() =>
      expect(browser.media.locks.isHeld(MICROPHONE_LOCK_NAME)).toBe(false),
    );
    expect(screen.getByLabelText("Hlas Gemini")).toHaveProperty(
      "disabled",
      false,
    );

    fireEvent.change(screen.getByLabelText("Hlas Gemini"), {
      target: { value: "Kore" },
    });
    fireEvent.click(screen.getByTestId("voice-agent-connect"));
    await waitFor(() => expect(browser.sockets).toHaveLength(2));
    const second = browser.sockets[1] as FakeWebSocket;
    act(() => second.open());
    await act(async () => {
      second.message({ setupComplete: {} });
    });

    expect(tokenVoices).toEqual(["Aoede", "Kore"]);
    expect(screen.getByText("Připojeno")).toBeTruthy();
  });

  it("offers a manual retry after a token error", async () => {
    options = { firstTokenFails: true };
    render(createElement(GeminiConversation));
    fireEvent.click(screen.getByTestId("voice-agent-connect"));

    await waitFor(() => expect(screen.getByText("Chyba")).toBeTruthy());
    expect(screen.getByTestId("voice-agent-retry")).toBeTruthy();

    fireEvent.click(screen.getByTestId("voice-agent-retry"));
    await waitFor(() => expect(browser.sockets).toHaveLength(1));
    expect(tokenCalls).toBe(2);
  });
});
