// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IndexControls } from "../../src/components/search/IndexControls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const provider = {
  configured: true,
  model: "openai/text-embedding-3-small",
  dimensions: 1536,
  liveStatus: "verified",
  maxBatchTexts: 20,
  checkedAt: "2026-10-28",
  blockedReason: null,
} as const;

const index = {
  notes: { total: 4, ready: 1, pending: 2, error: 1, noContent: 0 },
  chunks: { current: 6, ready: 2, pending: 3, error: 1 },
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

describe("IndexControls", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows DB-backed counts and requires an explicit estimate and confirmation", async () => {
    const user = userEvent.setup();
    const fetchMock = installFetch((_url, init) => {
      if (!init || init.method === undefined) {
        return jsonResponse({ provider, index });
      }

      const body = JSON.parse(String(init.body)) as {
        confirmCost: boolean;
      };

      if (!body.confirmCost) {
        return jsonResponse({
          status: "estimate",
          model: provider.model,
          preparedNotes: 0,
          candidateNotes: 2,
          candidateChunks: 3,
          remainingChunks: 1,
          estimatedMaxCostUsd: 0.000004,
        });
      }

      return jsonResponse({
        status: "completed",
        model: provider.model,
        preparedNotes: 0,
        candidateNotes: 2,
        candidateChunks: 3,
        readyChunks: 3,
        discardedChunks: 0,
        staleChunks: 0,
        staleNotes: 0,
        remainingChunks: 1,
        estimatedMaxCostUsd: 0.000004,
        promptTokens: 30,
      });
    });

    render(<IndexControls />);

    expect(await screen.findByText(/Připraveno 1 · Čeká 2/)).toBeDefined();

    await user.click(screen.getByTestId("index-reindex"));

    expect(await screen.findByTestId("index-estimate")).toBeDefined();
    expect(screen.getByText(/2 poznámek · 3 chunků/)).toBeDefined();
    expect(screen.getByText(/0,000004 USD/)).toBeDefined();

    const confirmCallsBefore = fetchMock.mock.calls.filter(
      (call) => call[1]?.method === "POST",
    ).length;

    expect(confirmCallsBefore).toBe(1);

    await user.click(screen.getByTestId("index-confirm"));

    expect(await screen.findByTestId("index-completed")).toBeDefined();
    expect(screen.getByText(/Připraveno 3 chunků/)).toBeDefined();
    expect(screen.getByText(/Zbývá 1 chunků/)).toBeDefined();

    const confirmCall = fetchMock.mock.calls.find((call) => {
      const init = call[1];

      return (
        init?.method === "POST" &&
        JSON.parse(String(init.body)).confirmCost === true
      );
    });

    expect(confirmCall).toBeDefined();
    expect(JSON.parse(String(confirmCall?.[1]?.body))).toEqual({
      confirmCost: true,
      approvedMaxCostUsd: 0.000004,
    });
  });

  it("disables reindexing with a Czech reason when the provider is blocked", async () => {
    installFetch(() =>
      jsonResponse({
        provider: {
          ...provider,
          configured: false,
          blockedReason:
            "OpenRouter API klíč není nakonfigurovaný. Semantické indexování zůstává vypnuté.",
        },
        index,
      }),
    );

    render(<IndexControls />);

    expect(
      await screen.findByText(/OpenRouter API klíč není nakonfigurovaný/),
    ).toBeDefined();

    const button = screen.getByTestId("index-reindex") as HTMLButtonElement;

    expect(button.disabled).toBe(true);
  });

  it("reports a skipped batch without a paid confirmation", async () => {
    const user = userEvent.setup();
    const fetchMock = installFetch((_url, init) => {
      if (!init || init.method === undefined) {
        return jsonResponse({ provider, index: { ...index, notes: { ...index.notes, pending: 0 } } });
      }

      return jsonResponse({
        status: "skipped",
        reason: "ready",
        model: provider.model,
        preparedNotes: 0,
        candidateNotes: 0,
        candidateChunks: 0,
        remainingChunks: 0,
        estimatedMaxCostUsd: 0,
      });
    });

    render(<IndexControls />);
    await screen.findByTestId("index-controls");

    await user.click(screen.getByTestId("index-reindex"));

    await waitFor(() => {
      expect(screen.queryByTestId("index-estimate")).toBeNull();
    });
    expect(screen.getByText(/Placené volání se neprovádí/)).toBeDefined();
    expect(fetchMock.mock.calls.every((call) => call[1]?.method !== "POST" || JSON.parse(String(call[1].body)).confirmCost === false)).toBe(true);
  });
});
