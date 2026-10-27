// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LlmSettings } from "../../src/components/settings/LlmSettings";
import {
  estimateStructuredLlmMaxCostUsd,
  LLM_INPUT_MAX_CODE_UNITS,
  type LlmProviderStatus,
} from "../../src/lib/ai/structured";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterEach(cleanup);

const readyStatus: LlmProviderStatus = {
  configured: true,
  model: "deepseek/deepseek-v4.1-flash-1017",
  structuredOutputs: true,
  liveStatus: "verified",
  maxInputCodeUnits: 12_000,
  maxOutputTokens: 1_200,
  timeoutMs: 20_000,
  estimatedMaxCostUsd:
    estimateStructuredLlmMaxCostUsd(LLM_INPUT_MAX_CODE_UNITS),
  checkedAt: "2026-10-27",
  blockedReason: null,
};

describe("LlmSettings", () => {
  it("shows the frozen model, strict schema, bounds, cost and live-unverified status", () => {
    render(<LlmSettings error={null} status={readyStatus} />);

    expect(
      screen.getByText("deepseek/deepseek-v4.1-flash-1017"),
    ).toBeDefined();
    expect(screen.getByText("podporováno kandidátem")).toBeDefined();
    expect(screen.getByText(/12 000 znaků/)).toBeDefined();
    expect(screen.getByText(/1 200 tokenů/)).toBeDefined();
    expect(screen.getByText(/20 s/)).toBeDefined();
    expect(screen.getByText(/ověřená/)).toBeDefined();
    expect(screen.getByText(/2026-10-27/)).toBeDefined();
    expect(
      screen.getByText(/AI úpravy se v této fázi ještě nezobrazují/),
    ).toBeDefined();
  });

  it("shows a clear fail-closed reason for an unsupported model", () => {
    render(
      <LlmSettings
        error={null}
        status={{
          ...readyStatus,
          configured: false,
          structuredOutputs: false,
          blockedReason:
            "Zvolený model není ověřený pro striktní JSON-schema výstup.",
        }}
      />,
    );

    expect(
      screen.getByText(
        "Zvolený model není ověřený pro striktní JSON-schema výstup.",
      ),
    ).toBeDefined();
    expect(screen.queryByText(/Model a serverový klíč jsou připravené/)).toBeNull();
  });
});
