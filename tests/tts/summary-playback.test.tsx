// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SummaryPlayback } from "../../src/components/tts/SummaryPlayback";
import type { SummaryArtifact } from "../../src/lib/ai/summary-types";
import type { TtsProviderStatus } from "../../src/lib/tts/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const artifact: SummaryArtifact = {
  noteId: "11111111-1111-4111-8111-111111111111",
  noteVersion: 2,
  sourceGraphemes: 80,
  summaryText: "Shrnutí: migrace má tři kroky a čeká ji testování.",
};

const providerStatus: TtsProviderStatus = {
  configured: true,
  estimatedMaxCostUsd: 0.14,
  liveStatus: "verified",
  maxInputCodeUnits: 3_500,
  model: "elevenlabs/eleven-v4-turbo",
  responseFormat: "mp3",
  voices: [
    { availability: "available", id: "sarah", label: "Sarah" },
    { availability: "available", id: "george", label: "George" },
  ],
};

function audio() {
  let ended: (() => void) | null = null;
  let failed: (() => void) | null = null;
  const dispose = vi.fn();
  const play = vi.fn(async () => undefined);
  const pause = vi.fn();

  return {
    dispose,
    handle: {
      dispose,
      pause,
      play,
      setOnEnded: (handler: (() => void) | null) => {
        ended = handler;
      },
      setOnError: (handler: (() => void) | null) => {
        failed = handler;
      },
    },
    pause,
    play,
    end: () => ended?.(),
    fail: () => failed?.(),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SummaryPlayback", () => {
  it("requires a fresh consent, sends noteId with the displayed text and stops cleanly", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => {
      return new Response(new Uint8Array([0x49, 0x44, 0x33]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const audioMock = audio();

    render(
      <SummaryPlayback
        artifact={artifact}
        audioFactory={() => audioMock.handle}
        fetchImpl={fetchMock}
        providerStatus={providerStatus}
        voice="sarah"
      />,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("summary-playback").textContent).toContain(
      providerStatus.model,
    );
    expect(screen.getByTestId("summary-playback").textContent).toContain(
      "0,14 USD",
    );
    expect(
      (screen.getByTestId("summary-play") as HTMLButtonElement).disabled,
    ).toBe(true);

    await user.click(screen.getByTestId("summary-consent"));
    await user.click(screen.getByTestId("summary-play"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/tts");
    expect(
      JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)),
    ).toEqual({
      noteId: artifact.noteId,
      text: artifact.summaryText,
      voice: "sarah",
    });
    await waitFor(() => {
      expect(audioMock.play).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole("button", { name: "Zastavit" }));
    expect(audioMock.dispose).toHaveBeenCalled();
  });

  it("does not issue a billable request without consent or with dictation active", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => new Response(new Uint8Array([1]), { status: 200 }));
    const audioMock = audio();

    render(
      <SummaryPlayback
        artifact={artifact}
        audioFactory={() => audioMock.handle}
        fetchImpl={fetchMock}
        providerStatus={{ ...providerStatus, configured: false }}
        voice="sarah"
      />,
    );

    await user.click(screen.getByTestId("summary-consent"));
    expect(
      (screen.getByTestId("summary-play") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
