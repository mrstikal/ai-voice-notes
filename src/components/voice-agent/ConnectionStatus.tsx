"use client";

export type VoiceAgentConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

const STATUS_LABELS: Record<VoiceAgentConnectionStatus, string> = {
  connecting: "Připojuji",
  connected: "Připojeno",
  disconnected: "Odpojeno",
  error: "Chyba",
};

export interface ConnectionStatusProps {
  readonly status: VoiceAgentConnectionStatus;
  readonly error?: string | null;
  readonly detail?: string | null;
}

export function ConnectionStatus({
  status,
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
      {detail ? (
        <p className="mt-2 text-sm leading-6 text-stone-600">{detail}</p>
      ) : null}
      {status === "error" && error ? (
        <p className="mt-2 text-sm leading-6 text-red-800">{error}</p>
      ) : null}
    </div>
  );
}
