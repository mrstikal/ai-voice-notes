// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpokenStopSettings } from "../../src/components/settings/SpokenStopSettings";
import {
  getStopMonitorPreferenceSnapshot,
  recordStopMonitorAttempt,
  recordStopMonitorSuccess,
  resetStopMonitorForTests,
} from "../../src/lib/voice/stop-monitor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

beforeEach(() => {
  window.localStorage.clear();
  resetStopMonitorForTests();
});

afterEach(() => {
  cleanup();
  resetStopMonitorForTests();
});

describe("SpokenStopSettings", () => {
  it("is off by default and requires an explicit disclosure-backed enable", () => {
    render(<SpokenStopSettings />);

    const toggle = screen.getByTestId("stop-monitor-toggle");

    expect(toggle).toHaveProperty("checked", false);
    expect(screen.getByTestId("stop-monitor-state").textContent).toBe(
      "Vypnuto",
    );
    expect(
      screen.getByText(/Ve výchozím stavu je vypnuté/),
    ).toBeDefined();
    expect(
      screen.getByText(/ElevenLabs Scribe v2 Realtime/),
    ).toBeDefined();
    expect(screen.getByText(/max\. 180 s/)).toBeDefined();
    expect(screen.getByText(/až 0,0195 USD/)).toBeDefined();
    expect(
      screen.getByText(/Neukládá se zvuk ani přepis/),
    ).toBeDefined();
    expect(screen.getByText(/Doporučujeme sluchátka/)).toBeDefined();
    expect(
      screen.getByText(/druhý režim může zachytit zvuk čtení/),
    ).toBeDefined();

    fireEvent.click(toggle);

    expect(getStopMonitorPreferenceSnapshot()).toBe(true);
    expect(window.localStorage.getItem("ai-voice-notes:stop-monitor-enabled")).toBe(
      "true",
    );
    expect(screen.getByTestId("stop-monitor-state").textContent).toBe(
      "Zapnuto v tomto prohlížeči",
    );
  });

  it("shows and resets only aggregate trial statistics", () => {
    render(<SpokenStopSettings />);

    act(() => {
      recordStopMonitorAttempt();
      recordStopMonitorSuccess(620);
    });

    expect(screen.getByText("620 ms")).toBeDefined();
    expect(screen.getAllByText("1")).toHaveLength(2);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Vynulovat statistiky hlasového Stopu",
      }),
    );

    expect(screen.getByText("zatím neměřeno")).toBeDefined();
    expect(screen.queryByText("620 ms")).toBeNull();
  });
});
