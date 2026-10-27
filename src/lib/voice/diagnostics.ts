export interface VoiceDiagnosticsSnapshot {
  readonly lastCommitLatencyMs: number | null;
  readonly lastCommandLatencyMs: number | null;
  readonly manualReconnectCount: number;
  readonly measuredCommitCount: number;
}

const EMPTY_DIAGNOSTICS: VoiceDiagnosticsSnapshot = Object.freeze({
  lastCommitLatencyMs: null,
  lastCommandLatencyMs: null,
  manualReconnectCount: 0,
  measuredCommitCount: 0,
});

let snapshot: VoiceDiagnosticsSnapshot = EMPTY_DIAGNOSTICS;
const listeners = new Set<() => void>();

function publish(next: VoiceDiagnosticsSnapshot): void {
  snapshot = next;

  for (const listener of listeners) {
    listener();
  }
}

function normalizeLatency(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.round(value);
}

export function recordVoiceCommitLatency(value: number | null): void {
  const latency = normalizeLatency(value);

  if (latency === null) {
    return;
  }

  publish({
    ...snapshot,
    lastCommitLatencyMs: latency,
    measuredCommitCount: snapshot.measuredCommitCount + 1,
  });
}

export function recordVoiceCommandLatency(value: number | null): void {
  const latency = normalizeLatency(value);

  if (latency === null) {
    return;
  }

  publish({
    ...snapshot,
    lastCommandLatencyMs: latency,
  });
}

export function recordVoiceManualReconnect(): void {
  publish({
    ...snapshot,
    manualReconnectCount: snapshot.manualReconnectCount + 1,
  });
}

export function resetVoiceDiagnostics(): void {
  publish(EMPTY_DIAGNOSTICS);
}

export function subscribeVoiceDiagnostics(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function getVoiceDiagnosticsSnapshot(): VoiceDiagnosticsSnapshot {
  return snapshot;
}

export function getVoiceDiagnosticsServerSnapshot(): VoiceDiagnosticsSnapshot {
  return EMPTY_DIAGNOSTICS;
}
