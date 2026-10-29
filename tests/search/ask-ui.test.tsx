// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AskNotes,
  type AskProviderInfo,
} from "../../src/components/search/AskNotes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const NOTE_A = "11111111-1111-4111-8111-111111111111";
const NOTE_B = "22222222-2222-4222-8222-222222222222";
const CHUNK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHUNK_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const provider: AskProviderInfo = {
  configured: true,
  model: "deepseek/deepseek-v4.1-flash-1017",
  blockedReason: null,
  llmMaxUsd: 0.02,
  approvalUsd: 0.0205,
  semanticAvailable: true,
  embeddingModel: "openai/text-embedding-3-small",
  readyChunks: 3,
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function answeredBody(overrides: Record<string, unknown> = {}) {
  return {
    status: "answered",
    answer: "Migrace je v sobotu.\n\nZáloha je hotová.",
    retrieval: "hybrid",
    claims: [
      {
        text: "Migrace je v sobotu.",
        citations: [
          {
            noteId: NOTE_A,
            chunkId: CHUNK_A,
            noteTitle: "Plán migrace",
            noteVersion: 1,
          },
        ],
      },
      {
        text: "Záloha je hotová.",
        citations: [
          {
            noteId: NOTE_B,
            chunkId: CHUNK_B,
            noteTitle: "Zálohování",
            noteVersion: 2,
          },
        ],
      },
    ],
    sources: [],
    cost: {
      approvedMaxCostUsd: 0.0205,
      queryEmbeddingUsd: 0.000001,
      llmUsd: 0.0002,
      totalEstimatedUsd: 0.000201,
    },
    manualFactualReview: "required",
    approvalCeilingUsd: 0.0205,
    ...overrides,
  };
}

describe("AskNotes", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("requires explicit confirmation and renders each claim with safe citation links", async () => {
    const user = userEvent.setup();
    const body = answeredBody({
      claims: [
        {
          text: "<script>alert(1)</script> Migrace je v sobotu.",
          citations: [
            {
              noteId: NOTE_A,
              chunkId: CHUNK_A,
              noteTitle: "Plán migrace",
              noteVersion: 1,
            },
          ],
        },
        {
          text: "Záloha je hotová.",
          citations: [
            {
              noteId: NOTE_B,
              chunkId: CHUNK_B,
              noteTitle: "Zálohování",
              noteVersion: 2,
            },
          ],
        },
      ],
    });
    const fetchMock = vi.fn();

    fetchMock.mockImplementation(async () => response(body));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<AskNotes provider={provider} />);
    const submit = screen.getByTestId("ask-submit") as HTMLButtonElement;

    expect(submit.disabled).toBe(true);
    await user.type(screen.getByTestId("ask-question"), "Co je s migrací?");
    expect(submit.disabled).toBe(true);
    await user.click(screen.getByTestId("ask-confirm"));
    expect(submit.disabled).toBe(false);
    await user.click(submit);

    expect(await screen.findByTestId("ask-results")).toBeDefined();
    expect(screen.getByTestId("ask-results").textContent).toContain(
      "Co je s migrací?",
    );
    expect(screen.getByTestId("ask-claim-0").textContent).toContain(
      "<script>alert(1)</script>",
    );
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("Plán migrace")).toBeDefined();
    expect(screen.getByText("Zálohování")).toBeDefined();

    const links = screen.getAllByRole("link");

    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `/notes/${NOTE_A}`,
      `/notes/${NOTE_B}`,
    ]);
    expect(screen.getByText(/chunk aaaaaaaa…/)).toBeDefined();
    const results = screen.getByTestId("ask-results");

    expect(results.textContent).toContain("Neznámá");
    expect(results.textContent).toContain("ručně");
    expect(results.textContent).toContain("0,0205 USD");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject(
      {
        question: "Co je s migrací?",
        confirmCost: true,
        approvedMaxCostUsd: 0.0205,
      },
    );
  });

  it("freezes the question while in flight and attributes the result to it", async () => {
    const user = userEvent.setup();
    let resolveFetch!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn(() => pending);

    vi.stubGlobal("fetch", fetchMock);

    render(<AskNotes provider={provider} />);
    const input = screen.getByTestId("ask-question") as HTMLInputElement;

    await user.type(input, "Co je s migrací?");
    await user.click(screen.getByTestId("ask-confirm"));
    await user.click(screen.getByTestId("ask-submit"));

    expect(input.disabled).toBe(true);
    expect(screen.getByTestId("ask-confirm")).toHaveProperty("disabled", true);

    resolveFetch(response(answeredBody()));

    expect(await screen.findByTestId("ask-results")).toBeDefined();
    expect(screen.getByTestId("ask-results").textContent).toContain(
      "na „Co je s migrací?“",
    );
    expect(input.disabled).toBe(false);

    await user.clear(input);
    await user.type(input, "jiná otázka");

    expect(screen.queryByTestId("ask-results")).toBeNull();
  });

  it("shows the exact insufficient-evidence state without citation links", async () => {
    const user = userEvent.setup();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          status: "insufficient_evidence",
          answer:
            "V poznámkách jsem pro tuto odpověď nenašel dostatek podkladů.",
          retrieval: "text_only",
          claims: [],
          sources: [],
          cost: {
            approvedMaxCostUsd: 0.0205,
            queryEmbeddingUsd: 0,
            llmUsd: 0,
            totalEstimatedUsd: 0,
          },
          manualFactualReview: "required",
          approvalCeilingUsd: 0.0205,
        }),
      ),
    );

    render(<AskNotes provider={provider} />);
    await user.type(screen.getByTestId("ask-question"), "nesouvisející dotaz");
    await user.click(screen.getByTestId("ask-confirm"));
    await user.click(screen.getByTestId("ask-submit"));

    expect((await screen.findByTestId("ask-insufficient")).textContent).toContain(
      "V poznámkách jsem pro tuto odpověď nenašel dostatek podkladů.",
    );
    expect(screen.queryByTestId("ask-results")).toBeNull();
    expect(screen.queryByTestId(`ask-citation-${CHUNK_A}`)).toBeNull();
  });

  it("refuses invalid or uncited claim links from a malformed answered response", async () => {
    const user = userEvent.setup();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          answeredBody({
            claims: [
              {
                text: "Tvrzení bez ověřené citace.",
                citations: [
                  {
                    noteId: "not-a-uuid",
                    chunkId: "also-not-a-uuid",
                    noteTitle: "Vymyšlený zdroj",
                    noteVersion: 1,
                  },
                ],
              },
            ],
          }),
        ),
      ),
    );

    render(<AskNotes provider={provider} />);
    await user.type(screen.getByTestId("ask-question"), "otázka");
    await user.click(screen.getByTestId("ask-confirm"));
    await user.click(screen.getByTestId("ask-submit"));

    expect((await screen.findByTestId("ask-error")).textContent).toContain(
      "Odpověď obsahuje citaci, kterou nelze bezpečně otevřít.",
    );
    expect(screen.queryByTestId("ask-results")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows an error and no stale claim links when the paid request fails", async () => {
    const user = userEvent.setup();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          {
            error: {
              code: "grounding_sources_stale",
              message: "Poznámky se během odpovědi změnily. Položte otázku znovu.",
            },
          },
          409,
        ),
      ),
    );

    render(<AskNotes provider={provider} />);
    await user.type(screen.getByTestId("ask-question"), "otázka");
    await user.click(screen.getByTestId("ask-confirm"));
    await user.click(screen.getByTestId("ask-submit"));

    expect((await screen.findByTestId("ask-error")).textContent).toContain(
      "Poznámky se během odpovědi změnily.",
    );
    expect(screen.queryByTestId("ask-results")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Obnovit odhad" }),
    ).toBeDefined();
  });

  it("makes zero paid requests when no question is submitted", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();

    vi.stubGlobal("fetch", fetchMock);

    render(<AskNotes provider={provider} />);
    const submit = screen.getByTestId("ask-submit") as HTMLButtonElement;

    await user.click(screen.getByTestId("ask-confirm"));
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByTestId("ask-question"), "   ");
    expect(submit.disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks the form when the LLM is not configured while leaving the page usable", () => {
    render(
      <AskNotes
        provider={{
          ...provider,
          configured: false,
          blockedReason: "OpenRouter API klíč není nakonfigurovaný.",
        }}
      />,
    );

    expect(screen.getByTestId("ask-notes").textContent).toContain(
      "OpenRouter API klíč není nakonfigurovaný.",
    );
    expect(screen.queryByTestId("ask-submit")).toBeNull();
  });
});
