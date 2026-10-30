import { describe, expect, it } from "vitest";

import type {
  LlmEditResponse,
  LlmOperation,
} from "../../src/lib/ai/schemas";
import {
  StructuredLlmError,
  type StructuredLlmService,
} from "../../src/lib/ai/structured";
import type { SummaryResponse } from "../../src/lib/ai/summary";
import type { TaskSuggestionResponse } from "../../src/lib/ai/task-suggestions";
import { parseNoteMarkdown } from "../../src/lib/notes/markdown";
import {
  suggestMeetingSummaryDecisions,
  suggestMeetingTasks,
  type MeetingSuggestionNote,
} from "../../src/lib/meetings/suggestions";

function note(contentMd: string, version = 3): MeetingSuggestionNote {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Zápis ze schůzky",
    version,
    contentMd,
  };
}

interface FakeCalls {
  summary: number;
  decisions: number;
  tasks: number;
}

function fakeLlm(input: {
  readonly summary?: string | Error;
  readonly decision?: LlmEditResponse | Error;
  readonly tasks?: TaskSuggestionResponse | Error;
}): { service: Pick<StructuredLlmService, "requestSummary" | "request" | "requestTaskSuggestions">; calls: FakeCalls } {
  const calls: FakeCalls = { summary: 0, decisions: 0, tasks: 0 };
  const service = {
    async requestSummary(): Promise<SummaryResponse> {
      calls.summary += 1;

      if (input.summary instanceof Error) {
        throw input.summary;
      }

      return { summaryText: input.summary ?? "Shrnutí schůzky." };
    },
    async request(): Promise<LlmEditResponse> {
      calls.decisions += 1;

      if (input.decision instanceof Error) {
        throw input.decision;
      }

      return (
        input.decision ?? {
          kind: "operation",
          operation: {
            type: "append_bounded_section",
            text: "## Rozhodnutí\n\n- Projekt začne v pondělí.",
          },
        }
      );
    },
    async requestTaskSuggestions(): Promise<TaskSuggestionResponse> {
      calls.tasks += 1;

      if (input.tasks instanceof Error) {
        throw input.tasks;
      }

      return input.tasks ?? { tasks: [{ text: "Poslat zápis" }] };
    },
  };

  return { service, calls };
}

const saved = async () => true;
const notSaved = async () => false;

describe("meeting summary, decisions and tasks", () => {
  it("returns a bounded summary and a validated append-only decisions section", async () => {
    const content = "Petra: Projekt začne v pondělí.\n\nJan: Připravím zápis.";
    const llm = fakeLlm({});

    const result = await suggestMeetingSummaryDecisions({
      note: note(content),
      start: 0,
      end: content.length,
      llm: llm.service,
      isSavedMeeting: saved,
    });

    expect(result.summaryText).toBe("Shrnutí schůzky.");
    expect(result.decisionsText).toBe(
      "## Rozhodnutí\n\n- Projekt začne v pondělí.",
    );
    expect(result.decisionsError).toBeNull();
    expect(result.noteVersion).toBe(3);
    expect(result.summarySourceGraphemes).toBeGreaterThan(0);
    expect(result.decisionsSourceGraphemes).toBe(
      result.summarySourceGraphemes,
    );
    expect(llm.calls).toEqual({ summary: 1, decisions: 1, tasks: 0 });
  });

  it("refuses an unsaved note before any provider call", async () => {
    const llm = fakeLlm({});

    await expect(
      suggestMeetingSummaryDecisions({
        note: note("Text."),
        start: 0,
        end: 5,
        llm: llm.service,
        isSavedMeeting: notSaved,
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: "meeting_suggestion_not_saved",
    });

    await expect(
      suggestMeetingTasks({
        note: note("Text."),
        start: 0,
        end: 5,
        llm: llm.service,
        isSavedMeeting: notSaved,
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: "meeting_suggestion_not_saved",
    });

    expect(llm.calls).toEqual({ summary: 0, decisions: 0, tasks: 0 });
  });

  it("normalizes an inline heading and bullet from the model", async () => {
    const content = "Rozhodli jsme, že projekt začne v pondělí 3. listopadu.";
    const llm = fakeLlm({
      decision: {
        kind: "operation",
        operation: {
          type: "append_bounded_section",
          text: "## Rozhodnutí  - Projekt začne v pondělí 3. listopadu.",
        },
      },
    });

    const result = await suggestMeetingSummaryDecisions({
      note: note(content),
      start: 0,
      end: content.length,
      llm: llm.service,
      isSavedMeeting: saved,
    });

    expect(result.decisionsError).toBeNull();
    expect(result.decisionsText).toBe(
      "## Rozhodnutí\n\n- Projekt začne v pondělí 3. listopadu.",
    );
  });

  it("normalizes a non-breaking space between the heading and inline bullet", async () => {
    const content = "Rozhodli jsme, že projekt začne v pondělí 3. listopadu.";
    const llm = fakeLlm({
      decision: {
        kind: "operation",
        operation: {
          type: "append_bounded_section",
          text: "## Rozhodnutí\u00a0- Projekt začne v pondělí 3. listopadu.",
        },
      },
    });

    const result = await suggestMeetingSummaryDecisions({
      note: note(content),
      start: 0,
      end: content.length,
      llm: llm.service,
      isSavedMeeting: saved,
    });

    expect(result.decisionsError).toBeNull();
    expect(result.decisionsText).toBe(
      "## Rozhodnutí\n\n- Projekt začne v pondělí 3. listopadu.",
    );
  });

  it("rejects a no-bullet section even when it contains a spaced asterisk", async () => {
    const content = "Cena projektu je 100 Kč.";
    const llm = fakeLlm({
      decision: {
        kind: "operation",
        operation: {
          type: "append_bounded_section",
          text: "## Rozhodnutí\n\nCena * 100 Kč.",
        },
      },
    });

    const result = await suggestMeetingSummaryDecisions({
      note: note(content),
      start: 0,
      end: content.length,
      llm: llm.service,
      isSavedMeeting: saved,
    });

    expect(result.summaryText).toBe("Shrnutí schůzky.");
    expect(result.decisionsText).toBeNull();
    expect(result.decisionsError).toMatchObject({
      code: "meeting_decisions_invalid",
    });
  });

  it("returns the paid summary with an explicit unclear-decisions error", async () => {
    const content = "Petra: Uvidíme.";
    const llm = fakeLlm({
      decision: {
        kind: "unclear",
        clarification: "Rozhodnutí není v textu potvrzené.",
      },
    });

    const result = await suggestMeetingSummaryDecisions({
      note: note(content),
      start: 0,
      end: content.length,
      llm: llm.service,
      isSavedMeeting: saved,
    });

    expect(result.summaryText).toBe("Shrnutí schůzky.");
    expect(result.decisionsText).toBeNull();
    expect(result.decisionsError).toMatchObject({
      code: "meeting_decisions_unclear",
    });
    expect(llm.calls).toEqual({ summary: 1, decisions: 1, tasks: 0 });
  });

  it("returns the summary when decisions are non-append or lack the heading", async () => {
    const content = "Petra: Projekt začne v pondělí.";
    const nonAppend: LlmEditResponse = {
      kind: "operation",
      operation: {
        type: "replace_last_sentence",
        text: "Jiný text.",
      } satisfies LlmOperation,
    };
    const llm = fakeLlm({ decision: nonAppend });

    const nonAppendResult = await suggestMeetingSummaryDecisions({
      note: note(content),
      start: 0,
      end: content.length,
      llm: llm.service,
      isSavedMeeting: saved,
    });

    expect(nonAppendResult.summaryText).toBe("Shrnutí schůzky.");
    expect(nonAppendResult.decisionsText).toBeNull();
    expect(nonAppendResult.decisionsError).toMatchObject({
      code: "meeting_decisions_invalid",
    });

    const noHeading = fakeLlm({
      decision: {
        kind: "operation",
        operation: {
          type: "append_bounded_section",
          text: "- Projekt začne v pondělí.",
        },
      },
    });

    const noHeadingResult = await suggestMeetingSummaryDecisions({
      note: note(content),
      start: 0,
      end: content.length,
      llm: noHeading.service,
      isSavedMeeting: saved,
    });

    expect(noHeadingResult.summaryText).toBe("Shrnutí schůzky.");
    expect(noHeadingResult.decisionsText).toBeNull();
    expect(noHeadingResult.decisionsError).toMatchObject({
      code: "meeting_decisions_invalid",
    });
  });

  it("rejects an invented speaker label when the source has no speaker ids", async () => {
    const content = "Projekt začne v pondělí.";
    const llm = fakeLlm({
      decision: {
        kind: "operation",
        operation: {
          type: "append_bounded_section",
          text: "## Rozhodnutí\n\n- Mluvčí 1 rozhodl, že projekt začne v pondělí.",
        },
      },
    });

    const result = await suggestMeetingSummaryDecisions({
      note: note(content),
      start: 0,
      end: content.length,
      llm: llm.service,
      isSavedMeeting: saved,
    });

    expect(result.summaryText).toBe("Shrnutí schůzky.");
    expect(result.decisionsText).toBeNull();
    expect(result.decisionsError).toMatchObject({
      code: "meeting_decisions_invented_speaker",
    });
  });

  it("rejects an over-limit summary source before the decisions call", async () => {
    const content = "x".repeat(8_001);
    const llm = fakeLlm({});

    await expect(
      suggestMeetingSummaryDecisions({
        note: note(content),
        start: 0,
        end: content.length,
        llm: llm.service,
        isSavedMeeting: saved,
      }),
    ).rejects.toMatchObject({ code: "summary_source_too_large" });

    expect(llm.calls.decisions).toBe(0);
  });

  it("does not call decisions when the summary provider fails and leaves the note untouched", async () => {
    const content = "Petra: Projekt začne v pondělí.";
    const llm = fakeLlm({ summary: new Error("provider down") });

    await expect(
      suggestMeetingSummaryDecisions({
        note: note(content),
        start: 0,
        end: content.length,
        llm: llm.service,
        isSavedMeeting: saved,
      }),
    ).rejects.toThrow("provider down");

    expect(llm.calls).toEqual({ summary: 1, decisions: 0, tasks: 0 });
    expect(content).toBe("Petra: Projekt začne v pondělí.");
  });

  it("keeps the paid summary when the decisions provider fails", async () => {
    const content = "Petra: Projekt začne v pondělí.";
    const llm = fakeLlm({
      decision: new StructuredLlmError(502, "llm_error", "decisions down"),
    });

    const result = await suggestMeetingSummaryDecisions({
      note: note(content),
      start: 0,
      end: content.length,
      llm: llm.service,
      isSavedMeeting: saved,
    });

    expect(result.summaryText).toBe("Shrnutí schůzky.");
    expect(result.decisionsText).toBeNull();
    expect(result.decisionsError).toMatchObject({
      code: "meeting_decisions_unavailable",
    });
    expect(llm.calls).toEqual({ summary: 1, decisions: 1, tasks: 0 });
  });

  it("flags tasks already present in the saved note and deduplicates provider repeats", async () => {
    const content = [
      "Petra: Pošleme zápis.",
      "",
      "- [ ] Poslat zápis",
    ].join("\n");
    const llm = fakeLlm({
      tasks: {
        tasks: [{ text: "Poslat zápis" }, { text: "Poslat zápis" }],
      },
    });

    const result = await suggestMeetingTasks({
      note: note(content),
      start: 0,
      end: parseNoteMarkdown(content).plainText.length,
      llm: llm.service,
      isSavedMeeting: saved,
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      text: "Poslat zápis",
      duplicate: true,
    });
    expect(llm.calls.tasks).toBe(1);
  });

  it("propagates a task provider failure without changing the transcript", async () => {
    const content = "Petra: Pošleme zápis.";
    const llm = fakeLlm({ tasks: new Error("provider down") });

    await expect(
      suggestMeetingTasks({
        note: note(content),
        start: 0,
        end: content.length,
        llm: llm.service,
        isSavedMeeting: saved,
      }),
    ).rejects.toThrow("provider down");

    expect(content).toBe("Petra: Pošleme zápis.");
  });
});
