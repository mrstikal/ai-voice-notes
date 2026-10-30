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
