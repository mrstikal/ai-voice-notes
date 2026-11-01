import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  UsageStateError,
  type UsageOperationDto,
  type UsageService,
} from "../../src/lib/ai/usage";
import {
  SCRIBE_REALTIME_USD_PER_HOUR,
  SCRIBE_SESSION_MAX_SECONDS,
  SCRIBE_TOKEN_OPERATION,
} from "../../src/lib/elevenlabs/client";
import {
  createScribeUsageRouteHandler,
  settleScribeRealtimeUsage,
} from "../../src/lib/elevenlabs/scribe-usage";

const APP_ORIGIN = "http://127.0.0.1:3000";
const REQUEST_URL = `${APP_ORIGIN}/api/elevenlabs/scribe-usage`;
const USAGE_ID = "11111111-1111-4111-8111-111111111111";

function settledOperation(
  reportedCostUsd: string | null,
  providerUsage: unknown,
): UsageOperationDto {
  return {
    id: USAGE_ID,
    operation: SCRIBE_TOKEN_OPERATION,
    provider: "elevenlabs",
    model: "scribe_v2_realtime",
    status: reportedCostUsd === null ? "unknown" : "settled",
    reservedCostUsd: "0.019500",
    reportedCostUsd,
    providerUsage,
    startedAt: new Date("2026-11-01T18:00:00Z"),
    settledAt: new Date("2026-11-01T18:00:05Z"),
  };
}

function createFakeUsage() {
  const settle = vi.fn(
    async (
      _id: string,
      input: { reportedCostUsd: number | null; providerUsage?: unknown },
    ) => settledOperation(input.reportedCostUsd?.toFixed(6) ?? null, input),
  );

  const usage: UsageService = {
    async reserve() {
      throw new Error("unexpected reserve");
    },
    settle,
    async markUnknown() {
      throw new Error("unexpected markUnknown");
    },
    async getSummary() {
      throw new Error("unexpected getSummary");
    },
    async resetUsage() {
      throw new Error("unexpected resetUsage");
    },
  };

  return { usage, settle };
}

function request(body?: unknown): Request {
  return new Request(REQUEST_URL, {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: APP_ORIGIN,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(() => {
  vi.stubEnv("APP_ORIGIN", APP_ORIGIN);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("settleScribeRealtimeUsage", () => {
  it("computes the realtime price from the measured audio duration", async () => {
    const fake = createFakeUsage();

    const settlement = await settleScribeRealtimeUsage(
      { usage: fake.usage },
      { usageId: USAGE_ID, audioSeconds: 42 },
    );

    expect(settlement.billedSeconds).toBe(42);
    expect(settlement.costUsd).toBeCloseTo(
      (42 * SCRIBE_REALTIME_USD_PER_HOUR) / 3600,
      12,
    );
    expect(fake.settle).toHaveBeenCalledWith(
      USAGE_ID,
      expect.objectContaining({
        reportedCostUsd: (42 * SCRIBE_REALTIME_USD_PER_HOUR) / 3600,
        providerUsage: expect.objectContaining({
          audioDurationSecs: 42,
          usdPerHour: SCRIBE_REALTIME_USD_PER_HOUR,
          chargeBasis: "audio_duration",
          chargeReason: "realtime_audio_duration_price",
        }),
      }),
      {
        allowUnknown: true,
        expectedOperation: SCRIBE_TOKEN_OPERATION,
        expectedProvider: "elevenlabs",
      },
    );
  });

  it("clamps a late report to the configured session cap", async () => {
    const fake = createFakeUsage();

    const settlement = await settleScribeRealtimeUsage(
      { usage: fake.usage },
      { usageId: USAGE_ID, audioSeconds: SCRIBE_SESSION_MAX_SECONDS + 30 },
    );

    expect(settlement.billedSeconds).toBe(SCRIBE_SESSION_MAX_SECONDS);
    expect(settlement.costUsd).toBeCloseTo(
      (SCRIBE_SESSION_MAX_SECONDS * SCRIBE_REALTIME_USD_PER_HOUR) / 3600,
      12,
    );
  });
});

describe("POST /api/elevenlabs/scribe-usage", () => {
  it("settles a token reservation from the reported audio duration", async () => {
    const fake = createFakeUsage();
    const route = createScribeUsageRouteHandler({
      usageFactory: () => fake.usage,
    });

    const response = await route(
      request({ usageId: USAGE_ID, audioSeconds: 42 }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      settled: true,
      billedSeconds: 42,
    });
    expect(fake.settle).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid shape or an out-of-range duration", async () => {
    const fake = createFakeUsage();
    const route = createScribeUsageRouteHandler({
      usageFactory: () => fake.usage,
    });

    for (const body of [
      {},
      { usageId: "not-a-uuid", audioSeconds: 10 },
      { usageId: USAGE_ID, audioSeconds: 0 },
      { usageId: USAGE_ID, audioSeconds: -1 },
      {
        usageId: USAGE_ID,
        audioSeconds: SCRIBE_SESSION_MAX_SECONDS + 61,
      },
      { usageId: USAGE_ID, audioSeconds: 10, extra: true },
    ]) {
      const response = await route(request(body));
      expect(response.status).toBe(400);
    }

    expect(fake.settle).not.toHaveBeenCalled();
  });

  it("maps a ledger state conflict to a Czech 409", async () => {
    const fake = createFakeUsage();
    fake.settle.mockRejectedValueOnce(new UsageStateError("settled"));
    const route = createScribeUsageRouteHandler({
      usageFactory: () => fake.usage,
    });

    const response = await route(
      request({ usageId: USAGE_ID, audioSeconds: 42 }),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("usage_conflict");
    expect(body.error.message).toMatch(/není ve stavu/u);
  });

  it("requires the exact origin and a JSON body", async () => {
    const fake = createFakeUsage();
    const route = createScribeUsageRouteHandler({
      usageFactory: () => fake.usage,
    });
    const wrongOrigin = new Request(REQUEST_URL, {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ usageId: USAGE_ID, audioSeconds: 42 }),
    });

    expect((await route(wrongOrigin)).status).toBe(403);
    expect(
      (
        await route(
          new Request(REQUEST_URL, {
            method: "POST",
            headers: { host: "127.0.0.1:3000", origin: APP_ORIGIN },
            body: JSON.stringify({ usageId: USAGE_ID, audioSeconds: 42 }),
          }),
        )
      ).status,
    ).toBe(415);
    expect(fake.settle).not.toHaveBeenCalled();
  });
});
