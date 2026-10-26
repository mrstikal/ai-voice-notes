// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  CommitStrategy,
  type ScribeHookOptions,
  type ScribeStatus,
  type TranscriptSegment,
  type UseScribeReturn,
} from "@elevenlabs/react";
import { useEffect, useState } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import {
  ScribeDiagnostic,
  ScribeDiagnosticView,
} from "../../src/components/voice/ScribeDiagnostic";
import { createFakeLockManager } from "../helpers/provider-mocks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const useScribeMock = vi.hoisted(() => vi.fn());

vi.mock("@elevenlabs/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elevenlabs/react")>();

  return { ...actual, useScribe: useScribeMock };
});

interface MockScribeInstance {
  options: ScribeHookOptions | null;
  readonly connect: Mock<UseScribeReturn["connect"]>;
  readonly disconnect: Mock<UseScribeReturn["disconnect"]>;
  readonly clearTranscripts: Mock<UseScribeReturn["clearTranscripts"]>;
  readonly emitPartial: (text: string) => void;
  readonly emitCommitted: (text: string, id?: string) => void;
  readonly emitDisconnect: () => void;
  readonly emitError: (error: Error | Event) => void;
}

const scribeInstances: MockScribeInstance[] = [];

function createMockScribeInstance(
  setStatus: (status: ScribeStatus) => void,
  setPartialTranscript: (text: string) => void,
  setCommittedTranscripts: (
    update: (current: TranscriptSegment[]) => TranscriptSegment[],
  ) => void,
  setProviderError: (error: string | null) => void,
): MockScribeInstance {
  const instance: MockScribeInstance = {
    options: null,
    connect: vi.fn<UseScribeReturn["connect"]>(async () => {
      setStatus("connecting");
      setProviderError(null);
      instance.options?.onSessionStarted?.();
      setStatus("connected");
    }),
    disconnect: vi.fn<UseScribeReturn["disconnect"]>(() => {
      setStatus("disconnected");
      instance.options?.onDisconnect?.();
    }),
    clearTranscripts: vi.fn<UseScribeReturn["clearTranscripts"]>(() => {
      setPartialTranscript("");
      setCommittedTranscripts(() => []);
    }),
    emitPartial: (text) => {
      setPartialTranscript(text);
    },
    emitCommitted: (text, id = "segment-1") => {
      setCommittedTranscripts((current) => [
        ...current,
        {
          id,
          text,
          timestamp: Date.now(),
          isFinal: true,
        },
      ]);
    },
    emitDisconnect: () => {
      instance.options?.onDisconnect?.();
    },
    emitError: (error) => {
      setProviderError(
        error instanceof Error ? error.message : "Neznámá chyba poskytovatele.",
      );
      instance.options?.onError?.(error);
    },
  };

  return instance;
}

function useMockScribe(options: ScribeHookOptions): UseScribeReturn {
  const [status, setStatus] = useState<ScribeStatus>("disconnected");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [committedTranscripts, setCommittedTranscripts] = useState<
    TranscriptSegment[]
  >([]);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [instanceIndex] = useState(() => {
    scribeInstances.push(
      createMockScribeInstance(
        setStatus,
        setPartialTranscript,
        setCommittedTranscripts,
        setProviderError,
      ),
    );
    return scribeInstances.length - 1;
  });
  const instance = scribeInstances[instanceIndex]!;

  useEffect(() => {
    instance.options = options;
  }, [instance, options]);

  return {
    status,
    isConnected: status === "connected" || status === "transcribing",
    isTranscribing: status === "transcribing",
    isMuted: false,
    partialTranscript,
    committedTranscripts,
    error: providerError,
    connect: instance.connect,
    disconnect: instance.disconnect,
    mute: vi.fn(),
    unmute: vi.fn(),
    sendAudio: vi.fn(),
    commit: vi.fn(),
    clearTranscripts: instance.clearTranscripts,
    getConnection: () => null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const originalLocksDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "locks",
);

let fetchMock: ReturnType<typeof vi.fn>;
let locks: ReturnType<typeof createFakeLockManager>;
let tokenCounter = 0;

beforeEach(() => {
  scribeInstances.length = 0;
  tokenCounter = 0;
  useScribeMock.mockImplementation((options: ScribeHookOptions) =>
    useMockScribe(options),
  );
  locks = createFakeLockManager();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks,
  });
  fetchMock = vi.fn().mockImplementation(async () => {
    tokenCounter += 1;
    return jsonResponse({ token: `sutkn_diagnostic_${tokenCounter}` });
  });
  vi.stubGlobal("fetch", fetchMock);
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();

  if (originalLocksDescriptor) {
    Object.defineProperty(navigator, "locks", originalLocksDescriptor);
  } else {
    delete (navigator as { locks?: unknown }).locks;
  }
});

function renderView(overrides: {
  partialTranscript?: string;
  committedTranscripts?: readonly { id: string; text: string }[];
  status?: "idle" | "active" | "error";
  error?: string | null;
  providerError?: string | null;
  webLocksSupported?: boolean | null;
}) {
  return render(
    <ScribeDiagnosticView
      status={overrides.status ?? "idle"}
      providerStatus={overrides.status === "active" ? "transcribing" : "disconnected"}
      error={overrides.error ?? null}
      providerError={overrides.providerError ?? null}
      notice={null}
      partialTranscript={overrides.partialTranscript ?? ""}
      committedTranscripts={overrides.committedTranscripts ?? []}
      webLocksSupported={overrides.webLocksSupported ?? true}
      onStart={() => undefined}
      onStop={() => undefined}
    />,
  );
}

describe("ScribeDiagnosticView", () => {
  it("replaces partial text and keeps committed segments stable without persisting", () => {
    const { rerender } = renderView({
      partialTranscript: "Ahoj",
      committedTranscripts: [{ id: "segment-1", text: "První věta." }],
      status: "active",
    });

    expect(screen.getByTestId("partial-transcript").textContent).toBe("Ahoj");
    expect(screen.getByTestId("committed-transcript").textContent).toBe(
      "První věta.",
    );

    rerender(
      <ScribeDiagnosticView
        status="active"
        providerStatus="transcribing"
        error={null}
        providerError={null}
        notice={null}
        partialTranscript="Ahoj světe"
        committedTranscripts={[{ id: "segment-1", text: "První věta." }]}
        webLocksSupported
        onStart={() => undefined}
        onStop={() => undefined}
      />,
    );

    expect(screen.getByTestId("partial-transcript").textContent).toBe(
      "Ahoj světe",
    );
    expect(screen.queryByText("Ahoj", { exact: true })).toBeNull();
    expect(screen.getAllByTestId("committed-transcript")).toHaveLength(1);
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it("disables Start with Czech guidance when Web Locks are unavailable", () => {
    renderView({ webLocksSupported: false });
    const start = screen.getByRole("button", {
      name: "Start diktování",
    }) as HTMLButtonElement;

    expect(start.disabled).toBe(true);
    expect(screen.getByText(/Web Locks/u)).toBeTruthy();
  });

  it("discloses the provider, model, duration and uncertain cost before Start", () => {
    renderView({});

    expect(document.body.textContent).toContain("scribe_v2_realtime");
    expect(document.body.textContent).toContain("180 s");
    expect(document.body.textContent).toContain("0,0195");
    expect(document.body.textContent).toContain(
      "skutečná cena může být neznámá",
    );
  });

  it("keeps the Czech summary primary and exposes the provider detail separately", () => {
    renderView({
      status: "error",
      error: "Přepisovač ElevenLabs hlásí chybu. Zkuste to znovu.",
      providerError: "transcriber_error",
    });

    expect(
      screen.getByText("Přepisovač ElevenLabs hlásí chybu. Zkuste to znovu."),
    ).toBeTruthy();
    expect(
      screen.getByText("Technický detail od poskytovatele"),
    ).toBeTruthy();
    expect(screen.getByText("transcriber_error")).toBeTruthy();
  });
});

describe("ScribeDiagnostic", () => {
  it("uses a fresh P13 token for each Start and the documented Czech options", async () => {
    const { container } = render(<ScribeDiagnostic />);
    const start = within(container).getByRole("button", {
      name: "Start diktování",
    }) as HTMLButtonElement;

    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() =>
      expect(scribeInstances[0]?.connect).toHaveBeenCalledTimes(1),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/elevenlabs/scribe-token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(scribeInstances[0]?.connect).toHaveBeenCalledWith({
      token: "sutkn_diagnostic_1",
    });
    const options = scribeInstances[0]?.options;
    expect(options?.modelId).toBe("scribe_v2_realtime");
    expect(options?.languageCode).toBe("cs");
    expect(options?.commitStrategy).toBe(CommitStrategy.VAD);
    expect(options?.vadSilenceThresholdSecs).toBe(1.2);
    expect(options?.microphone).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });

    const stop = within(container).getByRole("button", {
      name: "Stop",
    }) as HTMLButtonElement;
    await waitFor(() => expect(stop.disabled).toBe(false));
    fireEvent.click(stop);
    await waitFor(() =>
      expect(scribeInstances[0]?.disconnect).toHaveBeenCalledTimes(1),
    );

    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(scribeInstances[0]?.connect).toHaveBeenCalledTimes(2);
    expect(scribeInstances[0]?.connect).toHaveBeenNthCalledWith(2, {
      token: "sutkn_diagnostic_2",
    });
  });

  it("shows replaceable partials and committed segments without persistence", async () => {
    const { container } = render(<ScribeDiagnostic />);
    const start = within(container).getByRole("button", {
      name: "Start diktování",
    }) as HTMLButtonElement;

    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() =>
      expect(scribeInstances[0]?.connect).toHaveBeenCalledTimes(1),
    );

    act(() => {
      scribeInstances[0]?.emitPartial("Ahoj");
    });
    expect(within(container).getByTestId("partial-transcript").textContent).toBe(
      "Ahoj",
    );

    act(() => {
      scribeInstances[0]?.emitPartial("Ahoj světe");
    });
    expect(within(container).getByTestId("partial-transcript").textContent).toBe(
      "Ahoj světe",
    );
    expect(within(container).queryByText("Ahoj", { exact: true })).toBeNull();

    act(() => {
      scribeInstances[0]?.emitCommitted("První věta.", "segment-1");
      scribeInstances[0]?.emitCommitted("Druhá věta.", "segment-2");
    });
    expect(
      within(container).getAllByTestId("committed-transcript"),
    ).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it("requires a new token and a new user Start after a lost connection", async () => {
    const { container } = render(<ScribeDiagnostic />);
    const start = within(container).getByRole("button", {
      name: "Start diktování",
    }) as HTMLButtonElement;

    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() =>
      expect(scribeInstances[0]?.connect).toHaveBeenCalledTimes(1),
    );

    act(() => {
      scribeInstances[0]?.emitDisconnect();
    });

    await waitFor(() =>
      expect(within(container).getByText(/Spojení se přerušilo/u)).toBeTruthy(),
    );
    expect(scribeInstances[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessionStorage.length).toBe(0);

    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(scribeInstances[0]?.connect).toHaveBeenCalledTimes(2);
    expect(scribeInstances[0]?.connect).toHaveBeenNthCalledWith(2, {
      token: "sutkn_diagnostic_2",
    });
  });

  it("shows Czech permission guidance for the SDK's normalized error", async () => {
    const { container } = render(<ScribeDiagnostic />);
    const start = within(container).getByRole("button", {
      name: "Start diktování",
    }) as HTMLButtonElement;

    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() =>
      expect(scribeInstances[0]?.connect).toHaveBeenCalledTimes(1),
    );

    act(() => {
      scribeInstances[0]?.emitError(new Error("Permission denied"));
    });

    await waitFor(() =>
      expect(
        within(container).getByText(/Přístup k mikrofonu byl zamítnut/u),
      ).toBeTruthy(),
    );
    expect(within(container).getByText("Permission denied")).toBeTruthy();
    expect(locks.heldNames.size).toBe(0);
  });

  it("maps a provider-specific error callback to distinct Czech guidance", async () => {
    const { container } = render(<ScribeDiagnostic />);
    const start = within(container).getByRole("button", {
      name: "Start diktování",
    }) as HTMLButtonElement;

    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() =>
      expect(scribeInstances[0]?.connect).toHaveBeenCalledTimes(1),
    );

    act(() => {
      scribeInstances[0]?.options?.onResourceExhaustedError?.({
        error: "resource_exhausted",
      });
    });

    await waitFor(() =>
      expect(
        within(container).getByText(/Prostředky ElevenLabs jsou vyčerpané/u),
      ).toBeTruthy(),
    );
    expect(locks.heldNames.size).toBe(0);
  });

  it("releases the microphone lease on unmount", async () => {
    const { container, unmount } = render(<ScribeDiagnostic />);
    const start = within(container).getByRole("button", {
      name: "Start diktování",
    }) as HTMLButtonElement;

    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() =>
      expect(scribeInstances[0]?.connect).toHaveBeenCalledTimes(1),
    );
    expect(locks.heldNames.size).toBe(1);

    unmount();

    await waitFor(() =>
      expect(scribeInstances[0]?.disconnect).toHaveBeenCalledTimes(1),
    );
    expect(locks.heldNames.size).toBe(0);
  });

  it("prevents two tabs from owning the microphone at once", async () => {
    const first = render(<ScribeDiagnostic />);
    const second = render(<ScribeDiagnostic />);
    const firstStart = within(first.container).getByRole("button", {
      name: "Start diktování",
    }) as HTMLButtonElement;
    const secondStart = within(second.container).getByRole("button", {
      name: "Start diktování",
    }) as HTMLButtonElement;

    await waitFor(() => expect(firstStart.disabled).toBe(false));
    await waitFor(() => expect(secondStart.disabled).toBe(false));

    fireEvent.click(firstStart);
    await waitFor(() =>
      expect(scribeInstances[0]?.connect).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(secondStart);
    await waitFor(() =>
      expect(within(second.container).getByText(/jiná karta/u)).toBeTruthy(),
    );
    expect(scribeInstances[1]?.connect).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const firstStop = within(first.container).getByRole("button", {
      name: "Stop",
    }) as HTMLButtonElement;
    fireEvent.click(firstStop);
    await waitFor(() => expect(firstStop.disabled).toBe(true));

    fireEvent.click(secondStart);
    await waitFor(() =>
      expect(scribeInstances[1]?.connect).toHaveBeenCalledTimes(1),
    );
    expect(scribeInstances[1]?.connect).toHaveBeenCalledWith({
      token: "sutkn_diagnostic_2",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps Start disabled when the browser lacks Web Locks", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
    const { container } = render(<ScribeDiagnostic />);

    await waitFor(() =>
      expect(within(container).getByText(/Web Locks/u)).toBeTruthy(),
    );
    const start = within(container).getByRole("button", {
      name: "Start diktování",
    }) as HTMLButtonElement;

    expect(start.disabled).toBe(true);
    fireEvent.click(start);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(scribeInstances[0]?.connect).not.toHaveBeenCalled();
  });
});
