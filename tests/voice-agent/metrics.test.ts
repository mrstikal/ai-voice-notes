import { describe, expect, it } from "vitest";

import {
  VoiceMetricsCollector,
  formatMetricsMs,
  formatMetricsRange,
} from "../../src/lib/voice-agent/metrics";
import { VOICE_SCENARIOS } from "../fixtures/voice-agent-scenarios";

function collector() {
  let now = 1_000;
  const metrics = new VoiceMetricsCollector({ now: () => now });

  return {
    advance: (ms: number) => {
      now += ms;
    },
    metrics,
  };
}

describe("P53 voice metrics", () => {
  it("separates modes and reports medians, ranges and sample sizes", () => {
    const current = collector();
    const { metrics } = current;
    const geminiSession = metrics.startSession("gemini");
    const chainedSession = metrics.startSession("chained");

    const first = metrics.startTurn("gemini", "read-last-paragraph");
    metrics.markTurnEnd(first);
    current.advance(120);
    metrics.markFirstAudio(first);
    metrics.recordToolRoundTrip(first, 40);
    metrics.recordUsage(first, {
      kind: "reported",
      provider: "gemini",
      usd: 0.01,
    });
    metrics.finishTurn(first);

    const second = metrics.startTurn("gemini", "interrupt-output");
    metrics.markTurnEnd(second);
    current.advance(200);
    metrics.markFirstAudio(second);
    metrics.markBargeIn(second);
    current.advance(15);
    metrics.markOutputSilenced(second);
    metrics.recordError(second, "interrupted_by_user");
    metrics.recordUsage(second, {
      kind: "unknown",
      provider: "gemini",
    });
    metrics.finishTurn(second);

    const chained = metrics.startTurn("chained", "approve-todo-and-undo");
    metrics.markTurnEnd(chained);
    current.advance(350);
    metrics.markFirstAudio(chained);
    metrics.recordToolRoundTrip(chained, 220);
    metrics.recordProposal(chained, "applied");
    metrics.recordUsage(chained, {
      kind: "estimated",
      provider: "openrouter",
      usd: 0.02,
    });
    metrics.finishTurn(chained);

    metrics.recordSelection("gemini", true);
    metrics.recordSelection("chained", false);
    metrics.endSession(geminiSession, "user_stop");
    metrics.endSession(chainedSession, "timeout");

    const snapshot = metrics.getSnapshot();
    const gemini = snapshot.modes.find((mode) => mode.mode === "gemini");
    const chainedMode = snapshot.modes.find((mode) => mode.mode === "chained");

    expect(snapshot.sessions).toHaveLength(2);
    expect(snapshot.sessions.map((session) => session.endReason)).toEqual([
      "user_stop",
      "timeout",
    ]);
    expect(gemini).toMatchObject({
      errors: 1,
      finishedTurns: 2,
      firstAudioMedianMs: 160,
      firstAudioMs: [120, 200],
      firstAudioRangeMs: [120, 200],
      sessions: 1,
      turns: 2,
      usage: { reported: 1, unknown: 1 },
    });
    expect(gemini?.bargeInSilenceMs).toEqual([15]);
    expect(chainedMode).toMatchObject({
      firstAudioMedianMs: 350,
      proposals: { applied: 1 },
      sessions: 1,
      toolRoundTripMedianMs: 220,
      turns: 1,
      usage: { estimated: 1, estimatedUsd: 0.02 },
    });
    expect(gemini?.noteMatches).toBe(1);
    expect(chainedMode?.noteMismatches).toBe(1);
    expect(formatMetricsMs(160)).toBe("160 ms");
    expect(formatMetricsRange([120, 200])).toBe("120–200 ms");
    expect(formatMetricsMs(null)).toBe("—");
  });

  it("keeps the first turn-end timestamp after audio starts", () => {
    const current = collector();
    const { metrics } = current;
    metrics.startSession("gemini");
    const turn = metrics.startTurn("gemini");
    metrics.markTurnEnd(turn);
    current.advance(120);
    metrics.markFirstAudio(turn);
    current.advance(500);
    metrics.markTurnEnd(turn);
    metrics.finishTurn(turn);

    const gemini = metrics
      .getSnapshot()
      .modes.find((mode) => mode.mode === "gemini");
    expect(gemini?.firstAudioMs).toEqual([120]);
  });

  it("records failures and missing usage without fabricating cost or text", () => {
    const { metrics } = collector();
    metrics.startSession("chained");
    const turn = metrics.startTurn("chained", "propose-todo");
    metrics.recordError(turn, "proposal_stale! secret=sk-test");
    metrics.finishTurn(turn);

    const snapshot = metrics.getSnapshot();
    const chained = snapshot.modes.find((mode) => mode.mode === "chained");
    expect(chained?.errors).toBe(1);
    expect(chained?.usage.reported).toBe(0);
    expect(chained?.usage.estimated).toBe(0);
    expect(chained?.usage.unknown).toBe(0);

    const serialized = JSON.stringify(snapshot);
    const records = JSON.stringify(metrics.getTurnRecords());
    expect(records).toContain("proposal_stale");
    expect(records).not.toContain("sk-test");
    expect(records).not.toContain("secret");
    expect(serialized).not.toContain("sk-test");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("tajný přepis");
    expect(serialized).not.toContain("audio");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("otevři");
  });

  it("records session failures separately from successful turns and never reuses ids", () => {
    const { metrics } = collector();
    const session = metrics.startSession("gemini");
    const turn = metrics.startTurn("gemini");
    metrics.markTurnEnd(turn);
    metrics.markFirstAudio(turn);
    metrics.finishTurn(turn);
    metrics.recordSessionError(session, "session_error! secret=sk-test");
    metrics.endSession(session, "error");

    const snapshot = metrics.getSnapshot();
    const gemini = snapshot.modes.find((mode) => mode.mode === "gemini");
    expect(gemini?.errors).toBe(0);
    expect(gemini?.sessionErrors).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain("sk-test");

    metrics.reset();
    const nextSession = metrics.startSession("gemini");
    expect(nextSession).not.toBe(session);
    const nextTurn = metrics.startTurn("gemini");
    expect(nextTurn).not.toBe(turn);
    metrics.endSession(session, "stale");
    expect(
      metrics.getSnapshot().sessions.find((item) => item.mode === "gemini")
        ?.endedAt,
    ).toBeNull();
  });

  it("keeps the fixture scenario names out of the metric payload", () => {
    const { metrics } = collector();
    metrics.startSession("gemini");

    for (const scenario of VOICE_SCENARIOS) {
      const turn = metrics.startTurn(scenario.mode, scenario.id);
      metrics.markTurnEnd(turn);
      metrics.markFirstAudio(turn);
      if (scenario.bargeIn === true) {
        metrics.markBargeIn(turn);
        metrics.markOutputSilenced(turn);
      }
      if (scenario.proposalOutcome !== undefined) {
        metrics.recordProposal(turn, scenario.proposalOutcome);
      }
      metrics.finishTurn(turn);
    }

    const serialized = JSON.stringify(metrics.getSnapshot());
    for (const scenario of VOICE_SCENARIOS) {
      expect(serialized).not.toContain(scenario.utterance);
      expect(serialized).not.toContain(scenario.expectedNoteTitle ?? "__none__");
    }
    expect(serialized).not.toContain("\"text\"");
  });

  it("resets aggregates without touching provider keys or storage", () => {
    const { metrics } = collector();
    metrics.startSession("gemini");
    metrics.startTurn("gemini");
    metrics.recordSelection("gemini", true);
    metrics.reset();

    const snapshot = metrics.getSnapshot();
    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.modes.every((mode) => mode.turns === 0)).toBe(true);
  });
});
