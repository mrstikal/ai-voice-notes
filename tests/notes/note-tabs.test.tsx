// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { NoteTabs } from "@/components/notes/NoteTabs";

afterEach(cleanup);

function renderTabs() {
  return render(
    <NoteTabs
      tabs={[
        { id: "content", label: "Obsah poznámky", content: <p>Obsah</p> },
        { id: "history", label: "Historie", content: <p>Historie</p> },
      ]}
    />,
  );
}

function panelFor(tabName: string): HTMLElement {
  const tab = screen.getByRole("tab", { name: tabName });
  const panelId = tab.getAttribute("aria-controls");

  if (!panelId) {
    throw new Error("Tab nemá aria-controls.");
  }

  const panel = document.getElementById(panelId);

  if (!(panel instanceof HTMLElement)) {
    throw new Error("Tab panel nebyl nalezen.");
  }

  return panel;
}

describe("NoteTabs", () => {
  it("renders the tab list and mounts only the active panel", () => {
    renderTabs();

    expect(
      screen.getByRole("tab", { name: "Obsah poznámky" }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: "Historie" }).getAttribute(
        "aria-selected",
      ),
    ).toBe("false");
    expect(panelFor("Obsah poznámky").hidden).toBe(false);
    expect(within(panelFor("Historie")).queryByText("Historie")).toBeNull();
  });

  it("activates a tab by click and keeps visited panels mounted", () => {
    renderTabs();

    fireEvent.click(screen.getByRole("tab", { name: "Historie" }));

    expect(
      screen.getByRole("tab", { name: "Historie" }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    expect(panelFor("Historie").hidden).toBe(false);
    expect(within(panelFor("Historie")).getByText("Historie")).toBeTruthy();
    expect(panelFor("Obsah poznámky").hidden).toBe(true);

    fireEvent.click(screen.getByRole("tab", { name: "Obsah poznámky" }));

    expect(panelFor("Obsah poznámky").hidden).toBe(false);
    expect(panelFor("Historie").hidden).toBe(true);
    expect(within(panelFor("Historie")).getByText("Historie")).toBeTruthy();
  });

  it("moves between tabs with the arrow keys", () => {
    renderTabs();
    const first = screen.getByRole("tab", { name: "Obsah poznámky" });
    first.focus();

    fireEvent.keyDown(first, { key: "ArrowRight" });

    const history = screen.getByRole("tab", { name: "Historie" });
    expect(history.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(history);
  });
});
