import { describe, expect, it, vi } from "vitest";

import {
  SCRIBE_USAGE_URL,
  reportScribeAudioUsage,
} from "../../src/lib/voice/scribe-usage";

const USAGE_ID = "11111111-1111-4111-8111-111111111111";

describe("reportScribeAudioUsage", () => {
  it("posts a bounded duration with keepalive so a closing page can settle", () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));

    reportScribeAudioUsage(USAGE_ID, 42.5, fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(SCRIBE_USAGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usageId: USAGE_ID, audioSeconds: 42.5 }),
      keepalive: true,
    });
  });

  it("does not report missing or non-positive durations", () => {
    const fetchMock = vi.fn<typeof fetch>();

    reportScribeAudioUsage(null, 10, fetchMock);
    reportScribeAudioUsage(USAGE_ID, 0, fetchMock);
    reportScribeAudioUsage(USAGE_ID, Number.NaN, fetchMock);
    reportScribeAudioUsage(USAGE_ID, -5, fetchMock);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never lets a failed settlement break the dictation flow", () => {
    const rejected = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("offline"));
    const throwing = vi.fn<typeof fetch>(() => {
      throw new Error("synchronous failure");
    });

    expect(() => reportScribeAudioUsage(USAGE_ID, 10, rejected)).not.toThrow();
    expect(() => reportScribeAudioUsage(USAGE_ID, 10, throwing)).not.toThrow();
  });
});
