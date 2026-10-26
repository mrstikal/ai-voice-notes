import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MICROPHONE_LOCK_NAME,
  MICROPHONE_SESSION_MAX_MS,
  MicrophoneSessionController,
  MicrophoneSessionError,
  acquireMicrophoneLease,
  isWebLocksSupported,
  requestScribeToken,
  toCzechSessionError,
  type MicrophoneLockManager,
  type MicrophoneSessionState,
} from "../../src/lib/voice/microphone";
import { createFakeLockManager } from "../helpers/provider-mocks";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createController(
  overrides: Partial<ConstructorParameters<typeof MicrophoneSessionController>[0]> = {},
) {
  const fallbackLocks = createFakeLockManager();
  const effectiveLocks =
    overrides.locks === undefined ? fallbackLocks : overrides.locks;
  const locks = (effectiveLocks ?? fallbackLocks) as ReturnType<
    typeof createFakeLockManager
  >;
  const events: string[] = [];
  const requestToken = vi.fn(async () => {
    events.push(
      locks.heldNames.has(MICROPHONE_LOCK_NAME)
        ? "token-with-lease"
        : "token-without-lease",
    );
    return "sutkn_controller_token";
  });
  const startSession = vi.fn(async () => {
    events.push("start");
  });
  const stopSession = vi.fn(async () => {
    events.push("stop");
  });
  const states: MicrophoneSessionState[] = [];
  const controller = new MicrophoneSessionController({
    locks: effectiveLocks,
    requestToken,
    startSession,
    stopSession,
    onStateChange: (state) => states.push(state),
    ...overrides,
  });

  return {
    controller,
    locks,
    events,
    states,
    requestToken,
    startSession,
    stopSession,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("microphone lease", () => {
  it("allows only one tab to hold the microphone lock at a time", async () => {
    const locks = createFakeLockManager();
    const first = await acquireMicrophoneLease({ locks });

    expect(locks.heldNames.has(MICROPHONE_LOCK_NAME)).toBe(true);
    await expect(acquireMicrophoneLease({ locks })).rejects.toMatchObject({
      code: "busy",
    });

    await first.release();
    expect(locks.heldNames.size).toBe(0);

    const second = await acquireMicrophoneLease({ locks });
    await second.release();
  });

  it("reports unavailable Web Locks instead of risking hidden recording", async () => {
    expect(isWebLocksSupported(null)).toBe(false);
    await expect(
      acquireMicrophoneLease({ locks: null }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("reports a failed lock manager instead of treating it as a busy tab", async () => {
    const failingLocks: MicrophoneLockManager = {
      async request() {
        throw new Error("lock failure");
      },
    };

    await expect(
      acquireMicrophoneLease({ locks: failingLocks }),
    ).rejects.toMatchObject({ code: "failed" });
  });
});

describe("microphone session controller", () => {
  it("acquires the lease before requesting a token and starting the session", async () => {
    const { controller, locks, events, requestToken, startSession } =
      createController();

    await controller.start();

    expect(events).toEqual(["token-with-lease", "start"]);
    expect(requestToken).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledWith("sutkn_controller_token", 1);
    expect(controller.getState().status).toBe("connecting");
    expect(locks.heldNames.has(MICROPHONE_LOCK_NAME)).toBe(true);

    await controller.stop("user");
    expect(locks.heldNames.size).toBe(0);
  });

  it("disables Start with Czech guidance when Web Locks are unavailable", async () => {
    const { controller, requestToken, startSession } = createController({
      locks: null,
    });

    await controller.start();

    expect(controller.getState()).toMatchObject({
      status: "error",
      error: expect.stringMatching(/Web Locks/u),
    });
    expect(requestToken).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });

  it("refuses a second tab while another lease is held", async () => {
    const locks = createFakeLockManager();
    const heldLease = await acquireMicrophoneLease({ locks });
    const { controller, requestToken, startSession } = createController({
      locks,
    });

    await controller.start();

    expect(controller.getState()).toMatchObject({
      status: "error",
      error: expect.stringMatching(/jiná karta/u),
    });
    expect(requestToken).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();

    await heldLease.release();
  });

  it("closes the session and releases the lease after 180 seconds", async () => {
    vi.useFakeTimers();
    const { controller, locks, stopSession, states } = createController();

    await controller.start();
    controller.notifyConnected(1);
    expect(controller.getState().status).toBe("active");
    expect(states.some((state) => state.status === "active")).toBe(true);

    await vi.advanceTimersByTimeAsync(MICROPHONE_SESSION_MAX_MS);
    await Promise.resolve();

    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(locks.heldNames.size).toBe(0);
    expect(controller.getState()).toMatchObject({
      status: "error",
      error: expect.stringMatching(/180/u),
    });
  });

  it("bounds a provider that never confirms session_started", async () => {
    vi.useFakeTimers();
    const { controller, locks, stopSession } = createController();

    await controller.start();
    expect(controller.getState().status).toBe("connecting");

    await vi.advanceTimersByTimeAsync(MICROPHONE_SESSION_MAX_MS);
    await Promise.resolve();

    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(locks.heldNames.size).toBe(0);
    expect(controller.getState()).toMatchObject({
      status: "error",
      error: expect.stringMatching(/180/u),
    });
  });

  it("closes a session whose start resolves after it was terminated", async () => {
    let resolveStart!: () => void;
    const startSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const { controller, locks, stopSession } = createController({
      startSession,
    });

    const starting = controller.start();
    await vi.waitFor(() =>
      expect(startSession).toHaveBeenCalledTimes(1),
    );
    await controller.notifyDisconnected(1);
    expect(stopSession).toHaveBeenCalledTimes(1);

    resolveStart();
    await starting;

    expect(stopSession).toHaveBeenCalledTimes(2);
    expect(locks.heldNames.size).toBe(0);
  });

  it("requires a new token and a new user Start after a lost connection", async () => {
    const { controller, locks, requestToken, startSession, stopSession } =
      createController();

    await controller.start();
    controller.notifyConnected(1);
    await controller.notifyDisconnected(1);

    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(locks.heldNames.size).toBe(0);
    expect(controller.getState()).toMatchObject({
      status: "error",
      error: expect.stringMatching(/Spojení/u),
    });

    await controller.start();

    expect(requestToken).toHaveBeenCalledTimes(2);
    expect(startSession).toHaveBeenCalledTimes(2);
    expect(controller.getState().status).toBe("connecting");

    await controller.stop("user");
  });

  it("releases tracks and the lease on Stop and unmount", async () => {
    const { controller, locks, stopSession } = createController();

    await controller.start();
    controller.notifyConnected(1);
    await controller.stop("user");

    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(locks.heldNames.size).toBe(0);
    expect(controller.getState()).toMatchObject({
      status: "idle",
      notice: "Diktování bylo ukončeno.",
    });

    await controller.start();
    controller.notifyConnected(2);
    await controller.stop("unmount");

    expect(stopSession).toHaveBeenCalledTimes(2);
    expect(locks.heldNames.size).toBe(0);
    expect(controller.getState()).toMatchObject({
      status: "idle",
      notice: null,
    });
  });

  it("releases the lease when the token request fails", async () => {
    const locks = createFakeLockManager();
    const controller = new MicrophoneSessionController({
      locks,
      requestToken: async () => {
        throw new MicrophoneSessionError(
          "Token pro diktování se nepodařilo vytvořit.",
        );
      },
      startSession: vi.fn(),
      stopSession: vi.fn(),
    });

    await controller.start();

    expect(locks.heldNames.size).toBe(0);
    expect(controller.getState()).toMatchObject({
      status: "error",
      error: "Token pro diktování se nepodařilo vytvořit.",
    });
  });

  it("maps the SDK's normalized microphone permission error to Czech guidance", async () => {
    const { controller, locks } = createController({
      startSession: async () => {
        throw new Error("Permission denied");
      },
    });

    await controller.start();

    expect(locks.heldNames.size).toBe(0);
    expect(controller.getState()).toMatchObject({
      status: "error",
      error: expect.stringMatching(/zamítnut/u),
    });
  });
});

describe("Scribe token request", () => {
  it("posts an empty JSON object and returns the short-lived token", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ token: "sutkn_fetch_token" }));

    await expect(requestScribeToken(fetchMock)).resolves.toBe(
      "sutkn_fetch_token",
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/elevenlabs/scribe-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  });

  it("keeps the server's actionable Czech error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "elevenlabs_not_configured",
            message: "ElevenLabs není nakonfigurovaný.",
          },
        },
        503,
      ),
    );

    await expect(requestScribeToken(fetchMock)).rejects.toThrow(
      "ElevenLabs není nakonfigurovaný.",
    );
  });

  it("rejects an empty or malformed token response", async () => {
    const emptyToken = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ token: "" }));
    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("not-json", { status: 200 }));

    await expect(requestScribeToken(emptyToken)).rejects.toThrow(
      /neplatný token/u,
    );
    await expect(requestScribeToken(malformed)).rejects.toThrow(
      /neplatnou odpověď/u,
    );
  });

  it("maps normalized SDK messages and keeps unknown failures Czech", () => {
    expect(toCzechSessionError(new Error("Permission denied"))).toBe(
      "Přístup k mikrofonu byl zamítnut. Povolte jej v nastavení prohlížeče a zkuste to znovu.",
    );
    expect(toCzechSessionError(new Error("Requested device not found"))).toBe(
      "Mikrofon nebyl nalezen. Připojte mikrofon a zkuste to znovu.",
    );
    expect(
      toCzechSessionError(new Error("Could not start audio source")),
    ).toBe(
      "Mikrofon je právě používán jinou aplikací. Ukončete ji a zkuste to znovu.",
    );
    expect(toCzechSessionError(new Error("unexpected provider failure"))).toBe(
      "Diktování se nepodařilo spustit. Zkuste to znovu.",
    );
  });
});
