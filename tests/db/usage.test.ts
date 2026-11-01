import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  assertTestDatabaseTargets,
  type TestDatabaseTargets,
} from "../../scripts/test-db-guard";
import {
  createDatabase,
  type DatabaseConnection,
} from "../../src/lib/db/client";
import {
  BudgetExceededError,
  PriceUnavailableError,
  UsageNotFoundError,
  UsageResetBlockedError,
  UsageStateError,
  UsageValidationError,
  createUsageService,
  formatUsageCost,
  reconcileInterruptedReservations,
  type UsageService,
} from "../../src/lib/ai/usage";
import { SCRIBE_TOKEN_OPERATION } from "../../src/lib/elevenlabs/client";
import { createNoteService } from "../../src/lib/notes/service";

const hasTestDatabase = Boolean(
  process.env.DATABASE_URL && process.env.TEST_DATABASE_URL,
);

describe.skipIf(!hasTestDatabase)("paid-operation usage ledger", () => {
  let connection: DatabaseConnection;
  let targets: TestDatabaseTargets;

  function useService(budgetUsd = 2): UsageService {
    return createUsageService({ db: connection.db, budgetUsd });
  }

  beforeAll(() => {
    targets = assertTestDatabaseTargets();
    connection = createDatabase(targets.testUrl);
  });

  beforeEach(async () => {
    await connection.pool.query("TRUNCATE TABLE ai_usage");
    await connection.pool.query(
      "UPDATE ai_budget SET budget_usd = 2.000000, updated_at = now() WHERE id = 1",
    );
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  it("serializes concurrent reservations so the estimated cap is never exceeded", async () => {
    const service = useService();
    const attempts = Array.from({ length: 6 }, (_, index) =>
      service.reserve({
        operation: `souběh-${index}`,
        provider: "test",
        model: "test-model",
        estimatedMaxCostUsd: 0.5,
      }),
    );
    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter(
      (result) => result.status === "fulfilled",
    );
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(4);
    expect(rejected).toHaveLength(2);

    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(BudgetExceededError);
    }

    const summary = await service.getSummary();
    expect(summary.budgetUsd).toBe("2.000000");
    expect(summary.committedUsd).toBe("2.000000");
    expect(summary.reservedUsd).toBe("2.000000");
    expect(summary.remainingUsd).toBe("0.000000");
    expect(summary.activeCount).toBe(4);
    expect(summary.operations).toHaveLength(4);
  });

  it("keeps failed operations reserved and reports uncertain cost as unknown", async () => {
    const service = useService();
    const settled = await service.reserve({
      operation: "embedding",
      provider: "openrouter",
      model: "embedding-model",
      estimatedMaxCostUsd: 0.25,
    });
    const failed = await service.reserve({
      operation: "tts",
      provider: "openrouter",
      model: "tts-model",
      estimatedMaxCostUsd: 0.25,
    });

    await service.settle(settled.id, {
      reportedCostUsd: 0.1,
      providerUsage: { inputTokens: 12, outputTokens: 3 },
    });
    await service.markUnknown(failed.id, { error: "timeout" });

    const summary = await service.getSummary();
    expect(summary.committedUsd).toBe("0.350000");
    expect(summary.reportedUsd).toBe("0.100000");
    expect(summary.unknownCount).toBe(1);
    expect(summary.activeCount).toBe(0);

    const byId = new Map(summary.operations.map((row) => [row.id, row]));
    const settledRow = byId.get(settled.id);
    const unknownRow = byId.get(failed.id);

    expect(settledRow?.status).toBe("settled");
    expect(settledRow?.reportedCostUsd).toBe("0.100000");
    expect(settledRow?.providerUsage).toEqual({
      inputTokens: 12,
      outputTokens: 3,
    });
    expect(settledRow ? formatUsageCost(settledRow) : null).toContain("0,10");
    expect(unknownRow?.status).toBe("unknown");
    expect(unknownRow?.reportedCostUsd).toBeNull();
    expect(unknownRow?.providerUsage).toEqual({ error: "timeout" });
    expect(unknownRow ? formatUsageCost(unknownRow) : null).toBe(
      "Neznámá cena",
    );

    await expect(service.settle(failed.id, { reportedCostUsd: 0 })).rejects.toBeInstanceOf(
      UsageStateError,
    );
    expect((await service.getSummary()).committedUsd).toBe("0.350000");
  });

  it("settles an unknown realtime reservation from its later audio duration", async () => {
    const service = useService();
    const realtime = await service.reserve({
      operation: SCRIBE_TOKEN_OPERATION,
      provider: "elevenlabs",
      model: "scribe_v2_realtime",
      estimatedMaxCostUsd: 0.0195,
    });

    await service.markUnknown(realtime.id, {
      chargeReason: "realtime_session_usage_unknown",
    });
    expect((await service.getSummary()).committedUsd).toBe("0.019500");

    await expect(
      service.settle(
        realtime.id,
        { reportedCostUsd: 0.00455 },
        {
          allowUnknown: true,
          expectedOperation: "other_operation",
          expectedProvider: "elevenlabs",
        },
      ),
    ).rejects.toBeInstanceOf(UsageNotFoundError);

    const settled = await service.settle(
      realtime.id,
      {
        reportedCostUsd: 0.00455,
        providerUsage: { chargeBasis: "audio_duration" },
      },
      {
        allowUnknown: true,
        expectedOperation: SCRIBE_TOKEN_OPERATION,
        expectedProvider: "elevenlabs",
      },
    );

    expect(settled.status).toBe("settled");
    expect(settled.reportedCostUsd).toBe("0.004550");

    const summary = await service.getSummary();
    expect(summary.committedUsd).toBe("0.004550");
    expect(summary.reportedUsd).toBe("0.004550");
    expect(summary.unknownCount).toBe(0);
    expect(summary.activeCount).toBe(0);

    await expect(
      service.settle(
        realtime.id,
        { reportedCostUsd: 0.00455 },
        { allowUnknown: true, expectedOperation: SCRIBE_TOKEN_OPERATION },
      ),
    ).rejects.toBeInstanceOf(UsageStateError);
  });

  it("does not clear or reset usage when the service or connection is recreated", async () => {
    const service = useService();
    await service.reserve({
      operation: "llm",
      provider: "openrouter",
      model: "test-model",
      estimatedMaxCostUsd: 0.2,
    });

    const otherConnection = createDatabase(targets.testUrl);

    try {
      const restarted = createUsageService({
        db: otherConnection.db,
        budgetUsd: 2,
      });
      const summary = await restarted.getSummary();

      expect(summary.committedUsd).toBe("0.200000");
      expect(summary.activeCount).toBe(1);
      expect(summary.operations).toHaveLength(1);
    } finally {
      await otherConnection.pool.end();
    }
  });

  it("turns reservations interrupted by a restart into unknown while keeping their cost", async () => {
    const service = useService();
    const operation = await service.reserve({
      operation: "llm",
      provider: "openrouter",
      model: "test-model",
      estimatedMaxCostUsd: 0.4,
    });
    const restartedConnection = createDatabase(targets.testUrl);

    try {
      expect(
        await reconcileInterruptedReservations(restartedConnection.db),
      ).toBe(1);

      const restarted = createUsageService({
        db: restartedConnection.db,
        budgetUsd: 2,
      });
      const summary = await restarted.getSummary();
      const reconciled = summary.operations.find(
        (row) => row.id === operation.id,
      );

      expect(summary.activeCount).toBe(0);
      expect(summary.unknownCount).toBe(1);
      expect(summary.committedUsd).toBe("0.400000");
      expect(reconciled?.status).toBe("unknown");
      expect(reconciled?.reportedCostUsd).toBeNull();
      expect(reconciled ? formatUsageCost(reconciled) : null).toBe(
        "Neznámá cena",
      );
      await expect(restarted.resetUsage()).resolves.toEqual({ reset: true });
    } finally {
      await restartedConnection.pool.end();
    }
  });

  it("refuses reset while a reservation is active and allows it afterwards", async () => {
    const service = useService();
    const operation = await service.reserve({
      operation: "tts",
      provider: "openrouter",
      model: "test-model",
      estimatedMaxCostUsd: 0.3,
    });

    await expect(service.resetUsage()).rejects.toBeInstanceOf(
      UsageResetBlockedError,
    );

    expect((await service.getSummary()).activeCount).toBe(1);

    await service.markUnknown(operation.id);
    await expect(service.resetUsage()).resolves.toEqual({ reset: true });

    const summary = await service.getSummary();
    expect(summary.committedUsd).toBe("0.000000");
    expect(summary.activeCount).toBe(0);
    expect(summary.unknownCount).toBe(0);
    expect(summary.operations).toEqual([]);
  });

  it("refuses admission when a conservative maximum price is unavailable", async () => {
    const service = useService();

    await expect(
      service.reserve({
        operation: "unknown-price",
        provider: "test",
        model: "test-model",
        estimatedMaxCostUsd: null,
      }),
    ).rejects.toBeInstanceOf(PriceUnavailableError);

    await expect(
      service.reserve({
        operation: "invalid-price",
        provider: "test",
        model: "test-model",
        estimatedMaxCostUsd: Number.NaN,
      }),
    ).rejects.toBeInstanceOf(UsageValidationError);

    expect((await service.getSummary()).operations).toEqual([]);
  });

  it("keeps manual notes usable without provider keys or active usage", async () => {
    const notes = createNoteService({ db: connection.db });
    const note = await notes.createNote({
      title: "Ručně psaná poznámka",
      contentMd: "Bez API klíčů.",
    });

    expect(note.contentPlain).toBe("Bez API klíčů.");
    expect((await useService().getSummary()).operations).toEqual([]);
  });
});
