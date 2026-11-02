// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { previewGeminiVoice } from "@/lib/voice-agent/gemini-voice-preview";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit("close", {});
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const fetchMock = vi.fn();

beforeEach(() => {
  MockWebSocket.instances = [];
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/voice-agent/gemini-token") {
      return {
        json: async () => ({
          token: "token-123",
          sessionId: "session-123",
          voice: "Puck",
        }),
        ok: true,
      };
    }

    if (String(input) === "/api/voice-agent/tool") {
      return { json: async () => ({}), ok: true };
    }

    throw new Error(`Neočekávaný fetch: ${String(input)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("previewGeminiVoice", () => {
  it("opens a short Gemini session, sends the test sentence and returns PCM", async () => {
    const promise = previewGeminiVoice("Puck", "Testovací věta.");
    await vi.waitFor(() =>
      expect(MockWebSocket.instances).toHaveLength(1),
    );
    const socket = MockWebSocket.instances[0];

    if (!socket) {
      throw new Error("WebSocket nebyl vytvořen.");
    }

    socket.emit("open", {});
    expect(socket.sent[0]).toBe(JSON.stringify({ setup: {} }));

    socket.emit("message", {
      data: JSON.stringify({ setupComplete: true }),
    });
    expect(socket.sent[1]).toContain("Testovací věta.");

    const pcm = new Uint8Array([1, 0, 2, 0]);
    socket.emit("message", {
      data: JSON.stringify({
        serverContent: {
          modelTurn: {
            parts: [
              {
                inlineData: {
                  data: btoa(String.fromCharCode(...pcm)),
                },
              },
            ],
          },
          turnComplete: true,
        },
      }),
    });

    const audio = await promise;

    expect(audio.sampleRate).toBe(24_000);
    expect(Array.from(audio.pcm)).toEqual([1, 0, 2, 0]);
    expect(socket.closed).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice-agent/tool",
      expect.objectContaining({
        body: JSON.stringify({ action: "end", sessionId: "session-123" }),
      }),
    );
  });

  it("rejects an invalid token response", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ token: "", sessionId: "", voice: "Puck" }),
      ok: true,
    });

    await expect(previewGeminiVoice("Puck", "Test.")).rejects.toThrow(
      "Server vrátil neplatný token relace.",
    );
  });
});
