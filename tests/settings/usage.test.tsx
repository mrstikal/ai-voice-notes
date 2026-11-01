// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UsageBudget } from "../../src/components/settings/UsageBudget";
import { UsageSettings } from "../../src/components/settings/UsageSettings";
import type { UsageSummaryDto } from "../../src/lib/ai/usage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const summary: UsageSummaryDto = {
  budgetUsd: "2.000000",
  committedUsd: "0.250000",
  reservedUsd: "0.000000",
  reportedUsd: "0.000000",
  remainingUsd: "1.750000",
  activeCount: 0,
  unknownCount: 1,
  operations: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      operation: "tts",
      provider: "openrouter",
      model: "tts-model",
      status: "unknown",
      reservedCostUsd: "0.250000",
      reportedCostUsd: null,
      providerUsage: { error: "timeout" },
      startedAt: new Date("2026-10-26T09:00:00.000Z"),
      settledAt: new Date("2026-10-26T09:01:00.000Z"),
    },
  ],
};

describe("UsageSettings", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the privacy notice and provider-side limit caveat", () => {
    render(<UsageSettings />);

    expect(
      screen.getByText(/Není to limit na straně poskytovatele/),
    ).toBeDefined();
    expect(screen.getByText(/Bez API klíčů/)).toBeDefined();
    expect(screen.getByText(/Neznámá cena/)).toBeDefined();
  });

  it("shows cost uncertainty and budget values", () => {
    render(<UsageBudget initialError={null} initialSummary={summary} />);

    expect(screen.getAllByText("Neznámá cena").length).toBeGreaterThan(0);
    expect(screen.getByText("2,00 USD")).toBeDefined();
    expect(screen.getByText("1,75 USD")).toBeDefined();
  });

  it("marks a settled ElevenLabs row as priced from audio duration", () => {
    render(
      <UsageBudget
        initialError={null}
        initialSummary={{
          ...summary,
          operations: [
            {
              ...summary.operations[0]!,
              operation: "elevenlabs_scribe_token",
              provider: "elevenlabs",
              model: "scribe_v2_realtime",
              status: "settled",
              reportedCostUsd: "0.004550",
              providerUsage: { chargeBasis: "audio_duration" },
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("0,00455 USD")).toBeDefined();
    expect(screen.getByText("Cena z délky audia")).toBeDefined();
  });

  it("requires the inline confirmation before resetting usage", async () => {
    const user = userEvent.setup();
    const cleared = {
      ...summary,
      committedUsd: "0.000000",
      remainingUsd: "2.000000",
      unknownCount: 0,
      operations: [],
    };
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(cleared), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    render(<UsageBudget initialError={null} initialSummary={summary} />);

    await user.click(
      screen.getByRole("button", { name: "Resetovat evidenci" }),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(
      screen.getByRole("alertdialog", { name: "Opravdu resetovat evidenci?" }),
    ).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Ano, resetovat" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/settings/usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: "reset-usage" }),
      });
    });
    expect(
      await screen.findByText("Evidence využití byla resetována."),
    ).toBeDefined();
  });

  it("disables reset while a reservation is active", () => {
    render(
      <UsageBudget
        initialError={null}
        initialSummary={{ ...summary, activeCount: 1 }}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Resetovat evidenci" }),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByText(
        "Reset není dostupný, dokud je aktivní rezervovaná operace.",
      ),
    ).toBeDefined();
  });
});
