"use client";

export type VoiceAgentConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export type VoiceAgentConversationState =
  | "idle"
  | "user-speaking"
  | "waiting"
  | "assistant-speaking";

const STATUS_LABELS: Record<VoiceAgentConnectionStatus, string> = {
  connecting: "Připojuji",
  connected: "Připojeno",
  disconnected: "Odpojeno",
  error: "Chyba",
};

const CONVERSATION_LABELS: Record<VoiceAgentConversationState, string> = {
  idle: "Připraveno k rozhovoru",
  "user-speaking": "Mluvíte",
  waiting: "Čekám na odpověď",
  "assistant-speaking": "Asistent mluví",
};

export interface ConnectionStatusProps {
  readonly status: VoiceAgentConnectionStatus;
  readonly conversation?: VoiceAgentConversationState;
  readonly microphoneActive?: boolean;
  readonly error?: string | null;
  readonly detail?: string | null;
}

export function ConnectionStatus({
  status,
  conversation = "idle",
  microphoneActive = false,
  error = null,
  detail = null,
}: ConnectionStatusProps) {
  return (
    <div
      className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-4"
      data-testid="voice-agent-connection-status"
    >
      <p
        aria-live="polite"
        className="text-sm font-medium text-stone-800"
        role={status === "error" ? "alert" : "status"}
      >
        Stav připojení:{" "}
        <strong className="font-semibold text-stone-950">
          {STATUS_LABELS[status]}
        </strong>
      </p>
      <p className="mt-2 text-sm text-stone-700">
        Mikrofon:{" "}
        <strong className="font-semibold text-stone-950">
          {microphoneActive ? "aktivní" : "vypnutý"}
        </strong>
      </p>
      <p className="mt-1 text-sm text-stone-700" data-testid="voice-agent-turn-state">
        Režim:{" "}
        <strong className="font-semibold text-stone-950">
          {CONVERSATION_LABELS[conversation]}
        </strong>
      </p>
      {detail ? (
        <p className="mt-2 text-sm leading-6 text-stone-600">{detail}</p>
      ) : null}
      {status === "error" && error ? (
        <p className="mt-2 text-sm leading-6 text-red-800">{error}</p>
      ) : null}
    </div>
  );
}
