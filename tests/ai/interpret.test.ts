import { describe, expect, it, vi } from "vitest";

import {
  AI_EDIT_SYSTEM_PROMPT,
  AI_SNIPPET_MAX_GRAPHEMES,
  AiInterpretError,
  buildAiEditPrompt,
  interpretAiEdit,
  isUndoCommand,
} from "../../src/lib/ai/edit-prompts";
import { StructuredLlmError } from "../../src/lib/ai/structured";
import { czechEditFixtures } from "../fixtures/czech-edits";

function fakeLlm(result: unknown) {
  const request = vi.fn().mockResolvedValue(result);

  return {
    request,
    service: { request } as unknown as Parameters<
      typeof interpretAiEdit
    >[0]["llm"],
  };
}

describe("P26 Czech edit fixtures", () => {
  it("contains at least 30 commands", () => {
    expect(czechEditFixtures.length).toBeGreaterThanOrEqual(30);
  });

  it.each(czechEditFixtures)(
    "builds a bounded JSON prompt and interprets $id",
    async (fixture) => {
      expect(fixture.command.trim().length).toBeGreaterThan(0);

      if (fixture.expected.kind === "undo") {
        expect(isUndoCommand(fixture.command)).toBe(true);
        const llm = fakeLlm({ kind: "unclear", clarification: "unused" });
        await expect(
          interpretAiEdit({
            noteTitle: fixture.noteTitle,
            command: fixture.command,
            snippet: fixture.snippet,
            llm: llm.service,
          }),
        ).resolves.toEqual({ kind: "undo" });
        expect(llm.request).not.toHaveBeenCalled();
        return;
      }

      expect(isUndoCommand(fixture.command)).toBe(false);
      const prompt = buildAiEditPrompt(fixture);
      const jsonStart = prompt.indexOf("{");
      const payload = JSON.parse(prompt.slice(jsonStart)) as {
        noteTitle: string;
        command: string;
        snippet: string;
      };

      expect(payload).toEqual({
        noteTitle: fixture.noteTitle,
        command: fixture.command,
        snippet: fixture.snippet,
      });
      expect(prompt).not.toContain("confidence");

      if (fixture.promptInjection) {
        expect(AI_EDIT_SYSTEM_PROMPT).toContain("prompt injection");
        expect(prompt).toContain("JSON");
        expect(
          prompt.includes("</SNIPPET>") || prompt.includes("Ignoruj"),
        ).toBe(true);
      }

      const llm = fakeLlm(fixture.expected);
      await expect(
        interpretAiEdit({
          noteTitle: fixture.noteTitle,
          command: fixture.command,
          snippet: fixture.snippet,
          llm: llm.service,
        }),
      ).resolves.toEqual(fixture.expected);
      expect(llm.request).toHaveBeenCalledWith({
        prompt,
        systemPrompt: AI_EDIT_SYSTEM_PROMPT,
      });
    },
  );
});

describe("P26 interpretation bounds and errors", () => {
  it("keeps the anti-injection rules and full operation grammar in the prompt", () => {
    expect(AI_EDIT_SYSTEM_PROMPT).toContain("prompt injection");
    expect(AI_EDIT_SYSTEM_PROMPT).toContain("JSON");
    expect(AI_EDIT_SYSTEM_PROMPT).not.toContain("confidence");

    expect(AI_EDIT_SYSTEM_PROMPT).toContain("Smazání jedné věty");
    expect(AI_EDIT_SYSTEM_PROMPT).toContain("replace_paragraph");
    expect(AI_EDIT_SYSTEM_PROMPT).toContain("delete_sentence");

    for (const operationType of [
      "replace_sentence",
      "insert_before_sentence",
      "insert_after_sentence",
      "delete_sentence",
      "insert_heading_before_sentence",
      "replace_last_sentence",
      "set_task_checked",
      "replace_paragraph",
      "append_bounded_section",
    ]) {
      expect(AI_EDIT_SYSTEM_PROMPT).toContain(operationType);
    }
  });

  it("rejects an oversized snippet before any LLM call", async () => {
    const llm = fakeLlm({ kind: "unclear", clarification: "unused" });

    await expect(
      interpretAiEdit({
        noteTitle: "Poznámka",
        command: "Nahraď první větu.",
        snippet: "a".repeat(AI_SNIPPET_MAX_GRAPHEMES + 1),
        llm: llm.service,
      }),
    ).rejects.toBeInstanceOf(AiInterpretError);
    expect(llm.request).not.toHaveBeenCalled();
  });

  it("rejects empty commands and snippets without calling the model", async () => {
    const llm = fakeLlm({ kind: "unclear", clarification: "unused" });

    await expect(
      interpretAiEdit({
        noteTitle: "Poznámka",
        command: " ",
        snippet: "Text.",
        llm: llm.service,
      }),
    ).rejects.toMatchObject({ code: "ai_command_empty" });

    await expect(
      interpretAiEdit({
        noteTitle: "Poznámka",
        command: "Nahraď první větu.",
        snippet: "",
        llm: llm.service,
      }),
    ).rejects.toMatchObject({ code: "ai_snippet_empty" });
    expect(llm.request).not.toHaveBeenCalled();
  });

  it("propagates bad model JSON as a Czech structured error without note mutation", async () => {
    const request = vi.fn().mockRejectedValue(
      new StructuredLlmError(
        502,
        "llm_malformed_json",
        "Model nevrátil platný JSON. AI úprava nebyla vytvořena.",
      ),
    );

    await expect(
      interpretAiEdit({
        noteTitle: "Poznámka",
        command: "Nahraď první větu.",
        snippet: "První věta.",
        llm: { request } as unknown as Parameters<
          typeof interpretAiEdit
        >[0]["llm"],
      }),
    ).rejects.toMatchObject({
      code: "llm_malformed_json",
      message: expect.stringContaining("JSON"),
    });
  });
});
