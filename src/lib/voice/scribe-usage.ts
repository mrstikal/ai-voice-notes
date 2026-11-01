export const SCRIBE_USAGE_URL = "/api/elevenlabs/scribe-usage";

/**
 * Best-effort settlement of the realtime Scribe reservation. The browser is the
 * only place that knows how long audio was actually streamed, so a failure here
 * leaves the ledger row `unknown` rather than inventing a price.
 */
export function reportScribeAudioUsage(
  usageId: string | null,
  audioSeconds: number,
  fetchImpl: typeof fetch = fetch,
): void {
  if (
    usageId === null ||
    !Number.isFinite(audioSeconds) ||
    audioSeconds <= 0
  ) {
    return;
  }

  try {
    void fetchImpl(SCRIBE_USAGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usageId, audioSeconds }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // The reservation remains `unknown`; no price is fabricated.
  }
}
