const PREFERENCE_KEY = "ai-voice-notes:stop-monitor-enabled";
const STATS_KEY = "ai-voice-notes:stop-monitor-stats";

export const EMPTY_STOP_MONITOR_STATS: StopMonitorStats = Object.freeze({
  attempts: 0,
  successes: 0,
  slowestDelayMs: null,
});

export interface StopMonitorStats {
  readonly attempts: number;
  readonly successes: number;
  readonly slowestDelayMs: number | null;
}

const preferenceListeners = new Set<() => void>();
const statsListeners = new Set<() => void>();
let preferenceSnapshot: boolean | null = null;
let statsSnapshot: StopMonitorStats | null = null;

function readPreference(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem(PREFERENCE_KEY) === "true";
  } catch {
    return false;
  }
}

function notifyPreference(): void {
  for (const listener of preferenceListeners) {
    listener();
  }
}

function notifyStats(): void {
  for (const listener of statsListeners) {
    listener();
  }
}

function isStopMonitorStats(value: unknown): value is StopMonitorStats {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<StopMonitorStats>;

  return (
    Number.isSafeInteger(candidate.attempts) &&
    candidate.attempts !== undefined &&
    candidate.attempts >= 0 &&
    Number.isSafeInteger(candidate.successes) &&
    candidate.successes !== undefined &&
    candidate.successes >= 0 &&
    candidate.successes <= candidate.attempts &&
    (candidate.slowestDelayMs === null ||
      (Number.isSafeInteger(candidate.slowestDelayMs) &&
        candidate.slowestDelayMs !== undefined &&
        candidate.slowestDelayMs >= 0))
  );
}

function readStats(): StopMonitorStats {
  if (typeof window === "undefined") {
    return EMPTY_STOP_MONITOR_STATS;
  }

  try {
    const stored = window.localStorage.getItem(STATS_KEY);

    if (stored === null) {
      return EMPTY_STOP_MONITOR_STATS;
    }

    const parsed: unknown = JSON.parse(stored);

    return isStopMonitorStats(parsed) ? parsed : EMPTY_STOP_MONITOR_STATS;
  } catch {
    return EMPTY_STOP_MONITOR_STATS;
  }
}

function writeStats(next: StopMonitorStats): void {
  statsSnapshot = next;

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STATS_KEY, JSON.stringify(next));
    } catch {
      // Statistics are diagnostics only; a full storage must not break Stop.
    }
  }

  notifyStats();
}

export function normalizeSpokenStopText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function isStandaloneStopCommand(text: string): boolean {
  return normalizeSpokenStopText(text) === "stop";
}

export function readStopMonitorPreference(): boolean {
  return preferenceSnapshot ?? readPreference();
}

export function writeStopMonitorPreference(enabled: boolean): void {
  preferenceSnapshot = enabled;

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(PREFERENCE_KEY, String(enabled));
    } catch {
      // Keep the in-memory preference for this tab.
    }

  }

  notifyPreference();
}

export function subscribeStopMonitorPreference(
  listener: () => void,
): () => void {
  preferenceListeners.add(listener);

  if (typeof window === "undefined") {
    return () => {
      preferenceListeners.delete(listener);
    };
  }

  function handleStorage(event: StorageEvent) {
    if (event.key === PREFERENCE_KEY) {
      preferenceSnapshot = readPreference();
      listener();
    }
  }

  window.addEventListener("storage", handleStorage);

  return () => {
    preferenceListeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

export function getStopMonitorPreferenceSnapshot(): boolean {
  preferenceSnapshot ??= readPreference();

  return preferenceSnapshot;
}

export function getStopMonitorPreferenceServerSnapshot(): boolean {
  return false;
}

export function getStopMonitorStatsSnapshot(): StopMonitorStats {
  statsSnapshot ??= readStats();

  return statsSnapshot;
}

export function getStopMonitorStatsServerSnapshot(): StopMonitorStats {
  return EMPTY_STOP_MONITOR_STATS;
}

export function subscribeStopMonitorStats(listener: () => void): () => void {
  statsListeners.add(listener);

  if (typeof window === "undefined") {
    return () => {
      statsListeners.delete(listener);
    };
  }

  function handleStorage(event: StorageEvent) {
    if (event.key === STATS_KEY) {
      statsSnapshot = readStats();
      listener();
    }
  }

  window.addEventListener("storage", handleStorage);

  return () => {
    statsListeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

export function recordStopMonitorAttempt(): void {
  const current = getStopMonitorStatsSnapshot();
  writeStats({ ...current, attempts: current.attempts + 1 });
}

export function recordStopMonitorSuccess(delayMs: number | null): void {
  const current = getStopMonitorStatsSnapshot();
  const delay =
    delayMs !== null && Number.isFinite(delayMs) && delayMs >= 0
      ? Math.round(delayMs)
      : null;
  const slowest =
    delay === null
      ? current.slowestDelayMs
      : Math.max(current.slowestDelayMs ?? 0, delay);

  writeStats({
    ...current,
    successes: current.successes + 1,
    slowestDelayMs: slowest,
  });
}

export function resetStopMonitorStats(): void {
  writeStats(EMPTY_STOP_MONITOR_STATS);
}

export function resetStopMonitorForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "Reset hlasového Stopu lze použít pouze v NODE_ENV=test.",
    );
  }

  preferenceSnapshot = false;
  statsSnapshot = EMPTY_STOP_MONITOR_STATS;
  preferenceListeners.clear();
  statsListeners.clear();

  if (typeof window !== "undefined") {
    window.localStorage.removeItem(PREFERENCE_KEY);
    window.localStorage.removeItem(STATS_KEY);
  }
}

export function formatStopMonitorDelay(value: number | null): string {
  return value === null
    ? "zatím neměřeno"
    : `${value.toLocaleString("cs-CZ")} ms`;
}
