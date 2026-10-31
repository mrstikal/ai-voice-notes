export type VoiceMode = "gemini" | "chained";

export type UsageKind = "reported" | "estimated" | "unknown";

export type ProposalMetricOutcome =
  | "pending"
  | "rejected"
  | "applied"
  | "undo"
  | "failed";

export interface UsageObservation {
  readonly provider: string;
  readonly kind: UsageKind;
  readonly usd?: number;
}

export interface TurnRecord {
  readonly mode: VoiceMode;
  readonly scenario: string | null;
  readonly turnEndedAt: number | null;
  readonly firstAudioAt: number | null;
  readonly bargeInAt: number | null;
  readonly silencedAt: number | null;
  readonly toolRoundTripMs: number | null;
  readonly toolRoundTripsMs: readonly number[];
  readonly errorCode: string | null;
  readonly usage: readonly UsageObservation[];
  readonly proposalOutcome: ProposalMetricOutcome | null;
  readonly finishedAt: number | null;
}

interface DraftTurn {
  readonly id: number;
  readonly mode: VoiceMode;
  readonly scenario: string | null;
  turnEndedAt: number | null;
  firstAudioAt: number | null;
  bargeInAt: number | null;
  silencedAt: number | null;
  toolRoundTripMs: number | null;
  toolRoundTripsMs: number[];
  errorCode: string | null;
  usage: readonly UsageObservation[];
  proposalOutcome: ProposalMetricOutcome | null;
  finishedAt: number | null;
}

export interface ModeSummary {
  readonly mode: VoiceMode;
  readonly sessions: number;
  readonly sessionErrors: number;
  readonly turns: number;
  readonly finishedTurns: number;
  readonly errors: number;
  readonly firstAudioMs: readonly number[];
  readonly firstAudioMedianMs: number | null;
  readonly firstAudioRangeMs: readonly [number, number] | null;
  readonly bargeInSilenceMs: readonly number[];
  readonly bargeInSilenceMedianMs: number | null;
  readonly bargeInSilenceRangeMs: readonly [number, number] | null;
  readonly toolRoundTripMs: readonly number[];
  readonly toolRoundTripMedianMs: number | null;
  readonly toolRoundTripRangeMs: readonly [number, number] | null;
  readonly usage: {
    readonly reported: number;
    readonly estimated: number;
    readonly unknown: number;
    readonly reportedUsd: number;
    readonly estimatedUsd: number;
  };
  readonly selections: number;
  readonly noteMatches: number;
  readonly noteMismatches: number;
  readonly proposals: Readonly<Record<ProposalMetricOutcome, number>>;
}

export interface MetricsSnapshot {
  readonly sessions: readonly {
    readonly mode: VoiceMode;
    readonly startedAt: number;
    readonly endedAt: number | null;
    readonly endReason: string | null;
    errorCode: string | null;
  }[];
  readonly modes: readonly ModeSummary[];
  readonly generatedAt: number;
}

export interface VoiceMetricsOptions {
  readonly now?: () => number;
}

const MODES: readonly VoiceMode[] = ["gemini", "chained"];
const PROPOSAL_OUTCOMES: readonly ProposalMetricOutcome[] = [
  "pending",
  "rejected",
  "applied",
  "undo",
  "failed",
];

function sanitizeLabel(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const cleaned = value.replace(/[\r\n]+/gu, " ").trim().slice(0, 80);

  return cleaned === "" ? null : cleaned;
}

function sanitizeCode(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const token = value.split(/[^a-zA-Z0-9_.-]/u)[0]?.slice(0, 80) ?? "";

  return token === "" ? null : token;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function range(
  values: readonly number[],
): readonly [number, number] | null {
  if (values.length === 0) {
    return null;
  }

  return [Math.min(...values), Math.max(...values)];
}

export class VoiceMetricsCollector {
  private readonly now: () => number;
  private readonly turns: DraftTurn[] = [];
  private readonly sessions: {
    readonly id: number;
    mode: VoiceMode;
    startedAt: number;
    endedAt: number | null;
    endReason: string | null;
    errorCode: string | null;
  }[] = [];
  private nextSessionId = 1;
  private nextTurnId = 1;
  private readonly listeners = new Set<() => void>();
  private readonly resetListeners = new Set<() => void>();
  private cachedSnapshot: MetricsSnapshot | null = null;

  constructor(options: VoiceMetricsOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  startSession(mode: VoiceMode): number {
    const id = this.nextSessionId;
    this.nextSessionId += 1;
    this.sessions.push({
      endedAt: null,
      endReason: null,
      errorCode: null,
      id,
      mode,
      startedAt: this.now(),
    });
    this.invalidate();

    return id;
  }

  recordSessionError(sessionId: number, code: string | null): void {
    const session = this.sessions.find((item) => item.id === sessionId);

    if (session) {
      session.errorCode = sanitizeCode(code) ?? "unknown_error";
      this.invalidate();
    }
  }

  endSession(sessionId: number, reason: string): void {
    const session = this.sessions.find((item) => item.id === sessionId);

    if (!session || session.endedAt !== null) {
      return;
    }

    session.endedAt = this.now();
    session.endReason = sanitizeLabel(reason);
    this.invalidate();
  }

  startTurn(mode: VoiceMode, scenario: string | null = null): number {
    const id = this.nextTurnId;
    this.nextTurnId += 1;
    this.turns.push({
      bargeInAt: null,
      errorCode: null,
      finishedAt: null,
      firstAudioAt: null,
      id,
      mode,
      proposalOutcome: null,
      scenario: sanitizeLabel(scenario),
      silencedAt: null,
      toolRoundTripMs: null,
      toolRoundTripsMs: [],
      turnEndedAt: null,
      usage: [],
    });
    this.invalidate();

    return id;
  }

  markTurnEnd(turnId: number): void {
    this.update(turnId, (turn) => {
      if (turn.firstAudioAt === null) {
        turn.turnEndedAt = this.now();
      }
    });
  }

  markFirstAudio(turnId: number): void {
    this.update(turnId, (turn) => {
      if (turn.firstAudioAt === null) {
        turn.firstAudioAt = this.now();
      }
    });
  }

  markBargeIn(turnId: number): void {
    this.update(turnId, (turn) => {
      if (turn.bargeInAt === null) {
        turn.bargeInAt = this.now();
      }
    });
  }

  markOutputSilenced(turnId: number): void {
    this.update(turnId, (turn) => {
      if (turn.bargeInAt !== null && turn.silencedAt === null) {
        turn.silencedAt = this.now();
      }
    });
  }

  recordToolRoundTrip(turnId: number, durationMs: number): void {
    this.update(turnId, (turn) => {
      if (Number.isFinite(durationMs) && durationMs >= 0) {
        const rounded = Math.round(durationMs);
        turn.toolRoundTripMs = rounded;
        turn.toolRoundTripsMs = [...turn.toolRoundTripsMs, rounded];
      }
    });
  }

  recordError(turnId: number, code: string | null): void {
    this.update(turnId, (turn) => {
      turn.errorCode = sanitizeCode(code) ?? "unknown_error";
    });
  }

  recordUsage(turnId: number, observation: UsageObservation): void {
    const provider = sanitizeCode(observation.provider) ?? "unknown";
    const usd =
      typeof observation.usd === "number" &&
      Number.isFinite(observation.usd) &&
      observation.usd >= 0
        ? observation.usd
        : undefined;

    this.update(turnId, (turn) => {
      turn.usage = [
        ...turn.usage,
        {
          kind: observation.kind,
          provider,
          ...(usd === undefined ? {} : { usd }),
        },
      ];
    });
  }

  recordSelection(mode: VoiceMode, matched: boolean | null): void {
    this.selections.push({ matched, mode });
    this.invalidate();
  }

  recordProposal(turnId: number, outcome: ProposalMetricOutcome): void {
    this.update(turnId, (turn) => {
      turn.proposalOutcome = outcome;
    });
  }

  finishTurn(turnId: number): void {
    this.update(turnId, (turn) => {
      if (turn.finishedAt === null) {
        turn.finishedAt = this.now();
      }
    });
  }

  reset(): void {
    this.turns.length = 0;
    this.sessions.length = 0;
    this.selections.length = 0;
    this.invalidate();

    for (const listener of this.resetListeners) {
      listener();
    }
  }

  onReset(listener: () => void): () => void {
    this.resetListeners.add(listener);

    return () => {
      this.resetListeners.delete(listener);
    };
  }

  getTurnRecords(): readonly TurnRecord[] {
    return this.turns.map((turn) => ({
      bargeInAt: turn.bargeInAt,
      errorCode: turn.errorCode,
      finishedAt: turn.finishedAt,
      firstAudioAt: turn.firstAudioAt,
      mode: turn.mode,
      proposalOutcome: turn.proposalOutcome,
      scenario: turn.scenario,
      silencedAt: turn.silencedAt,
      toolRoundTripMs: turn.toolRoundTripMs,
      toolRoundTripsMs: [...turn.toolRoundTripsMs],
      turnEndedAt: turn.turnEndedAt,
      usage: [...turn.usage],
    }));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): MetricsSnapshot => {
    if (this.cachedSnapshot !== null) {
      return this.cachedSnapshot;
    }

    const snapshot = this.buildSnapshot();
    this.cachedSnapshot = snapshot;

    return snapshot;
  };

  private readonly selections: {
    readonly mode: VoiceMode;
    readonly matched: boolean | null;
  }[] = [];

  private update(turnId: number, mutate: (turn: DraftTurn) => void): void {
    const turn = this.turns.find((item) => item.id === turnId);

    if (!turn) {
      return;
    }

    mutate(turn);
    this.invalidate();
  }

  private invalidate(): void {
    this.cachedSnapshot = null;

    for (const listener of this.listeners) {
      listener();
    }
  }

  private buildSnapshot(): MetricsSnapshot {
    return {
      generatedAt: this.now(),
      modes: MODES.map((mode) => this.buildMode(mode)),
      sessions: this.sessions.map((session) => ({ ...session })),
    };
  }

  private buildMode(mode: VoiceMode): ModeSummary {
    const turns = this.turns.filter((turn) => turn.mode === mode);
    const firstAudio = turns
      .filter(
        (turn) =>
          turn.firstAudioAt !== null && turn.turnEndedAt !== null,
      )
      .map((turn) => (turn.firstAudioAt as number) - (turn.turnEndedAt as number))
      .filter((value) => value >= 0);
    const bargeIn = turns
      .filter(
        (turn) => turn.silencedAt !== null && turn.bargeInAt !== null,
      )
      .map((turn) => (turn.silencedAt as number) - (turn.bargeInAt as number))
      .filter((value) => value >= 0);
    const tool = turns
      .flatMap((turn) => turn.toolRoundTripsMs);
    const usage = turns.flatMap((turn) => turn.usage);
    const reportedUsd = usage
      .filter((item) => item.kind === "reported" && item.usd !== undefined)
      .reduce((sum, item) => sum + (item.usd ?? 0), 0);
    const estimatedUsd = usage
      .filter((item) => item.kind === "estimated" && item.usd !== undefined)
      .reduce((sum, item) => sum + (item.usd ?? 0), 0);
    const proposals = Object.fromEntries(
      PROPOSAL_OUTCOMES.map((outcome) => [
        outcome,
        turns.filter((turn) => turn.proposalOutcome === outcome).length,
      ]),
    ) as Record<ProposalMetricOutcome, number>;
    const selections = this.selections.filter(
      (selection) => selection.mode === mode,
    );

    return {
      bargeInSilenceMs: bargeIn,
      bargeInSilenceMedianMs: median(bargeIn),
      bargeInSilenceRangeMs: range(bargeIn),
      errors: turns.filter((turn) => turn.errorCode !== null).length,
      finishedTurns: turns.filter((turn) => turn.finishedAt !== null).length,
      firstAudioMedianMs: median(firstAudio),
      firstAudioMs: firstAudio,
      firstAudioRangeMs: range(firstAudio),
      mode,
      noteMatches: selections.filter((item) => item.matched === true).length,
      noteMismatches: selections.filter((item) => item.matched === false)
        .length,
      proposals,
      selections: selections.length,
      sessions: this.sessions.filter((session) => session.mode === mode).length,
      sessionErrors: this.sessions.filter(
        (session) => session.mode === mode && session.errorCode !== null,
      ).length,
      toolRoundTripMedianMs: median(tool),
      toolRoundTripMs: tool,
      toolRoundTripRangeMs: range(tool),
      turns: turns.length,
      usage: {
        estimated: usage.filter((item) => item.kind === "estimated").length,
        estimatedUsd,
        reported: usage.filter((item) => item.kind === "reported").length,
        reportedUsd,
        unknown: usage.filter((item) => item.kind === "unknown").length,
      },
    };
  }
}

export const voiceMetrics = new VoiceMetricsCollector();

export function formatMetricsMs(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} ms`;
}

export function formatMetricsRange(
  value: readonly [number, number] | null,
): string {
  return value === null
    ? "—"
    : `${Math.round(value[0])}–${Math.round(value[1])} ms`;
}
