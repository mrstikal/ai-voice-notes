// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SemanticSearch } from "../../src/components/search/SemanticSearch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const provider = {
  configured: true,
  model: "openai/text-embedding-3-small",
  dimensions: 1536,
  liveStatus: "verified",
  blockedReason: null,
} as const;

const successResult = {
  query: "migrace",
  page: 1,
  pageSize: 10,
  total: 1,
  hasNext: false,
  model: "openai/text-embedding-3-small",
  estimatedMaxCostUsd: 0.000001,
  items: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Migrace",
      category: null,
      tags: [],
      excerpt: "Text o migraci.",
      updatedAt: "2026-10-28T12:00:00.000Z",
    },
  ],
  index: {
    readyNotes: 1,
    readyChunks: 1,
    pendingNotes: 0,
    errorNotes: 0,
    noContentNotes: 0,
  },
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("SemanticSearch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("requires confirmation, names the query, and clears stale results on edit and failure", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(successResult))
      .mockResolvedValueOnce(
        response(
          { error: { message: "Poskytovatel sémantického hledání selhal." } },
          502,
        ),
      );

    vi.stubGlobal("fetch", fetchMock);

    render(
      <SemanticSearch
        approvalUsd={0.0005}
        initialQuery="migrace"
        provider={provider}
      />,
    );

    const submit = screen.getByTestId("semantic-submit") as HTMLButtonElement;

    expect(submit.disabled).toBe(true);

    await user.click(screen.getByTestId("semantic-confirm"));
    expect(submit.disabled).toBe(false);
    await user.click(submit);

    expect(await screen.findByTestId("semantic-results")).toBeDefined();
    expect(screen.getByText(/Pro „migrace“ nalezeno/)).toBeDefined();
    expect(screen.getByText(/Rezervace nejvýše/)).toBeDefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject(
      {
        mode: "semantic",
        q: "migrace",
        page: 1,
        confirmCost: true,
        approvedMaxCostUsd: 0.0005,
      },
    );

    await user.clear(screen.getByTestId("semantic-query"));
    await user.type(screen.getByTestId("semantic-query"), "jiný dotaz");

    await waitFor(() => {
      expect(screen.queryByTestId("semantic-results")).toBeNull();
    });
    expect(screen.queryByText(/Pro „migrace“ nalezeno/)).toBeNull();

    await user.click(screen.getByTestId("semantic-submit"));

    expect(
      (await screen.findByTestId("semantic-error")).textContent,
    ).toContain("Poskytovatel sémantického hledání selhal.");
    expect(screen.queryByTestId("semantic-results")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
