// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PendingEdit,
  type PendingEditResult,
} from "../../src/components/voice-agent/PendingEdit";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const NONCE = "n".repeat(43);
const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "s".repeat(43);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function pendingProposal() {
  return {
    afterMd: "Ahoj světe.\n\n- [ ] Koupit mléko",
    beforeMd: "Ahoj světe.",
    confirmationNonce: NONCE,
    diff: {
      end: 11,
      inserted: "\n\n- [ ] Koupit mléko",
      prefix: "Ahoj světe.",
      removed: "",
      start: 11,
      suffix: "",
    },
    expectedVersion: 3,
    expiresAt: "2026-10-30T12:05:00.000Z",
    noteId: NOTE_ID,
    noteTitle: "Nákupní poznámka",
    operation: { text: "- [ ] Koupit mléko", type: "append_bounded_section" },
    proposalId: PROPOSAL_ID,
    selectedCandidate: null,
    status: "pending",
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PendingEdit", () => {
  let onResultRef: (result: PendingEditResult) => void;

  beforeEach(() => {
    onResultRef = vi.fn();
  });

  it("shows the complete change, target, version and expiry without exposing the nonce", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, proposal: pendingProposal() }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <PendingEdit
        onClose={() => undefined}
        onResult={onResultRef}
        proposalId={PROPOSAL_ID}
        sessionId={SESSION_ID}
      />,
    );

    expect(await screen.findByTestId("voice-agent-pending-edit")).toBeDefined();
    expect(screen.getByText("Nákupní poznámka")).toBeDefined();
    expect(screen.getByText(/verze 3/)).toBeDefined();
    expect(screen.getByText(/Konec poznámky/)).toBeDefined();
    expect(screen.getByText(/Platí do/)).toBeDefined();
    expect(screen.getByTestId("voice-agent-pending-diff").textContent).toContain(
      "- [ ] Koupit mléko",
    );
    expect(screen.getByRole("button", { name: "Potvrdit" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.queryByRole("button", { name: "Zavřít" })).toBeNull();
    expect(container.textContent).not.toContain(NONCE);

    const pendingCall = fetchMock.mock.calls[0] as unknown as [
      RequestInfo,
      RequestInit,
    ];
    expect(String(pendingCall[0])).toContain(
      `/api/voice-agent/pending/${PROPOSAL_ID}`,
    );
    expect(JSON.parse(String(pendingCall[1].body))).toEqual({
      sessionId: SESSION_ID,
    });
  });

  it("rejects through the same-origin proposal route and shows the final status", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        action?: string;
      };

      if (String(input).includes("/pending/") && body.action === "reject") {
        return jsonResponse({
          expiresAt: "2026-10-30T12:05:00.000Z",
          ok: true,
          proposalId: PROPOSAL_ID,
          status: "rejected",
        });
      }

      return jsonResponse({ ok: true, proposal: pendingProposal() });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PendingEdit
        onClose={() => undefined}
        onResult={onResultRef}
        proposalId={PROPOSAL_ID}
        sessionId={SESSION_ID}
      />,
    );

    const reject = await screen.findByTestId("voice-agent-pending-reject");
    fireEvent.click(reject);

    await waitFor(() =>
      expect(screen.getByText("Zamítnuto")).toBeDefined(),
    );
    expect(
      fetchMock.mock.calls.some(([input, init]) => {
        const body = JSON.parse(String((init as RequestInit).body ?? "{}")) as {
          action?: string;
        };

        return (
          String(input).includes(`/api/voice-agent/pending/${PROPOSAL_ID}`) &&
          body.action === "reject"
        );
      }),
    ).toBe(true);
    expect(onResultRef).toHaveBeenCalledWith({
      kind: "rejected",
      noteId: NOTE_ID,
      noteTitle: "Nákupní poznámka",
      proposalId: PROPOSAL_ID,
    });
    expect(
      screen.getByTestId("voice-agent-pending-reject"),
    ).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Zavřít" })).toBeDefined();
  });

  it("shows an expired proposal without a nonce and disables rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          proposal: {
            ...pendingProposal(),
            confirmationNonce: null,
            status: "expired",
          },
        }),
      ),
    );

    render(
      <PendingEdit
        onClose={() => undefined}
        onResult={onResultRef}
        proposalId={PROPOSAL_ID}
        sessionId={SESSION_ID}
      />,
    );

    expect(await screen.findByText("Vypršelo")).toBeDefined();
    expect(screen.getByText(/Platí do/)).toBeDefined();
    expect(screen.queryByText("Čeká na potvrzení")).toBeNull();
    expect(
      screen.getByTestId("voice-agent-pending-reject"),
    ).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Zavřít" })).toBeDefined();
  });

  it("confirms only from the click, sends the nonce once and accepts the actual applied version", async () => {
    const onResult = vi.fn<(result: PendingEditResult) => void>();
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      if (String(input) === "/api/voice-agent/confirm") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        expect(body).toMatchObject({
          confirmationNonce: NONCE,
          proposalId: PROPOSAL_ID,
          sessionId: SESSION_ID,
        });
        expect(body).not.toHaveProperty("expectedVersion");

        return jsonResponse({
          note: { id: NOTE_ID, version: 4 },
          ok: true,
          proposal: { ...pendingProposal(), status: "applied" },
        });
      }

      return jsonResponse({ ok: true, proposal: pendingProposal() });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PendingEdit
        onClose={() => undefined}
        onResult={onResult}
        proposalId={PROPOSAL_ID}
        sessionId={SESSION_ID}
      />,
    );

    fireEvent.click(await screen.findByTestId("voice-agent-pending-confirm"));

    expect(await screen.findByText("Aplikováno")).toBeDefined();
    expect(onResult).toHaveBeenCalledWith({
      kind: "applied",
      noteId: NOTE_ID,
      noteTitle: "Nákupní poznámka",
      noteVersion: 4,
      proposalId: PROPOSAL_ID,
    });
    expect(document.body.textContent).not.toContain(NONCE);
    expect(
      screen.getByTestId("voice-agent-pending-confirm"),
    ).toHaveProperty("disabled", true);
  });

  it("shows a conflict as a failure and never claims the edit was applied", async () => {
    const onResult = vi.fn<(result: PendingEditResult) => void>();
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      if (String(input) === "/api/voice-agent/confirm") {
        return jsonResponse(
          {
            error: {
              code: "proposal_stale",
              message: "Poznámka byla mezitím změněna. Vytvořte nový návrh.",
            },
          },
          409,
        );
      }

      return jsonResponse({ ok: true, proposal: pendingProposal() });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PendingEdit
        onClose={() => undefined}
        onResult={onResult}
        proposalId={PROPOSAL_ID}
        sessionId={SESSION_ID}
      />,
    );

    fireEvent.click(await screen.findByTestId("voice-agent-pending-confirm"));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Poznámka byla mezitím změněna.",
    );
    expect(screen.queryByText("Aplikováno")).toBeNull();
    expect(screen.getByText("Nelze potvrdit")).toBeDefined();
    expect(screen.queryByText("Čeká na potvrzení")).toBeNull();
    expect(screen.getByRole("button", { name: "Zavřít" })).toBeDefined();
    expect(
      screen.getByTestId("voice-agent-pending-confirm"),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByTestId("voice-agent-pending-reject"),
    ).toHaveProperty("disabled", false);
    expect(onResult).toHaveBeenCalledWith({
      code: "proposal_stale",
      kind: "failed",
      message: "Poznámka byla mezitím změněna. Vytvořte nový návrh.",
      noteId: NOTE_ID,
      noteTitle: "Nákupní poznámka",
      proposalId: PROPOSAL_ID,
    });
  });

  it("starts a different proposal in a confirmable state after a terminal failure", async () => {
    const onResult = vi.fn<(result: PendingEditResult) => void>();
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      if (String(input) === "/api/voice-agent/confirm") {
        return jsonResponse(
          {
            error: {
              code: "proposal_stale",
              message: "Poznámka byla mezitím změněna.",
            },
          },
          409,
        );
      }

      return jsonResponse({ ok: true, proposal: pendingProposal() });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <PendingEdit
        onClose={() => undefined}
        onResult={onResult}
        proposalId={PROPOSAL_ID}
        sessionId={SESSION_ID}
      />,
    );

    fireEvent.click(await screen.findByTestId("voice-agent-pending-confirm"));
    expect(await screen.findByText("Nelze potvrdit")).toBeDefined();

    rerender(
      <PendingEdit
        onClose={() => undefined}
        onResult={onResult}
        proposalId="33333333-3333-4333-8333-333333333333"
        sessionId={SESSION_ID}
      />,
    );

    expect(await screen.findByText("Čeká na potvrzení")).toBeDefined();
    expect(
      screen.getByTestId("voice-agent-pending-confirm"),
    ).toHaveProperty("disabled", false);
    expect(screen.queryByText("Nelze potvrdit")).toBeNull();
  });

  it("shows a server error when the wrong session asks for the pending detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: "proposal_not_found",
              message: "Návrh v této relaci neexistuje.",
            },
          },
          404,
        ),
      ),
    );

    render(
      <PendingEdit
        onClose={() => undefined}
        onResult={onResultRef}
        proposalId={PROPOSAL_ID}
        sessionId={"x".repeat(43)}
      />,
    );

    expect(
      (await screen.findByRole("alert")).textContent,
    ).toContain("Návrh v této relaci neexistuje.");
    expect(screen.queryByTestId("voice-agent-pending-diff")).toBeNull();
  });
});
