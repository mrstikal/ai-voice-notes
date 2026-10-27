import { describe, expect, it } from "vitest";

import {
  flushVoiceCommands,
  parseVoiceCommands,
  type VoiceInstruction,
} from "../../src/lib/voice/commands";
import {
  INITIAL_VOICE_FORMAT_STATE,
  stripTrailingSentencePunctuation,
} from "../../src/lib/voice/format-state";
import { CZECH_COMMAND_FIXTURES } from "../fixtures/czech-commands";

function runFixture(fixture: (typeof CZECH_COMMAND_FIXTURES)[number]) {
  let state = INITIAL_VOICE_FORMAT_STATE;
  const instructions: VoiceInstruction[] = [];

  for (const segment of fixture.segments) {
    const result = parseVoiceCommands(segment, state);
    instructions.push(...result.instructions);
    state = result.state;

    if (result.stopped) {
      break;
    }
  }

  if (fixture.flush) {
    const flushed = flushVoiceCommands(state);
    instructions.push(...flushed.instructions);
    state = flushed.state;
  }

  return { instructions, state };
}

function composeListItems(
  instructions: readonly VoiceInstruction[],
): string[] {
  const items: string[] = [];
  let current: string | null = null;

  for (const instruction of instructions) {
    switch (instruction.kind) {
      case "list_item":
        if (current !== null) {
          items.push(current);
        }
        current = instruction.text;
        break;
      case "list_item_text":
        if (current !== null) {
          current = `${current} ${instruction.text}`;
        }
        break;
      case "list_end":
        if (current !== null) {
          items.push(current);
          current = null;
        }
        break;
      default:
        break;
    }
  }

  if (current !== null) {
    items.push(current);
  }

  return items;
}

describe("Czech formatting grammar", () => {
  it("ships at least 30 pure fixtures", () => {
    expect(CZECH_COMMAND_FIXTURES.length).toBeGreaterThanOrEqual(30);
  });

  for (const fixture of CZECH_COMMAND_FIXTURES) {
    it(fixture.name, () => {
      expect(runFixture(fixture).instructions).toEqual(fixture.expected);
    });
  }

  it("flush resets marks, list mode and pending state", () => {
    const bold = parseVoiceCommands("Tučně.", INITIAL_VOICE_FORMAT_STATE);
    const list = parseVoiceCommands(
      "Začni seznam.",
      bold.state,
    );
    const pending = parseVoiceCommands("Nad", list.state);
    const flushed = flushVoiceCommands(pending.state);

    expect(flushed.instructions).toEqual([
      {
        kind: "list_item",
        variant: "bullet",
        text: "Nad",
        marks: ["strong"],
      },
      { kind: "list_end", variant: "bullet" },
    ]);
    expect(flushed.state).toEqual(INITIAL_VOICE_FORMAT_STATE);
  });

  it("keeps marks active across committed segments", () => {
    const first = parseVoiceCommands("Tučně.", INITIAL_VOICE_FORMAT_STATE);
    const second = parseVoiceCommands("První.", first.state);
    const third = parseVoiceCommands("Druhý.", second.state);

    expect(second.instructions).toEqual([
      { kind: "text", text: "První.", marks: ["strong"] },
    ]);
    expect(third.instructions).toEqual([
      { kind: "text", text: "Druhý.", marks: ["strong"] },
    ]);
  });

  it("composes list items and trims only the final item punctuation", () => {
    const scriptA = CZECH_COMMAND_FIXTURES.find(
      (fixture) =>
        fixture.name === "Script A produces the expected semantic instructions",
    );
    const multiSentence = CZECH_COMMAND_FIXTURES.find(
      (fixture) =>
        fixture.name ===
        "multi-sentence list item preserves the interior sentence boundary",
    );

    expect(scriptA).toBeDefined();
    expect(multiSentence).toBeDefined();

    const scriptAItems = composeListItems(scriptA!.expected);
    expect(scriptAItems).toEqual([
      "Připravit migrace.",
      "Napsat testy.",
    ]);
    expect(scriptAItems.map(stripTrailingSentencePunctuation)).toEqual([
      "Připravit migrace",
      "Napsat testy",
    ]);

    const multiItems = composeListItems(multiSentence!.expected);
    expect(multiItems).toEqual(["Koupit mléko. Chléb."]);
    expect(multiItems.map(stripTrailingSentencePunctuation)).toEqual([
      "Koupit mléko. Chléb",
    ]);
  });

  it("keeps clause punctuation while stripping only sentence-final punctuation", () => {
    expect(stripTrailingSentencePunctuation("Text.")).toBe("Text");
    expect(stripTrailingSentencePunctuation("Text!")).toBe("Text");
    expect(stripTrailingSentencePunctuation("Text?")).toBe("Text");
    expect(stripTrailingSentencePunctuation("Text…")).toBe("Text");
    expect(stripTrailingSentencePunctuation("Text,")).toBe("Text,");
    expect(stripTrailingSentencePunctuation("Text;")).toBe("Text;");
    expect(stripTrailingSentencePunctuation("Text:")).toBe("Text:");
  });

  it("resets the format state when a stop command is recognized", () => {
    const result = parseVoiceCommands(
      "Tučně. Stop.",
      INITIAL_VOICE_FORMAT_STATE,
    );

    expect(result.stopped).toBe(true);
    expect(result.state).toEqual(INITIAL_VOICE_FORMAT_STATE);
    expect(result.instructions).toEqual([{ kind: "stop" }]);
  });

  it("never treats an embedded stop word as the stop command", () => {
    const result = parseVoiceCommands(
      "Řekl jsem slovo stop a pokračoval.",
      INITIAL_VOICE_FORMAT_STATE,
    );

    expect(result.stopped).toBe(false);
    expect(result.instructions).toEqual([
      {
        kind: "text",
        text: "Řekl jsem slovo stop a pokračoval.",
        marks: [],
      },
    ]);
  });
});
