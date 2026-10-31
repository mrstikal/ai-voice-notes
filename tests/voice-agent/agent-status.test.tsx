// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentStatus } from "../../src/components/voice-agent/AgentStatus";
import { voiceMetrics } from "../../src/lib/voice-agent/metrics";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

beforeEach(() => {
  voiceMetrics.reset();
});

afterEach(() => {
  cleanup();
  voiceMetrics.reset();
});

describe("P53 AgentStatus", () => {
  it("subscribes to the collector without crashing and separates both modes", () => {
    const session = voiceMetrics.startSession("gemini");
    const turn = voiceMetrics.startTurn("gemini");
    voiceMetrics.markTurnEnd(turn);
    voiceMetrics.markFirstAudio(turn);
    voiceMetrics.recordToolRoundTrip(turn, 25);
    voiceMetrics.finishTurn(turn);
    voiceMetrics.endSession(session, "stop");

    render(<AgentStatus />);

    expect(screen.getByText("Metriky relace")).toBeDefined();
    expect(screen.getByText("Gemini Live")).toBeDefined();
    expect(screen.getByText("Řetězený režim")).toBeDefined();
    expect(screen.getAllByText(/Barge-in/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Tool dispatch \(Gemini\)/)).toBeDefined();
    expect(screen.getAllByText(/shoda nevyhodnocena/).length).toBeGreaterThan(0);
  });
});
