import { describe, expect, it } from "vitest";

import {
  hasAudioDurationCharge,
  hasInputCharacterCharge,
} from "@/lib/ai/usage-format";

describe("usage charge basis", () => {
  it("detects input character charges", () => {
    expect(
      hasInputCharacterCharge({ chargeBasis: "input_characters" }),
    ).toBe(true);
    expect(hasInputCharacterCharge({ chargeBasis: "audio_duration" })).toBe(
      false,
    );
    expect(hasInputCharacterCharge(null)).toBe(false);
  });

  it("detects audio duration charges", () => {
    expect(hasAudioDurationCharge({ chargeBasis: "audio_duration" })).toBe(
      true,
    );
    expect(
      hasAudioDurationCharge({ chargeBasis: "input_characters" }),
    ).toBe(false);
    expect(hasAudioDurationCharge(null)).toBe(false);
  });
});
