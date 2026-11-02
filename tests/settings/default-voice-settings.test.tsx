// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DefaultVoiceSettings } from "@/components/settings/DefaultVoiceSettings";
import type { TtsProviderStatus } from "@/lib/tts/provider";
import { previewGeminiVoice } from "@/lib/voice-agent/gemini-voice-preview";

vi.mock("@/lib/voice-agent/gemini-voice-preview", () => ({
  previewGeminiVoice: vi.fn(),
}));

const previewMock = vi.mocked(previewGeminiVoice);

const status: TtsProviderStatus = {
  model: "elevenlabs/eleven-v4-turbo",
  responseFormat: "mp3",
  maxInputCodeUnits: 3_500,
  estimatedMaxCostUsd: 0.14,
  configured: true,
  liveStatus: "live_unverified",
  voices: [
    { id: "sarah", label: "Sarah", availability: "available" },
    { id: "george", label: "George", availability: "available" },
    { id: "adam", label: "Adam", availability: "live_unverified" },
  ],
};

class MockAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();

  constructor(readonly src: string) {}
}

class MockAudioContext {
  destination = {};
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  createBuffer = vi.fn(() => ({ copyToChannel: vi.fn() }));
  createBufferSource = vi.fn(() => ({
    buffer: null,
    connect: vi.fn(),
    onended: null,
    start: vi.fn(),
  }));
}

const fetchMock = vi.fn();

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockResolvedValue({
    blob: async () => new Blob(["audio"], { type: "audio/mpeg" }),
    json: async () => ({}),
    ok: true,
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("Audio", MockAudio);
  vi.stubGlobal("AudioContext", MockAudioContext);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:test"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  previewMock.mockResolvedValue({
    pcm: new Uint8Array([0, 0]),
    sampleRate: 24_000,
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function renderSettings() {
  return render(
    <DefaultVoiceSettings
      ttsMaxCostUsd={0.14}
      ttsStatus={status}
      ttsStatusError={null}
    />,
  );
}

describe("DefaultVoiceSettings", () => {
  it("saves the selected TTS and Gemini voices as defaults", () => {
    renderSettings();

    fireEvent.change(screen.getByTestId("default-tts-voice"), {
      target: { value: "george" },
    });
    fireEvent.click(screen.getByTestId("default-tts-save"));

    expect(localStorage.getItem("ai-voice-notes:tts-voice")).toBe("george");
    expect(
      screen.getByText("Výchozí hlas čtení nahlas byl uložen."),
    ).toBeTruthy();

    fireEvent.change(screen.getByTestId("default-gemini-voice"), {
      target: { value: "Puck" },
    });
    fireEvent.click(screen.getByTestId("default-gemini-save"));

    expect(localStorage.getItem("ai-voice-notes:gemini-voice")).toBe("Puck");
    expect(
      screen.getByText("Výchozí hlas konverzace byl uložen."),
    ).toBeTruthy();
  });

  it("plays the TTS test sentence with the selected voice", async () => {
    renderSettings();
    const card = screen
      .getByRole("heading", { name: "Čtení nahlas" })
      .closest("div");

    if (!(card instanceof HTMLElement)) {
      throw new Error("Karta čtení nahlas nebyla nalezena.");
    }

    fireEvent.click(
      within(card).getByLabelText("Potvrzuji placené vyzkoušení hlasu."),
    );
    fireEvent.click(
      within(card).getByRole("button", { name: "Přehrát test" }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/tts");
    expect(JSON.parse(String(init.body))).toEqual({
      text: "Toto je testovací věta pro čtení nahlas.",
      voice: "sarah",
    });
  });

  it("plays the Gemini test sentence with the selected voice", async () => {
    renderSettings();
    const card = screen
      .getByRole("heading", { name: "Hlasová konverzace" })
      .closest("div");

    if (!(card instanceof HTMLElement)) {
      throw new Error("Karta hlasové konverzace nebyla nalezena.");
    }

    fireEvent.click(
      within(card).getByLabelText("Potvrzuji placené vyzkoušení hlasu."),
    );
    fireEvent.click(
      within(card).getByRole("button", { name: "Přehrát test" }),
    );

    await waitFor(() =>
      expect(previewMock).toHaveBeenCalledWith(
        "Aoede",
        "Toto je testovací věta pro hlasovou konverzaci.",
        expect.anything(),
      ),
    );
  });
});
