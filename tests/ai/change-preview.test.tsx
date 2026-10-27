// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChangePreview } from "../../src/components/ai/ChangePreview";
import type { EditProposal } from "../../src/lib/notes/proposal-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterEach(cleanup);

function proposal(overrides: Partial<EditProposal> = {}): EditProposal {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    noteId: "22222222-2222-4222-8222-222222222222",
    noteTitle: "Bezpečná poznámka",
    expectedVersion: 3,
    originalHash: "a".repeat(64),
    operation: {
      type: "replace_sentence",
      target: { startPhrase: "První", endPhrase: "věta" },
      text: "Nová věta.",
    },
    beforeMd: "První věta. Druhá věta.",
    afterMd: "Nová věta. Druhá věta.",
    selectedCandidate: null,
    status: "pending",
    expiresAt: "2026-10-27T10:05:00.000Z",
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T10:00:00.000Z",
    diff: {
      start: 0,
      end: "První".length,
      prefix: "",
      removed: "První",
      inserted: "Nová",
      suffix: " věta. Druhá věta.",
    },
    ...overrides,
  };
}

describe("ChangePreview", () => {
  it("shows title, target, version and an escaped plain-text diff without applying it", () => {
    const { container } = render(<ChangePreview proposal={proposal()} />);

    expect(screen.getByText("Bezpečná poznámka")).toBeDefined();
    expect(screen.getByText(/verze 3/)).toBeDefined();
    expect(screen.getByText(/„První“ … „věta“/)).toBeDefined();
    expect(screen.getByText("Čeká na potvrzení")).toBeDefined();
    expect(screen.getByTestId("proposal-diff").textContent).toContain(
      "Nová věta. Druhá věta.",
    );
    expect(container.querySelector("script")).toBeNull();
  });

  it("escapes HTML-looking diff content instead of injecting it", () => {
    const { container } = render(
      <ChangePreview
        proposal={proposal({
          diff: {
            start: 0,
            end: 0,
            prefix: "",
            removed: "",
            inserted: '<script data-testid="injected">alert("x")</script>',
            suffix: "",
          },
        })}
      />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain('<script data-testid="injected">');
    expect(screen.queryByTestId("injected")).toBeNull();
  });

  it("disables confirm and reject while the surrounding editor is dirty", () => {
    render(
      <ChangePreview
        disabled
        onConfirm={vi.fn()}
        onReject={vi.fn()}
        proposal={proposal()}
      />,
    );

    expect(screen.getByRole("button", { name: "Potvrdit" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByRole("button", { name: "Zamítnout návrh" }),
    ).toHaveProperty("disabled", true);
  });

  it("offers reject only for a pending proposal and never renders a nonce", () => {
    const onReject = vi.fn();
    const { container, rerender } = render(
      <ChangePreview onReject={onReject} proposal={proposal()} />,
    );

    expect(container.textContent).not.toMatch(/nonce/iu);
    fireEvent.click(screen.getByRole("button", { name: "Zamítnout návrh" }));
    expect(onReject).toHaveBeenCalledTimes(1);

    rerender(
      <ChangePreview
        onReject={onReject}
        proposal={proposal({ status: "rejected" })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Zamítnout návrh" })).toBeNull();
    expect(screen.getByText("Zamítnuto")).toBeDefined();
  });
});
