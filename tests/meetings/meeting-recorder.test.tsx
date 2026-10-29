// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MeetingRecorder } from "../../src/components/meetings/MeetingRecorder";
import { resetMediaActivityForTests } from "../../src/lib/media/activity";
import { MicrophoneLeaseError } from "../../src/lib/voice/microphone";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const acquireLeaseMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/voice/microphone", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/voice/microphone")>();

  return {
    ...actual,
    acquireMicrophoneLease: acquireLeaseMock,
  };
});

class FakeMediaRecorder {
  static supported = true;
  static isTypeSupported = vi.fn(() => FakeMediaRecorder.supported);
  static instances: FakeMediaRecorder[] = [];

  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly mimeType: string;

  constructor(
    readonly stream: unknown,
    options?: { readonly mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? "";
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    if (this.state === "inactive") {
      return;
    }

    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob(["audio"], { type: "audio/webm;codecs=opus" }),
    });
    this.onstop?.();
  }
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function fakeStream(): MediaStream {
  return {
    getTracks: () => [{ stop: vi.fn() }],
  } as unknown as MediaStream;
}

describe("MeetingRecorder", () => {
  const getUserMedia = vi.fn();
  let release: () => Promise<void>;

  beforeEach(() => {
    resetMediaActivityForTests();
    acquireLeaseMock.mockReset();
    getUserMedia.mockReset();
    FakeMediaRecorder.supported = true;
    FakeMediaRecorder.instances = [];
    release = vi.fn(async () => undefined);
    acquireLeaseMock.mockResolvedValue({ release });
    getUserMedia.mockResolvedValue(fakeStream());
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetMediaActivityForTests();
  });

  it("disables recording with Czech guidance when WebM/Opus is unsupported", async () => {
    FakeMediaRecorder.supported = false;

    render(<MeetingRecorder maxBytes={1_024} maxMinutes={15} />);

    expect(await screen.findByTestId("meeting-unsupported")).toBeDefined();
    expect(
      (screen.getByTestId("meeting-start") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByTestId("meeting-file")).toBeDefined();
  });

  it("records under the exclusive lease and produces an unverified preview", async () => {
    const user = userEvent.setup();

    render(<MeetingRecorder maxBytes={1_024} maxMinutes={15} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("meeting-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    await user.click(screen.getByTestId("meeting-start"));

    await waitFor(() => expect(acquireLeaseMock).toHaveBeenCalledTimes(1));
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(FakeMediaRecorder.instances[0]?.mimeType).toBe(
      "audio/webm;codecs=opus",
    );

    await user.click(screen.getByTestId("meeting-stop"));

    expect(await screen.findByTestId("meeting-preview")).toBeDefined();
    expect(screen.getByTestId("meeting-preview").textContent).toContain(
      "Typ a délka dosud neověřeny",
    );
    expect(screen.getByTestId("meeting-preview").textContent).toContain("5 B");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("cancels a recording without creating a preview", async () => {
    const user = userEvent.setup();

    render(<MeetingRecorder maxBytes={1_024} maxMinutes={15} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("meeting-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    await user.click(screen.getByTestId("meeting-start"));
    await waitFor(() => expect(acquireLeaseMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByTestId("meeting-cancel"));

    await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("meeting-preview")).toBeNull();
    expect(screen.getByText(/Nahrávání bylo zrušeno/u)).toBeDefined();
  });

  it("cancels while the lease is still being acquired without starting capture", async () => {
    const user = userEvent.setup();
    let resolveLease!: (value: { readonly release: () => Promise<void> }) => void;

    acquireLeaseMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLease = resolve;
        }),
    );

    render(<MeetingRecorder maxBytes={1_024} maxMinutes={15} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("meeting-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    await user.click(screen.getByTestId("meeting-start"));
    await user.click(screen.getByTestId("meeting-cancel"));
    resolveLease({ release });
    await waitFor(() => expect(release).toHaveBeenCalledTimes(1));

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(screen.queryByTestId("meeting-preview")).toBeNull();
    expect(screen.getByTestId("meeting-recorder").textContent).toContain(
      "Nahrávání bylo zrušeno. Nic se neodeslalo.",
    );
    expect(
      (screen.getByTestId("meeting-start") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("keeps Start locked while cancelled getUserMedia is still pending", async () => {
    const user = userEvent.setup();
    let resolveStream!: (value: MediaStream) => void;
    const pendingStream = new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    });

    getUserMedia.mockReturnValue(pendingStream);

    render(<MeetingRecorder maxBytes={1_024} maxMinutes={15} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("meeting-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    await user.click(screen.getByTestId("meeting-start"));
    await waitFor(() => expect(acquireLeaseMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByTestId("meeting-cancel"));

    expect(
      (screen.getByTestId("meeting-start") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(acquireLeaseMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("meeting-recorder").textContent).toContain(
      "dialog prohlížeče",
    );

    resolveStream(fakeStream());
    await waitFor(() => expect(release).toHaveBeenCalledTimes(1));

    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("meeting-recorder").textContent).toContain(
      "Nahrávání bylo zrušeno. Nic se neodeslalo.",
    );
    await waitFor(() =>
      expect(
        (screen.getByTestId("meeting-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("starts a new recording after a cancel instead of staying bricked", async () => {
    const user = userEvent.setup();

    render(<MeetingRecorder maxBytes={1_024} maxMinutes={15} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("meeting-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    await user.click(screen.getByTestId("meeting-start"));
    await waitFor(() => expect(acquireLeaseMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByTestId("meeting-cancel"));
    await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        (screen.getByTestId("meeting-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    await user.click(screen.getByTestId("meeting-start"));
    await waitFor(() => expect(acquireLeaseMock).toHaveBeenCalledTimes(2));
    expect(FakeMediaRecorder.instances).toHaveLength(2);

    await user.click(screen.getByTestId("meeting-stop"));

    expect(await screen.findByTestId("meeting-preview")).toBeDefined();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("disables replacing the file while an inspection is in flight", async () => {
    const user = userEvent.setup();
    let resolveFetch!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn(() => pending);

    vi.stubGlobal("fetch", fetchMock);

    render(<MeetingRecorder maxBytes={1_024} maxMinutes={15} />);

    fireEvent.change(screen.getByTestId("meeting-file"), {
      target: {
        files: [new File(["abc"], "prvni.webm", { type: "audio/webm" })],
      },
    });

    await user.click(screen.getByTestId("meeting-inspect"));

    expect(
      (screen.getByTestId("meeting-file") as HTMLInputElement).disabled,
    ).toBe(true);

    resolveFetch(
      response({
        bytes: 3,
        format: "wav",
        codec: "pcm_s16le",
        durationSeconds: 1,
        inspection: "validated",
        message: "Typ a délka ověřeny",
      }),
    );

    expect(await screen.findByTestId("meeting-inspected")).toBeDefined();
    expect(
      (screen.getByTestId("meeting-file") as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it("reports a second tab holding the microphone lease without starting capture", async () => {
    const user = userEvent.setup();

    acquireLeaseMock.mockRejectedValue(
      new MicrophoneLeaseError(
        "busy",
        "Mikrofon už používá jiná karta. Ukončete diktování v ní a zkuste to znovu.",
      ),
    );

    render(<MeetingRecorder maxBytes={1_024} maxMinutes={15} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("meeting-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    await user.click(screen.getByTestId("meeting-start"));

    expect((await screen.findByTestId("meeting-error")).textContent).toContain(
      "jiná karta",
    );
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("previews and inspects a local file without auto-uploading", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();

    fetchMock.mockImplementation(async () =>
      response({
        bytes: 3,
        format: "wav",
        codec: "pcm_s16le",
        durationSeconds: 1,
        inspection: "validated",
        message: "Typ a délka ověřeny",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<MeetingRecorder maxBytes={1_024} maxMinutes={15} />);

    fireEvent.change(screen.getByTestId("meeting-file"), {
      target: {
        files: [new File(["abc"], "schuzka.webm", { type: "audio/webm" })],
      },
    });

    expect(await screen.findByTestId("meeting-preview")).toBeDefined();
    expect(screen.getByTestId("meeting-preview").textContent).toContain(
      "schuzka.webm",
    );
    expect(screen.getByTestId("meeting-preview").textContent).toContain(
      "Typ a délka dosud neověřeny",
    );
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("meeting-inspect"));

    expect(await screen.findByTestId("meeting-inspected")).toBeDefined();
    expect(screen.getByTestId("meeting-inspected").textContent).toContain(
      "WAV",
    );
    expect(screen.getByTestId("meeting-inspected").textContent).toContain(
      "3 B",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;

    expect(url).toBe("/api/meetings/inspect");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "content-type": "application/octet-stream",
    });
    expect(init?.body).toBeInstanceOf(Blob);
  });

  it("reports an automatic stop after the meeting time limit", async () => {
    vi.useFakeTimers();
    render(<MeetingRecorder maxBytes={1_024} maxMinutes={15} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByTestId("meeting-start"));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(FakeMediaRecorder.instances).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(15 * 60 * 1_000);
    });

    expect(screen.getByTestId("meeting-preview")).toBeDefined();
    expect(screen.getByTestId("meeting-recorder").textContent).toContain(
      "automaticky zastaveno",
    );
    vi.useRealTimers();
  });

  it("rejects an oversized local file before any request", async () => {
    render(<MeetingRecorder maxBytes={4} maxMinutes={15} />);

    fireEvent.change(screen.getByTestId("meeting-file"), {
      target: {
        files: [new File(["12345"], "velke.webm", { type: "audio/webm" })],
      },
    });

    expect(await screen.findByTestId("meeting-error")).toBeDefined();
    expect(screen.getByTestId("meeting-error").textContent).toContain(
      "limit",
    );
    expect(screen.queryByTestId("meeting-preview")).toBeNull();
  });
});
