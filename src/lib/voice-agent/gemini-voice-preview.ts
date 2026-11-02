import {
  GEMINI_TOKEN_ENDPOINT,
  GEMINI_TOOL_ENDPOINT,
  GEMINI_WEBSOCKET_URL,
} from "./gemini-endpoints";
import { isGeminiVoice, type GeminiVoice } from "./gemini-voices";
import { GEMINI_OUTPUT_SAMPLE_RATE, base64ToBytes } from "./pcm-audio";

export interface GeminiVoicePreviewAudio {
  readonly pcm: Uint8Array;
  readonly sampleRate: number;
}

interface GeminiTokenResponse {
  readonly token: string;
  readonly sessionId: string;
  readonly voice: string;
}

function isTokenResponse(value: unknown): value is GeminiTokenResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.token === "string" &&
    candidate.token.length > 0 &&
    typeof candidate.sessionId === "string" &&
    candidate.sessionId.length > 0 &&
    isGeminiVoice(candidate.voice)
  );
}

function readErrorMessage(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return "Zkoušku hlasu se nepodařilo spustit.";
  }

  const error = (value as { error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return "Zkoušku hlasu se nepodařilo spustit.";
  }

  const message = (error as { message?: unknown }).message;

  return typeof message === "string" && message.trim() !== ""
    ? message
    : "Zkoušku hlasu se nepodařilo spustit.";
}

async function endSession(sessionId: string): Promise<void> {
  try {
    await fetch(GEMINI_TOOL_ENDPOINT, {
      body: JSON.stringify({ action: "end", sessionId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch {
    // The server-side TTL is the fallback.
  }
}

export async function previewGeminiVoice(
  voice: GeminiVoice,
  text: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<GeminiVoicePreviewAudio> {
  const response = await fetch(GEMINI_TOKEN_ENDPOINT, {
    body: JSON.stringify({ voice }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: options.signal,
  });
  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(readErrorMessage(payload));
  }

  if (!isTokenResponse(payload) || payload.voice !== voice) {
    throw new Error("Server vrátil neplatný token relace.");
  }

  const sessionId = payload.sessionId;
  const socket = new WebSocket(
    `${GEMINI_WEBSOCKET_URL}?access_token=${encodeURIComponent(payload.token)}`,
  );
  const chunks: Uint8Array[] = [];
  let settled = false;

  return await new Promise<GeminiVoicePreviewAudio>((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish(new Error("Gemini neodpověděl včas. Zkuste to znovu."));
    }, options.timeoutMs ?? 20_000);

    function cleanup() {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", handleAbort);
      socket.close();
      void endSession(sessionId);
    }

    function finish(
      error: Error | null,
      audio?: GeminiVoicePreviewAudio,
    ): void {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      if (error) {
        reject(error);
      } else if (audio) {
        resolve(audio);
      }
    }

    function handleAbort() {
      finish(new Error("Zkouška hlasu byla zrušena."));
    }

    options.signal?.addEventListener("abort", handleAbort);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ setup: {} }));
    });

    function handleMessage(raw: string): void {
      let message: unknown;

      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }

      if (typeof message !== "object" || message === null) {
        return;
      }

      const record = message as Record<string, unknown>;

      if (record.setupComplete) {
        socket.send(
          JSON.stringify({
            clientContent: {
              turns: [
                {
                  parts: [
                    {
                      text: `Přečti přesně tuto testovací větu: „${text}“`,
                    },
                  ],
                  role: "user",
                },
              ],
              turnComplete: true,
            },
          }),
        );
        return;
      }

      const serverContent = record.serverContent;

      if (typeof serverContent !== "object" || serverContent === null) {
        return;
      }

      const content = serverContent as Record<string, unknown>;
      const modelTurn = content.modelTurn;

      if (typeof modelTurn === "object" && modelTurn !== null) {
        const parts = (modelTurn as { parts?: unknown }).parts;

        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (typeof part !== "object" || part === null) {
              continue;
            }

            const inlineData = (part as { inlineData?: unknown }).inlineData;

            if (typeof inlineData !== "object" || inlineData === null) {
              continue;
            }

            const data = (inlineData as { data?: unknown }).data;

            if (typeof data === "string") {
              chunks.push(base64ToBytes(data));
            }
          }
        }
      }

      if (content.turnComplete === true) {
        const total = chunks.reduce(
          (sum, chunk) => sum + chunk.byteLength,
          0,
        );

        if (total === 0) {
          finish(new Error("Gemini nevrátil žádný zvuk."));
          return;
        }

        const pcm = new Uint8Array(total);
        let offset = 0;

        for (const chunk of chunks) {
          pcm.set(chunk, offset);
          offset += chunk.byteLength;
        }

        finish(null, { pcm, sampleRate: GEMINI_OUTPUT_SAMPLE_RATE });
      }
    }

    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        handleMessage(event.data);
      } else if (event.data instanceof Blob) {
        void event.data.text().then(handleMessage);
      }
    });

    socket.addEventListener("error", () => {
      finish(new Error("Spojení s Gemini se nezdařilo."));
    });

    socket.addEventListener("close", () => {
      if (!settled) {
        finish(new Error("Gemini relace se uzavřela před dokončením."));
      }
    });
  });
}
