// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NoteTags } from "../../src/components/notes/NoteTags";
import type { NoteDetail } from "../../src/lib/notes/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const note: NoteDetail = {
  category: "Osobní",
  contentMd: "Text.",
  contentPlain: "Text.",
  createdAt: "2026-10-28T10:00:00.000Z",
  deletedAt: null,
  id: "11111111-1111-4111-8111-111111111111",
  tags: ["manual"],
  title: "Tagy",
  updatedAt: "2026-10-28T10:00:00.000Z",
  version: 1,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("P30B NoteTags without a provider key", () => {
  it("disables only the AI action and keeps manual tags editable", async () => {
    const user = userEvent.setup();

    render(
      <NoteTags
        llmStatus={null}
        note={note}
        onNoteUpdated={vi.fn()}
      />,
    );

    expect(
      (screen.getByTestId("tag-ai-suggest") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("tag-input") as HTMLInputElement).disabled,
    ).toBe(false);

    await user.type(screen.getByTestId("tag-input"), "atlas");
    await user.click(screen.getByTestId("tag-add"));

    expect(screen.getByTestId("tag-atlas")).not.toBeNull();
    expect(
      (screen.getByTestId("tag-save") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
