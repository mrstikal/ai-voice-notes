export const MICROPHONE_LOCK_NAME = "ai-voice-notes:microphone";
export const MICROPHONE_SESSION_MAX_MS = 180_000;
export const SCRIBE_MODEL_ID = "scribe_v2_realtime";
export const SCRIBE_LANGUAGE_CODE = "cs";
export const SCRIBE_VAD_SILENCE_THRESHOLD_SECS = 1.2;

export type MicrophoneSessionStatus =
  | "idle"
  | "acquiring-lease"
  | "requesting-token"
  | "connecting"
  | "active"
  | "stopping"
  | "error";

export interface MicrophoneSessionState {
  readonly status: MicrophoneSessionStatus;
  readonly error: string | null;
  readonly notice: string | null;
  readonly startedAt: number | null;
}

export const INITIAL_MICROPHONE_SESSION_STATE: MicrophoneSessionState = {
  status: "idle",
  error: null,
  notice: null,
  startedAt: null,
};

export type MicrophoneStopReason =
  | "user"
  | "unmount"
  | "timeout"
  | "connection-lost"
  | "error";

export type MicrophoneLockMode = "exclusive" | "shared";

export interface MicrophoneLock {
  readonly name: string;
  readonly mode: MicrophoneLockMode;
}

export interface MicrophoneLockManager {
  request(
    name: string,
    options: {
      readonly mode?: MicrophoneLockMode;
      readonly ifAvailable?: boolean;
    },
    callback: (lock: MicrophoneLock | null) => Promise<void> | void,
  ): Promise<void>;
}

export interface MicrophoneLease {
  release(): Promise<void>;
}

export type MicrophoneLeaseErrorCode = "unsupported" | "busy" | "failed";

export class MicrophoneLeaseError extends Error {
  readonly code: MicrophoneLeaseErrorCode;

  constructor(code: MicrophoneLeaseErrorCode, message: string) {
    super(message);
    this.name = "MicrophoneLeaseError";
    this.code = code;
  }
}

export class MicrophoneSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicrophoneSessionError";
  }
}

function getNavigatorLocks(): MicrophoneLockManager | null {
  if (typeof navigator === "undefined") {
    return null;
  }

  const locks = (
    navigator as unknown as { readonly locks?: MicrophoneLockManager }
  ).locks;

  return locks ?? null;
}

export function isWebLocksSupported(
  locks: MicrophoneLockManager | null | undefined = getNavigatorLocks(),
): boolean {
  return locks !== null && locks !== undefined && typeof locks.request === "function";
}

export async function acquireMicrophoneLease(
  options: { readonly locks?: MicrophoneLockManager | null } = {},
): Promise<MicrophoneLease> {
  const locks =
    options.locks === undefined ? getNavigatorLocks() : options.locks;

  if (locks === null || locks === undefined || !isWebLocksSupported(locks)) {
    throw new MicrophoneLeaseError(
      "unsupported",
      "Tento prohlížeč nepodporuje Web Locks, proto nelze bezpečně zajistit výhradní mikrofon. Otevřete aplikaci v Chromiu nebo Edge.",
    );
  }

  let releaseLock!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  let resolveAcquired!: (value: boolean) => void;
  const acquired = new Promise<boolean>((resolve) => {
    resolveAcquired = resolve;
  });

  let finishRequest!: () => void;
  const requestFinished = new Promise<void>((resolve) => {
    finishRequest = resolve;
  });
  let requestFailed = false;

  try {
    void locks
      .request(
        MICROPHONE_LOCK_NAME,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) {
            resolveAcquired(false);
            return;
          }

          resolveAcquired(true);
          await released;
        },
      )
      .catch(() => {
        requestFailed = true;
        resolveAcquired(false);
      })
      .finally(() => {
        finishRequest();
      });
  } catch {
    requestFailed = true;
    resolveAcquired(false);
    finishRequest();
  }

  const hasLease = await acquired;

  if (!hasLease) {
    await requestFinished;

    if (requestFailed) {
      throw new MicrophoneLeaseError(
        "failed",
        "Výhradní přístup k mikrofonu se nepodařilo ověřit. Zkuste to znovu.",
      );
    }

    throw new MicrophoneLeaseError(
      "busy",
      "Mikrofon už používá jiná karta. Ukončete diktování v ní a zkuste to znovu.",
    );
  }

  let releasedFlag = false;

  return {
    async release() {
      if (releasedFlag) {
        return;
      }

      releasedFlag = true;
      releaseLock();
      await requestFinished;
    },
  };
}

export async function requestScribeToken(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let response: Response;

  try {
    response = await fetchImpl("/api/elevenlabs/scribe-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch {
    throw new MicrophoneSessionError(
      "Token pro diktování se nepodařilo načíst. Zkontrolujte připojení k aplikaci.",
    );
  }

  if (!response.ok) {
    let message = "Token pro diktování se nepodařilo vytvořit.";
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: unknown };
    } | null;

    if (
      typeof body?.error?.message === "string" &&
      body.error.message.trim() !== ""
    ) {
      message = body.error.message;
    }

    throw new MicrophoneSessionError(message);
  }

  const body = (await response.json().catch(() => null)) as unknown;

  if (body === null) {
    throw new MicrophoneSessionError(
      "Server vrátil neplatnou odpověď pro token.",
    );
  }

  const token =
    typeof body === "object" && body !== null
      ? (body as { token?: unknown }).token
      : undefined;

  if (typeof token !== "string" || token.length === 0) {
    throw new MicrophoneSessionError(
      "Server vrátil neplatný token pro diktování.",
    );
  }

  return token;
}

const PERMISSION_ERROR_PATTERNS = [
  "permission denied",
  "permission dismissed",
  "notallowederror",
  "user denied",
  "user dismissed",
  "microphone access denied",
  "microphone permission",
  "access to the microphone",
  "request is not allowed",
  "not allowed by the user agent",
  "přístup k mikrofonu",
  "oprávnění k mikrofonu",
  "oprávnění zamítnuto",
  "přístup zamítnut",
  "uživatel odmítl",
  "uživatel zamítl",
] as const;

const MISSING_DEVICE_ERROR_PATTERNS = [
  "requested device not found",
  "notfounderror",
  "devicesnotfounderror",
  "device not found",
  "no audio input",
  "no microphone",
  "mikrofon nebyl nalezen",
  "žádný mikrofon",
] as const;

const BUSY_DEVICE_ERROR_PATTERNS = [
  "could not start audio source",
  "notreadableerror",
  "trackstarterror",
  "device in use",
  "microphone is busy",
  "microphone in use",
  "mikrofon je používán",
  "mikrofon je obsazen",
] as const;

function includesAny(
  message: string,
  patterns: readonly string[],
): boolean {
  const normalized = message.toLowerCase();

  return patterns.some((pattern) => normalized.includes(pattern));
}

export function toCzechSessionError(error: unknown): string {
  if (
    error instanceof MicrophoneSessionError ||
    error instanceof MicrophoneLeaseError
  ) {
    return error.message;
  }

  const name =
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof (error as { name?: unknown }).name === "string"
      ? (error as { name: string }).name
      : "";
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof error === "object" &&
            error !== null &&
            "message" in error &&
            typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : "";

  if (
    name === "NotAllowedError" ||
    name === "SecurityError" ||
    includesAny(message, PERMISSION_ERROR_PATTERNS)
  ) {
    return "Přístup k mikrofonu byl zamítnut. Povolte jej v nastavení prohlížeče a zkuste to znovu.";
  }

  if (
    name === "NotFoundError" ||
    name === "DevicesNotFoundError" ||
    includesAny(message, MISSING_DEVICE_ERROR_PATTERNS)
  ) {
    return "Mikrofon nebyl nalezen. Připojte mikrofon a zkuste to znovu.";
  }

  if (
    name === "NotReadableError" ||
    name === "TrackStartError" ||
    includesAny(message, BUSY_DEVICE_ERROR_PATTERNS)
  ) {
    return "Mikrofon je právě používán jinou aplikací. Ukončete ji a zkuste to znovu.";
  }

  return "Diktování se nepodařilo spustit. Zkuste to znovu.";
}

export interface MicrophoneSessionControllerOptions {
  readonly requestToken: () => Promise<string>;
  readonly startSession: (token: string, sessionId: number) => Promise<void>;
  readonly stopSession: (sessionId: number) => void | Promise<void>;
  readonly onStateChange?: (state: MicrophoneSessionState) => void;
  readonly locks?: MicrophoneLockManager | null;
  readonly now?: () => number;
  readonly maxDurationMs?: number;
  readonly setTimer?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export class MicrophoneSessionController {
  private state: MicrophoneSessionState = INITIAL_MICROPHONE_SESSION_STATE;
  private lease: MicrophoneLease | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeSessionId: number | null = null;
  private nextSessionId = 0;
  private readonly terminatedSessionIds = new Set<number>();
  private generation = 0;
  private starting = false;
  private finishing = false;

  constructor(
    private readonly options: MicrophoneSessionControllerOptions,
  ) {}

  getState(): MicrophoneSessionState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.starting || this.finishing) {
      return;
    }

    if (this.state.status !== "idle" && this.state.status !== "error") {
      return;
    }

    const generation = ++this.generation;
    this.starting = true;
    this.setState({
      status: "acquiring-lease",
      error: null,
      notice: null,
      startedAt: null,
    });

    try {
      const lease = await acquireMicrophoneLease({
        locks: this.options.locks,
      });

      if (generation !== this.generation) {
        await lease.release();
        return;
      }

      this.lease = lease;
      this.setState({
        status: "requesting-token",
        error: null,
        notice: null,
        startedAt: null,
      });

      const token = await this.options.requestToken();

      if (generation !== this.generation) {
        return;
      }

      const sessionId = ++this.nextSessionId;
      this.activeSessionId = sessionId;
      this.setState({
        status: "connecting",
        error: null,
        notice: null,
        startedAt: null,
      });
      this.armSessionTimer();

      await this.options.startSession(token, sessionId);

      if (this.activeSessionId !== sessionId) {
        const wasTerminated = this.terminatedSessionIds.delete(sessionId);

        if (wasTerminated && this.activeSessionId === null) {
          await Promise.resolve()
            .then(() => this.options.stopSession(sessionId))
            .catch(() => undefined);
        }
      }
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }

      await this.finish("error", toCzechSessionError(error));
    } finally {
      this.starting = false;
    }
  }

  async stop(reason: "user" | "unmount" = "user"): Promise<void> {
    if (
      this.state.status === "idle" &&
      this.lease === null &&
      this.activeSessionId === null
    ) {
      return;
    }

    this.generation += 1;
    await this.finish(reason, null);
  }

  notifyConnected(sessionId: number): void {
    if (sessionId !== this.activeSessionId || this.finishing) {
      return;
    }

    if (this.state.status !== "connecting") {
      return;
    }

    this.setState({
      status: "active",
      error: null,
      notice: null,
      startedAt: this.now(),
    });
    this.armSessionTimer();
  }

  async notifyDisconnected(sessionId: number): Promise<void> {
    if (sessionId !== this.activeSessionId || this.finishing) {
      return;
    }

    await this.finish(
      "connection-lost",
      "Spojení se přerušilo. Pro nové diktování stiskněte Start; předchozí token už nelze použít.",
    );
  }

  async notifyError(sessionId: number, message: string): Promise<void> {
    if (sessionId !== this.activeSessionId || this.finishing) {
      return;
    }

    await this.finish("error", message);
  }

  private get maxDurationMs(): number {
    return this.options.maxDurationMs ?? MICROPHONE_SESSION_MAX_MS;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private setTimer(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> {
    return (
      this.options.setTimer ??
      ((handler, delay) => setTimeout(handler, delay))
    )(callback, delayMs);
  }

  private armSessionTimer(): void {
    if (this.timer !== null) {
      return;
    }

    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.finish(
        "timeout",
        "Časový limit 180 s vypršel. Diktování bylo ukončeno a mikrofon uvolněn.",
      );
    }, this.maxDurationMs);
  }

  private clearTimerHandle(): void {
    if (this.timer === null) {
      return;
    }

    const handle = this.timer;
    this.timer = null;
    (this.options.clearTimer ?? clearTimeout)(handle);
  }

  private async finish(
    reason: MicrophoneStopReason,
    message: string | null,
  ): Promise<void> {
    if (this.finishing) {
      return;
    }

    if (
      this.activeSessionId === null &&
      this.lease === null &&
      this.state.status === "error"
    ) {
      return;
    }

    this.finishing = true;
    const sessionId = this.activeSessionId;
    this.activeSessionId = null;

    if (sessionId !== null) {
      this.terminatedSessionIds.add(sessionId);
    }

    this.clearTimerHandle();
    this.setState({
      status: "stopping",
      error: null,
      notice: null,
      startedAt: this.state.startedAt,
    });

    try {
      if (sessionId !== null) {
        await Promise.resolve()
          .then(() => this.options.stopSession(sessionId))
          .catch(() => undefined);
      }
    } finally {
      await this.releaseLease();
      this.finishing = false;

      if (reason === "unmount") {
        this.setState({
          status: "idle",
          error: null,
          notice: null,
          startedAt: null,
        });
      } else if (reason === "user") {
        this.setState({
          status: "idle",
          error: null,
          notice: "Diktování bylo ukončeno.",
          startedAt: null,
        });
      } else {
        this.setState({
          status: "error",
          error: message,
          notice: null,
          startedAt: null,
        });
      }
    }
  }

  private async releaseLease(): Promise<void> {
    const lease = this.lease;
    this.lease = null;

    if (lease === null) {
      return;
    }

    await lease.release().catch(() => undefined);
  }

  private setState(state: MicrophoneSessionState): void {
    this.state = state;
    this.options.onStateChange?.(state);
  }
}
