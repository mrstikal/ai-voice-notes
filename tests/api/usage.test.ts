import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GET as getUsage,
  POST as resetUsage,
} from "@/app/api/settings/usage/route";
import {
  UsageResetBlockedError,
  type UsageSummaryDto,
} from "@/lib/ai/usage";

const service = vi.hoisted(() => ({
  getSummary: vi.fn(),
  resetUsage: vi.fn(),
}));

vi.mock("@/lib/ai/usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/usage")>();
  return {
    ...actual,
    getUsageService: () => service,
  };
});

const APP_ORIGIN = "http://127.0.0.1:3000";

const summary: UsageSummaryDto = {
  budgetUsd: "2.000000",
  committedUsd: "0.250000",
  reservedUsd: "0.250000",
  reportedUsd: "0.000000",
  remainingUsd: "1.750000",
  activeCount: 1,
  unknownCount: 0,
  operations: [],
};

function request(
  options: {
    method?: string;
    body?: unknown;
  } = {},
): Request {
  return new Request(`${APP_ORIGIN}/api/settings/usage`, {
    method: options.method ?? "GET",
    headers: {
      host: "127.0.0.1:3000",
      origin: APP_ORIGIN,
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

describe("usage settings API", () => {
  beforeAll(() => {
    vi.stubEnv("APP_ORIGIN", APP_ORIGIN);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the usage summary without resetting it", async () => {
    service.getSummary.mockResolvedValue(summary);

    const response = await getUsage(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(summary);
    expect(service.getSummary).toHaveBeenCalledTimes(1);
    expect(service.resetUsage).not.toHaveBeenCalled();
  });

  it("requires the explicit reset confirmation", async () => {
    const response = await resetUsage(
      request({ method: "POST", body: { confirmation: "yes" } }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_shape" },
    });
    expect(service.resetUsage).not.toHaveBeenCalled();
  });

  it("resets and returns the cleared summary", async () => {
    service.resetUsage.mockResolvedValue({ reset: true });
    service.getSummary.mockResolvedValue({
      ...summary,
      activeCount: 0,
      committedUsd: "0.000000",
      remainingUsd: "2.000000",
      reservedUsd: "0.000000",
    });

    const response = await resetUsage(
      request({ method: "POST", body: { confirmation: "reset-usage" } }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      activeCount: 0,
      committedUsd: "0.000000",
    });
    expect(service.resetUsage).toHaveBeenCalledTimes(1);
  });

  it("refuses reset while a reservation is active", async () => {
    service.resetUsage.mockRejectedValue(new UsageResetBlockedError(1));

    const response = await resetUsage(
      request({ method: "POST", body: { confirmation: "reset-usage" } }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { activeCount: 1, code: "usage_active" },
    });
  });
});
