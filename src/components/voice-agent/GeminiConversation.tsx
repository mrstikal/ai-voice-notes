"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  MicrophoneLeaseError,
  acquireMicrophoneLease,
  type MicrophoneLease,
} from "@/lib/voice/microphone";
import {
  DEFAULT_GEMINI_VOICE,
  GEMINI_LIVE_VOICES,
  isGeminiVoice,
  type GeminiVoice,
} from "@/lib/voice-agent/gemini-voices";
import {
  GEMINI_INPUT_SAMPLE_RATE,
  GEMINI_OUTPUT_SAMPLE_RATE,
  base64ToBytes,
  bytesToBase64,
  float32ToPcm16,
  pcm16ToFloat32,
  resamplePcm16,
} from "@/lib/voice-agent/pcm-audio";

import {
  ConnectionStatus,
  type VoiceAgentConnectionStatus,
  type VoiceAgentConversationState,
} from "./ConnectionStatus";

export const GEMINI_TOKEN_ENDPOINT = "/api/voice-agent/gemini-token";
export const GEMINI_WEBSOCKET_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
const SETUP_TIMEOUT_MS = 15_000;
const MAX_TRANSCRIPT_CHARACTERS = 2_000;
const MICROPHONE_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

interface GeminiTokenResponse {
  readonly token: string;
  readonly model: string;
  readonly voice: GeminiVoice;
  readonly maxSessionSeconds: number;
  readonly expiresAt: string;
}

interface Transcript {
  readonly user: string;
  readonly assistant: string;
}

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
  const scope = window as Window & {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };

  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

function isTokenResponse(value: unknown): value is GeminiTokenResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.token === "string" &&
    candidate.token.length > 0 &&
    typeof candidate.model === "string" &&
    isGeminiVoice(candidate.voice) &&
    typeof candidate.maxSessionSeconds === "number" &&
    Number.isFinite(candidate.maxSessionSeconds) &&
    typeof candidate.expiresAt === "string"
  );
}

function readErrorMessage(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return "Relaci se nepodařilo vytvořit.";
  }

  const error = (value as { error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return "Relaci se nepodařilo vytvořit.";
  }

  const message = (error as { message?: unknown }).message;

  return typeof message === "string" && message.trim() !== ""
    ? message
    : "Relaci se nepodařilo vytvořit.";
}

function capTranscript(text: string): string {
  return text.slice(-MAX_TRANSCRIPT_CHARACTERS);
}

function toCzechMicrophoneError(error: unknown): string {
  const name =
    typeof error === "object" && error !== null
      ? String((error as { name?: unknown }).name ?? "")
      : "";

  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Přístup k mikrofonu byl zamítnut. Povolte jej v prohlížeči a zkuste to znovu.";
  }

  if (name === "NotFoundError") {
    return "Mikrofon nebyl nalezen. Připojte mikrofon a zkuste to znovu.";
  }

  if (name === "NotReadableError") {
    return "Mikrofon je obsazený jinou aplikací. Uvolněte jej a zkuste to znovu.";
  }

  if (error instanceof MicrophoneLeaseError) {
    if (error.code === "busy") {
      return "Mikrofon už používá jiná karta (diktování, čtení nahlas nebo monitor). Ukončete ji a zkuste to znovu.";
    }

    return error.message;
  }

  return "Mikrofon se nepodařilo zapnout. Zkontrolujte oprávnění a zkuste to znovu.";
}

function websocketUrl(token: string): string {
  return `${GEMINI_WEBSOCKET_URL}?access_token=${encodeURIComponent(token)}`;
}

export function GeminiConversation() {
  const [status, setStatus] =
    useState<VoiceAgentConnectionStatus>("disconnected");
  const [conversation, setConversation] =
    useState<VoiceAgentConversationState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [microphoneActive, setMicrophoneActive] = useState(false);
  const [voice, setVoice] = useState<GeminiVoice>(DEFAULT_GEMINI_VOICE);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Transcript>({
    user: "",
    assistant: "",
  });
  const [showCaptions, setShowCaptions] = useState(true);
  const [audioBlocked, setAudioBlocked] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const microphoneLeaseRef = useRef<MicrophoneLease | null>(null);
  const inputContextRef = useRef<AudioContext | null>(null);
  const outputContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const inputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextPlayAtRef = useRef(0);
  const setupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const mountedRef = useRef(true);
  const streamingRef = useRef(false);
  const stoppingRef = useRef(false);

  const stopPlayback = useCallback(() => {
    for (const source of sourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }

    sourcesRef.current.clear();
    nextPlayAtRef.current = 0;
  }, []);

  const releaseAudio = useCallback(() => {
    const stream = microphoneStreamRef.current;
    microphoneStreamRef.current = null;

    for (const track of stream?.getTracks() ?? []) {
      track.stop();
    }

    const lease = microphoneLeaseRef.current;
    microphoneLeaseRef.current = null;
    void lease?.release();

    processorRef.current?.disconnect();
    processorRef.current = null;
    inputSourceRef.current?.disconnect();
    inputSourceRef.current = null;
    silentGainRef.current?.disconnect();
    silentGainRef.current = null;

    void inputContextRef.current?.close().catch(() => undefined);
    inputContextRef.current = null;

    stopPlayback();
    void outputContextRef.current?.close().catch(() => undefined);
    outputContextRef.current = null;
  }, [stopPlayback]);

  const shutdown = useCallback(
    (
      nextStatus: VoiceAgentConnectionStatus,
      message: string | null = null,
      detailText: string | null = null,
    ) => {
      stoppingRef.current = true;
      streamingRef.current = false;

      if (setupTimerRef.current !== null) {
        clearTimeout(setupTimerRef.current);
        setupTimerRef.current = null;
      }

      if (autoEndTimerRef.current !== null) {
        clearTimeout(autoEndTimerRef.current);
        autoEndTimerRef.current = null;
      }

      const socket = socketRef.current;
      socketRef.current = null;

      if (socket && socket.readyState <= WebSocket.OPEN) {
        try {
          socket.close(1000, "user-stop");
        } catch {
          // Ignore close races.
        }
      }

      releaseAudio();
      setMicrophoneActive(false);
      setConnecting(false);
      setStatus(nextStatus);
      setConversation("idle");
      setError(message);
      setDetail(detailText);
      setExpiresAt(null);
      setTranscript({ user: "", assistant: "" });
    },
    [releaseAudio],
  );

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      attemptRef.current += 1;
      stoppingRef.current = true;
      streamingRef.current = false;

      if (setupTimerRef.current !== null) {
        clearTimeout(setupTimerRef.current);
        setupTimerRef.current = null;
      }

      if (autoEndTimerRef.current !== null) {
        clearTimeout(autoEndTimerRef.current);
        autoEndTimerRef.current = null;
      }

      const socket = socketRef.current;
      socketRef.current = null;

      if (socket && socket.readyState <= WebSocket.OPEN) {
        try {
          socket.close(1000, "unmount");
        } catch {
          // Ignore close races.
        }
      }

      releaseAudio();
    };
  }, [releaseAudio]);

  const playPcm = useCallback(
    (encoded: string) => {
      const context = outputContextRef.current;

      if (!context) {
        return;
      }

      if (context.state === "suspended") {
        void context.resume().catch(() => {
          if (mountedRef.current) {
            setAudioBlocked(true);
          }
        });
      }

      let bytes: Uint8Array;

      try {
        bytes = base64ToBytes(encoded);
      } catch {
        return;
      }

      if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
        return;
      }

      const samples = pcm16ToFloat32(bytes);
      const buffer = context.createBuffer(
        1,
        samples.length,
        GEMINI_OUTPUT_SAMPLE_RATE,
      );
      buffer.copyToChannel(samples, 0);

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const startAt = Math.max(context.currentTime, nextPlayAtRef.current);
      source.start(startAt);
      nextPlayAtRef.current = startAt + buffer.duration;
      sourcesRef.current.add(source);
      source.onended = () => {
        sourcesRef.current.delete(source);
      };
    },
    [],
  );

  function startMicrophoneStreaming(attempt: number) {
    const Constructor = audioContextConstructor();
    const stream = microphoneStreamRef.current;

    if (!Constructor || !stream || !mountedRef.current) {
      return;
    }

    const context = new Constructor({
      sampleRate: GEMINI_INPUT_SAMPLE_RATE,
    });
    inputContextRef.current = context;
    const source = context.createMediaStreamSource(stream);
    inputSourceRef.current = source;
    const processor = context.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;
    const gain = context.createGain();
    gain.gain.value = 0;
    silentGainRef.current = gain;
    source.connect(processor);
    processor.connect(gain);
    gain.connect(context.destination);
    streamingRef.current = true;

    processor.onaudioprocess = (event) => {
      if (
        !streamingRef.current ||
        attemptRef.current !== attempt ||
        !mountedRef.current
      ) {
        return;
      }

      const socket = socketRef.current;

      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      const input = event.inputBuffer.getChannelData(0);
      const pcm =
        context.sampleRate === GEMINI_INPUT_SAMPLE_RATE
          ? float32ToPcm16(input)
          : resamplePcm16(
              float32ToPcm16(input),
              context.sampleRate,
              GEMINI_INPUT_SAMPLE_RATE,
            );

      if (pcm.byteLength === 0) {
        return;
      }

      socket.send(
        JSON.stringify({
          realtimeInput: {
            audio: {
              mimeType: "audio/pcm;rate=16000",
              data: bytesToBase64(pcm),
            },
          },
        }),
      );
    };
  }

  async function handleServerMessage(
    raw: string,
    attempt: number,
  ): Promise<void> {
    if (!mountedRef.current || attemptRef.current !== attempt) {
      return;
    }

    let message: Record<string, unknown>;

    try {
      const parsed: unknown = JSON.parse(raw);

      if (typeof parsed !== "object" || parsed === null) {
        return;
      }

      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    if (message.setupComplete) {
      if (setupTimerRef.current !== null) {
        clearTimeout(setupTimerRef.current);
        setupTimerRef.current = null;
      }

      try {
        startMicrophoneStreaming(attempt);
      } catch {
        shutdown(
          "error",
          "Mikrofon nebo zvukový výstup se nepodařilo spustit. Zkuste to znovu.",
        );
        return;
      }

      setStatus("connected");
      setConversation("idle");
      setDetail("Mluvte česky. Gemini odpovídá průběžně.");
      return;
    }

    if (message.goAway) {
      shutdown(
        "disconnected",
        "Relace Gemini se blíží ke konci. Připojte se znovu.",
      );
      return;
    }

    if (message.error) {
      shutdown("error", "Gemini ohlásil chybu hlasové relace. Zkuste to znovu.");
      return;
    }

    const serverContent = message.serverContent;

    if (typeof serverContent !== "object" || serverContent === null) {
      return;
    }

    const content = serverContent as Record<string, unknown>;

    if (content.interrupted === true) {
      stopPlayback();
    }

    const inputTranscription = content.inputTranscription;

    if (
      typeof inputTranscription === "object" &&
      inputTranscription !== null
    ) {
      const text = (inputTranscription as { text?: unknown }).text;

      if (typeof text === "string") {
        setTranscript((current) => ({
          ...current,
          user: capTranscript(text),
        }));
        setConversation("user-speaking");
      }
    }

    const outputTranscription = content.outputTranscription;

    if (
      typeof outputTranscription === "object" &&
      outputTranscription !== null
    ) {
      const text = (outputTranscription as { text?: unknown }).text;

      if (typeof text === "string") {
        setTranscript((current) => ({
          ...current,
          assistant: capTranscript(text),
        }));
        setConversation("assistant-speaking");
      }
    }

    const modelTurn = content.modelTurn;

    if (typeof modelTurn === "object" && modelTurn !== null) {
      const parts = (modelTurn as { parts?: unknown }).parts;

      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (typeof part !== "object" || part === null) {
            continue;
          }

          const inlineData = (part as { inlineData?: unknown }).inlineData;

          if (typeof inlineData === "object" && inlineData !== null) {
            const data = (inlineData as { data?: unknown }).data;

            if (typeof data === "string") {
              playPcm(data);
            }
          }

          const text = (part as { text?: unknown }).text;

          if (typeof text === "string") {
            setTranscript((current) => ({
              ...current,
              assistant: capTranscript(current.assistant + text),
            }));
            setConversation("assistant-speaking");
          }
        }
      }
    }

    if (content.turnComplete === true) {
      setConversation("idle");
    }
  }

  async function connect() {
    if (connecting || socketRef.current !== null) {
      return;
    }

    const Constructor = audioContextConstructor();

    if (!Constructor) {
      setStatus("error");
      setError("Tento prohlížeč nepodporuje přehrávání hlasu.");
      return;
    }

    setAudioBlocked(false);
    let outputContext: AudioContext;

    try {
      outputContext = new Constructor({
        sampleRate: GEMINI_OUTPUT_SAMPLE_RATE,
      });
    } catch {
      setStatus("error");
      setDetail(null);
      setError(
        "Prohlížeč nepovolil zvukový výstup. Zkontrolujte oprávnění a zkuste to znovu.",
      );
      return;
    }

    outputContextRef.current = outputContext;
    void outputContext.resume().catch(() => {
      if (mountedRef.current) {
        setAudioBlocked(true);
      }
    });

    attemptRef.current += 1;
    const attempt = attemptRef.current;
    const selectedVoice = voice;

    stoppingRef.current = false;
    streamingRef.current = false;
    setConnecting(true);
    setError(null);
    setDetail(null);
    setExpiresAt(null);
    setTranscript({ user: "", assistant: "" });
    setConversation("idle");
    setStatus("connecting");
    let microphoneReady = false;

    try {
      const lease = await acquireMicrophoneLease();

      if (attemptRef.current !== attempt) {
        await lease.release();
        return;
      }

      microphoneLeaseRef.current = lease;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: MICROPHONE_CONSTRAINTS,
      });

      if (attemptRef.current !== attempt) {
        for (const track of stream.getTracks()) {
          track.stop();
        }

        await lease.release();

        if (microphoneLeaseRef.current === lease) {
          microphoneLeaseRef.current = null;
        }

        return;
      }

      microphoneStreamRef.current = stream;
      microphoneReady = true;
      setMicrophoneActive(true);

      let response: Response;

      try {
        response = await fetch(GEMINI_TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ voice: selectedVoice }),
        });
      } catch {
        throw new Error(
          "Spojení s aplikací se nepodařilo. Zkontrolujte připojení a zkuste to znovu.",
        );
      }

      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(readErrorMessage(payload));
      }

      if (!isTokenResponse(payload) || payload.voice !== selectedVoice) {
        throw new Error("Server vrátil neplatný token relace.");
      }

      if (attemptRef.current !== attempt || !mountedRef.current) {
        return;
      }

      setExpiresAt(payload.expiresAt);
      const socket = new WebSocket(websocketUrl(payload.token));
      socketRef.current = socket;
      setupTimerRef.current = setTimeout(() => {
        if (socketRef.current === socket) {
          shutdown("error", "Gemini neodpověděl včas. Zkuste to znovu.");
        }
      }, SETUP_TIMEOUT_MS);

      socket.addEventListener("open", () => {
        if (attemptRef.current !== attempt) {
          return;
        }

        socket.send(JSON.stringify({ setup: {} }));
      });

      socket.addEventListener("message", (event) => {
        const handle = (raw: string) => {
          void handleServerMessage(raw, attempt).catch(() => {
            if (mountedRef.current && attemptRef.current === attempt) {
              shutdown(
                "error",
                "Hlasovou relaci se nepodařilo zpracovat. Zkuste to znovu.",
              );
            }
          });
        };

        if (typeof event.data === "string") {
          handle(event.data);
        } else if (event.data instanceof Blob) {
          event.data
            .text()
            .then(handle)
            .catch(() => {
              if (mountedRef.current && attemptRef.current === attempt) {
                shutdown("error", "Zvuk od Gemini se nepodařilo přečíst.");
              }
            });
        } else if (event.data instanceof ArrayBuffer) {
          handle(new TextDecoder().decode(event.data));
        }
      });

      socket.addEventListener("error", () => {
        if (
          !stoppingRef.current &&
          attemptRef.current === attempt &&
          mountedRef.current
        ) {
          shutdown("error", "Spojení s Gemini se nepřerušilo. Zkuste to znovu.");
        }
      });

      socket.addEventListener("close", () => {
        if (
          !stoppingRef.current &&
          attemptRef.current === attempt &&
          mountedRef.current
        ) {
          shutdown("error", "Spojení s Gemini se uzavřelo. Připojte se znovu.");
        }
      });

      const expiryMs = Date.parse(payload.expiresAt) - Date.now();
      const maxMs = payload.maxSessionSeconds * 1000;
      const remainingMs = Math.max(0, Math.min(expiryMs, maxMs));
      autoEndTimerRef.current = setTimeout(() => {
        shutdown(
          "disconnected",
          null,
          "Časový limit relace vypršel. Připojte se znovu.",
        );
      }, remainingMs);
    } catch (caught) {
      const message =
        microphoneReady && caught instanceof Error
          ? caught.message
          : toCzechMicrophoneError(caught);

      if (attemptRef.current === attempt) {
        shutdown("error", message);
      }
    }
  }

  function disconnect() {
    attemptRef.current += 1;
    shutdown("disconnected");
  }

  function enableAudio() {
    const context = outputContextRef.current;

    if (!context) {
      return;
    }

    void context
      .resume()
      .then(() => {
        if (mountedRef.current) {
          setAudioBlocked(false);
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          setAudioBlocked(true);
        }
      });
  }

  const canConnect = !connecting && status !== "connected";
  const canStop = status === "connecting" || status === "connected";
  const hasTranscript =
    transcript.user.trim() !== "" || transcript.assistant.trim() !== "";

  return (
    <section
      aria-labelledby="voice-agent-session-title"
      className="mt-8 rounded-2xl border border-stone-200 bg-white p-6"
    >
      <h2
        id="voice-agent-session-title"
        className="text-xl font-semibold text-stone-950"
      >
        Hlasová konverzace
      </h2>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-stone-600">
        Po kliknutí na Připojit aplikace požádá o výhradní mikrofon. Diktování,
        čtení nahlas i monitor ve jiné kartě musí být ukončené; mikrofon
        současně použít nelze. Zvuk ani přepis se neukládají.
      </p>

      <label className="mt-5 block max-w-sm text-sm font-medium text-stone-800">
        Hlas Gemini
        <select
          className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 disabled:bg-stone-100 disabled:text-stone-500"
          disabled={connecting || status === "connected"}
          onChange={(event) => {
            if (isGeminiVoice(event.target.value)) {
              setVoice(event.target.value);
            }
          }}
          value={voice}
        >
          {GEMINI_LIVE_VOICES.map((option) => (
            <option key={option.id} value={option.id}>
              {option.id} – {option.description}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-1 text-xs leading-5 text-stone-500">
        Hlas lze změnit jen před připojením; nový hlas vyžaduje novou relaci.
      </p>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          disabled={!canConnect}
          onClick={connect}
          type="button"
        >
          Připojit
        </button>
        <button
          className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:border-stone-200 disabled:text-stone-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          disabled={!canStop}
          onClick={disconnect}
          type="button"
        >
          Ukončit
        </button>
      </div>

      <ConnectionStatus
        conversation={conversation}
        detail={detail}
        error={error}
        microphoneActive={microphoneActive}
        status={status}
      />

      {audioBlocked ? (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          <p>Prohlížeč zablokoval automatické přehrávání zvuku.</p>
          <button
            className="mt-2 rounded-lg border border-amber-400 px-3 py-1.5 font-semibold text-amber-950 hover:bg-amber-100"
            onClick={enableAudio}
            type="button"
          >
            Zapnout zvuk
          </button>
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-stone-800">Titulky</h3>
        <label className="flex items-center gap-2 text-sm text-stone-700">
          <input
            checked={showCaptions}
            onChange={(event) => setShowCaptions(event.target.checked)}
            type="checkbox"
          />
          Zobrazit titulky
        </label>
      </div>

      {showCaptions && hasTranscript ? (
        <div
          aria-live="polite"
          className="mt-3 space-y-2 rounded-xl bg-stone-50 p-4 text-sm leading-6 text-stone-800"
        >
          {transcript.user ? (
            <p>
              <strong className="font-semibold">Vy:</strong> {transcript.user}
            </p>
          ) : null}
          {transcript.assistant ? (
            <p>
              <strong className="font-semibold">Asistent:</strong>{" "}
              {transcript.assistant}
            </p>
          ) : null}
        </div>
      ) : null}

      {expiresAt !== null && status === "connected" ? (
        <p className="mt-3 text-sm text-stone-600">
          Relace se automaticky ukončí nejpozději v{" "}
          {new Date(expiresAt).toLocaleTimeString("cs-CZ")}.
        </p>
      ) : null}
    </section>
  );
}
