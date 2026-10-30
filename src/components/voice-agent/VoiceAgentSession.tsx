"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  ConnectionStatus,
  type VoiceAgentConnectionStatus,
} from "./ConnectionStatus";

export const VOICE_AGENT_DATA_CHANNEL = "oai-events";
export const VOICE_AGENT_SESSION_ENDPOINT = "/api/voice-agent/session";
export const VOICE_AGENT_END_ENDPOINT = "/api/voice-agent/end";
export const VOICE_AGENT_ICE_GATHERING_TIMEOUT_MS = 10_000;
const END_FAILED_MESSAGE =
  "Relaci se nepodařilo ukončit na serveru. Zkuste to znovu nebo počkejte na vypršení limitu.";

interface VoiceAgentSessionResponse {
  readonly sessionId: string;
  readonly answerSdp: string;
  readonly maxSessionSeconds: number;
  readonly expiresAt: string;
}

function isSessionResponse(value: unknown): value is VoiceAgentSessionResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.sessionId === "string" &&
    candidate.sessionId.length >= 20 &&
    typeof candidate.answerSdp === "string" &&
    candidate.answerSdp.startsWith("v=0") &&
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

async function endVoiceAgentSession(sessionId: string): Promise<boolean> {
  try {
    const response = await fetch(VOICE_AGENT_END_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
      keepalive: true,
    });

    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

async function waitForIceGathering(
  peer: RTCPeerConnection,
): Promise<void> {
  if (peer.iceGatheringState === "complete") {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      peer.removeEventListener("icegatheringstatechange", onChange);
      reject(
        new Error("Sběr ICE kandidátů vypršel. Zkuste připojení znovu."),
      );
    }, VOICE_AGENT_ICE_GATHERING_TIMEOUT_MS);

    function onChange() {
      if (settled || peer.iceGatheringState !== "complete") {
        return;
      }

      settled = true;
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }

    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

export function VoiceAgentSession() {
  const [status, setStatus] =
    useState<VoiceAgentConnectionStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const autoEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const mountedRef = useRef(true);

  const endAndReport = useCallback((sessionId: string, attempt: number) => {
    void endVoiceAgentSession(sessionId).then((ended) => {
      if (
        !ended &&
        mountedRef.current &&
        attemptRef.current === attempt
      ) {
        setStatus("error");
        setError((current) => current ?? END_FAILED_MESSAGE);
      }
    });
  }, []);

  const shutdown = useCallback(
    (
      nextStatus: VoiceAgentConnectionStatus,
      message: string | null = null,
      detailText: string | null = null,
    ) => {
      const sessionId = sessionIdRef.current;
      const attemptAtShutdown = attemptRef.current;
      sessionIdRef.current = null;

      if (autoEndTimerRef.current !== null) {
        clearTimeout(autoEndTimerRef.current);
        autoEndTimerRef.current = null;
      }

      const channel = channelRef.current;
      const peer = peerRef.current;
      channelRef.current = null;
      peerRef.current = null;
      channel?.close();
      peer?.close();

      if (sessionId !== null) {
        endAndReport(sessionId, attemptAtShutdown);
      }

      setConnecting(false);
      setStatus(nextStatus);
      setError(message);
      setDetail(detailText);
      setExpiresAt(null);
    },
    [endAndReport],
  );

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      attemptRef.current += 1;
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;

      if (autoEndTimerRef.current !== null) {
        clearTimeout(autoEndTimerRef.current);
        autoEndTimerRef.current = null;
      }

      const channel = channelRef.current;
      const peer = peerRef.current;
      channelRef.current = null;
      peerRef.current = null;
      channel?.close();
      peer?.close();

      if (sessionId !== null) {
        void endVoiceAgentSession(sessionId);
      }
    };
  }, []);

  async function connect() {
    if (connecting || peerRef.current !== null) {
      return;
    }

    attemptRef.current += 1;
    const attempt = attemptRef.current;

    setConnecting(true);
    setError(null);
    setDetail(null);
    setExpiresAt(null);
    setStatus("connecting");

    let peer: RTCPeerConnection | null = null;

    try {
      const connection = new RTCPeerConnection();
      peer = connection;
      peerRef.current = connection;

      const channel = connection.createDataChannel(VOICE_AGENT_DATA_CHANNEL);
      channelRef.current = channel;
      channel.addEventListener("message", () => undefined);

      connection.addTransceiver("audio", { direction: "recvonly" });

      connection.addEventListener("connectionstatechange", () => {
        if (peerRef.current !== connection) {
          return;
        }

        if (connection.connectionState === "connected") {
          setStatus("connected");
          setDetail("Relace OpenAI Realtime je připojená.");
        } else if (
          connection.connectionState === "failed" ||
          connection.connectionState === "disconnected"
        ) {
          shutdown("error", "Spojení s OpenAI se přerušilo. Připojte se znovu.");
        }
      });

      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      await waitForIceGathering(connection);

      if (attemptRef.current !== attempt || !mountedRef.current) {
        connection.close();
        return;
      }

      const localSdp = connection.localDescription?.sdp;

      if (!localSdp) {
        throw new Error("Chybí lokální SDP nabídka pro WebRTC relaci.");
      }

      const response = await fetch(VOICE_AGENT_SESSION_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sdp: localSdp }),
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(readErrorMessage(payload));
      }

      if (!isSessionResponse(payload)) {
        throw new Error("Server vrátil neplatnou odpověď relace.");
      }

      if (attemptRef.current !== attempt || !mountedRef.current) {
        const attemptAtCancellation = attemptRef.current;
        endAndReport(payload.sessionId, attemptAtCancellation);
        connection.close();
        return;
      }

      sessionIdRef.current = payload.sessionId;
      setExpiresAt(payload.expiresAt);

      await connection.setRemoteDescription({
        type: "answer",
        sdp: payload.answerSdp,
      });

      if (attemptRef.current !== attempt || !mountedRef.current) {
        shutdown("disconnected");
        return;
      }

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

      setConnecting(false);

      if (connection.connectionState === "connected") {
        setStatus("connected");
        setDetail("Relace OpenAI Realtime je připojená.");
      }
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : "Relaci se nepodařilo vytvořit.";

      if (attemptRef.current === attempt) {
        shutdown("error", message);
      } else {
        peer?.close();
      }
    }
  }

  function disconnect() {
    attemptRef.current += 1;
    shutdown("disconnected");
  }

  const canConnect = !connecting && status !== "connected";
  const canStop = status === "connecting" || status === "connected";

  return (
    <section
      aria-labelledby="voice-agent-session-title"
      className="mt-8 rounded-2xl border border-stone-200 bg-white p-6"
    >
      <h2
        id="voice-agent-session-title"
        className="text-xl font-semibold text-stone-950"
      >
        Připojení k hlasovému agentovi
      </h2>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-stone-600">
        Tato fáze ověřuje pouze navázání serverově zprostředkované WebRTC
        relace. Mikrofon se zatím nezapíná a relace nemá přístup k poznámkám
        ani žádné nástroje.
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

      <ConnectionStatus status={status} error={error} detail={detail} />

      {expiresAt !== null && status === "connected" ? (
        <p className="mt-3 text-sm text-stone-600">
          Relace se automaticky ukončí nejpozději v{" "}
          {new Date(expiresAt).toLocaleTimeString("cs-CZ")}.
        </p>
      ) : null}
    </section>
  );
}
