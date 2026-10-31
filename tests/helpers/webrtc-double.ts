import type { WebSocketRoute } from "@playwright/test";

/**
 * P54 keeps the implementation plan's historical `webrtc-double.ts` filename.
 * The retired OpenAI WebRTC transport was replaced by Gemini Live over a
 * WebSocket, so this browser-transport double speaks the Gemini Live JSON
 * protocol instead. It is used only by `e2e/voice-agent-mock.spec.ts`; it never
 * imports application code, opens a network connection or stores audio.
 */

export const GEMINI_LIVE_WEBSOCKET_PATTERN =
  /generativelanguage\.googleapis\.com\/ws\/google\.ai\.generativelanguage\.v1beta\./u;

export interface GeminiFunctionCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

export function readClientEvent(
  message: string | Buffer,
): Record<string, unknown> | null {
  const text =
    typeof message === "string" ? message : message.toString("utf8");

  try {
    const parsed: unknown = JSON.parse(text);

    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export class GeminiLiveSocketDouble {
  readonly clientMessages: string[] = [];
  closed = false;

  private socket: WebSocketRoute | null = null;
  private setupReceived = false;
  private readonly attachedPromise: Promise<void>;
  private resolveAttached: () => void = () => undefined;

  constructor() {
    this.attachedPromise = new Promise<void>((resolve) => {
      this.resolveAttached = resolve;
    });
  }

  attach(socket: WebSocketRoute): void {
    this.socket = socket;
    this.closed = false;
    this.setupReceived = false;
    this.resolveAttached();

    socket.onMessage((message) => {
      this.clientMessages.push(
        typeof message === "string" ? message : message.toString("utf8"),
      );

      const event = readClientEvent(message);

      if (event && event.setup !== undefined && !this.setupReceived) {
        this.setupReceived = true;
        socket.send(JSON.stringify({ setupComplete: {} }));
      }
    });

    socket.onClose(() => {
      this.closed = true;
    });
  }

  async waitForSetup(timeoutMs = 15_000): Promise<void> {
    await this.attachedPromise;
    await pollUntil(() => this.setupReceived, timeoutMs, "Gemini setup");
  }

  async waitForClose(timeoutMs = 15_000): Promise<void> {
    await pollUntil(() => this.closed, timeoutMs, "Gemini close");
  }

  sendToolCall(calls: readonly GeminiFunctionCall[]): void {
    this.send({ toolCall: { functionCalls: calls } });
  }

  sendTurnComplete(): void {
    this.send({ serverContent: { turnComplete: true } });
  }

  sendInputTranscription(text: string): void {
    this.send({ serverContent: { inputTranscription: { text } } });
  }

  sendAudioChunk(base64Pcm: string): void {
    this.send({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { data: base64Pcm, mimeType: "audio/pcm" } }],
        },
      },
    });
  }

  parsedClientEvents(): Record<string, unknown>[] {
    return this.clientMessages
      .map((message) => readClientEvent(message))
      .filter((event): event is Record<string, unknown> => event !== null);
  }

  clientContentTexts(): string[] {
    const texts: string[] = [];

    for (const event of this.parsedClientEvents()) {
      const clientContent = event.clientContent;

      if (typeof clientContent !== "object" || clientContent === null) {
        continue;
      }

      const turns = (clientContent as { turns?: unknown }).turns;

      if (!Array.isArray(turns)) {
        continue;
      }

      for (const turn of turns) {
        const parts =
          typeof turn === "object" && turn !== null
            ? (turn as { parts?: unknown }).parts
            : null;

        if (!Array.isArray(parts)) {
          continue;
        }

        for (const part of parts) {
          const text =
            typeof part === "object" && part !== null
              ? (part as { text?: unknown }).text
              : null;

          if (typeof text === "string") {
            texts.push(text);
          }
        }
      }
    }

    return texts;
  }

  toolResponsePayloads(): unknown[] {
    return this.parsedClientEvents()
      .map((event) => event.toolResponse)
      .filter((response) => response !== undefined);
  }

  private send(payload: unknown): void {
    if (!this.socket) {
      throw new Error("Gemini WebSocket se ještě nepřipojil.");
    }

    this.socket.send(JSON.stringify(payload));
  }
}

async function pollUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Čekání na ${label} vypršelo.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
