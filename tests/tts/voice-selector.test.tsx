// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { VoiceSelector } from "@/components/tts/VoiceSelector";
import { TTS_VOICES, getTtsProviderStatus } from "@/lib/tts/provider";

afterEach(cleanup);

describe("VoiceSelector", () => {
  it("shows every documented voice, not only the verified ones", () => {
    const status = getTtsProviderStatus({ configured: true });

    render(
      <VoiceSelector
        status={status}
        value="sarah"
        onChange={() => undefined}
      />,
    );

    const select = screen.getByTestId("tts-voice") as HTMLSelectElement;

    expect(select.options).toHaveLength(TTS_VOICES.length);
    expect(Array.from(select.options).map((option) => option.value)).toEqual(
      TTS_VOICES.map((voice) => voice.id),
    );
    expect(select.options[0]?.textContent).toContain("Sarah");
    expect(select.options[2]?.textContent).toContain("Adam");
    expect(select.options[2]?.textContent).toContain("neověřený v provozu");
  });
});
