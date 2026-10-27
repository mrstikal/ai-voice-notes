import type {
  VoiceInstruction,
} from "../../src/lib/voice/commands";
import type {
  InlineMark,
  VoiceListVariant,
} from "../../src/lib/voice/format-state";

export interface CzechCommandFixture {
  readonly name: string;
  readonly segments: readonly string[];
  readonly expected: readonly VoiceInstruction[];
  readonly flush?: boolean;
}

const text = (
  value: string,
  marks: readonly InlineMark[] = [],
): VoiceInstruction => ({ kind: "text", text: value, marks });

const heading = (depth: 1 | 2, value: string): VoiceInstruction => ({
  kind: "heading",
  depth,
  text: value,
});

const paragraphBreak = (): VoiceInstruction => ({ kind: "paragraph_break" });
const lineBreak = (): VoiceInstruction => ({ kind: "line_break" });
const stop = (): VoiceInstruction => ({ kind: "stop" });

const listStart = (variant: VoiceListVariant): VoiceInstruction => ({
  kind: "list_start",
  variant,
});

const listItem = (
  variant: VoiceListVariant,
  value: string,
  marks: readonly InlineMark[] = [],
): VoiceInstruction => ({
  kind: "list_item",
  variant,
  text: value,
  marks,
});

const listItemText = (
  value: string,
  marks: readonly InlineMark[] = [],
): VoiceInstruction => ({
  kind: "list_item_text",
  text: value,
  marks,
});

const listEnd = (variant: VoiceListVariant): VoiceInstruction => ({
  kind: "list_end",
  variant,
});

const scriptA = [
  "Nadpis.",
  "Plán migrace.",
  "Nový odstavec.",
  "V první fázi ověříme databázi.",
  "Nový odstavec.",
  "Tučně.",
  "Pozor na kompatibilitu API.",
  "Konec tučně.",
  "Začni úkoly.",
  "Připravit migrace.",
  "Další úkol.",
  "Napsat testy.",
  "Konec úkolů.",
] as const;

export const CZECH_COMMAND_FIXTURES: readonly CzechCommandFixture[] = [
  {
    name: "plain dictated text keeps its punctuation",
    segments: ["Ahoj světe."],
    expected: [text("Ahoj světe.")],
  },
  {
    name: "new paragraph creates a paragraph break",
    segments: ["První.", "Nový odstavec.", "Druhý."],
    expected: [text("První."), paragraphBreak(), text("Druhý.")],
  },
  {
    name: "new line creates a line break",
    segments: ["První.", "Nový řádek.", "Druhý."],
    expected: [text("První."), lineBreak(), text("Druhý.")],
  },
  {
    name: "default heading is H2 and consumes the next clause",
    segments: ["Nadpis.", "Plán migrace."],
    expected: [heading(2, "Plán migrace")],
  },
  {
    name: "heading first level is H1",
    segments: ["Nadpis první úrovně.", "Hlavní nadpis."],
    expected: [heading(1, "Hlavní nadpis")],
  },
  {
    name: "heading second level is explicit H2",
    segments: ["Nadpis druhé úrovně.", "Vedlejší nadpis."],
    expected: [heading(2, "Vedlejší nadpis")],
  },
  {
    name: "bold mode marks only its span",
    segments: ["Tučně.", "Důležité.", "Konec tučně.", "Normální."],
    expected: [text("Důležité.", ["strong"]), text("Normální.")],
  },
  {
    name: "italic mode marks only its span",
    segments: ["Kurzivou.", "Důležité.", "Konec kurzivou.", "Normální."],
    expected: [text("Důležité.", ["emphasis"]), text("Normální.")],
  },
  {
    name: "bold and italic nest and end independently",
    segments: [
      "Tučně.",
      "Kurzivou.",
      "Obojí.",
      "Konec tučně.",
      "Jen kurzíva.",
      "Konec kurzivou.",
    ],
    expected: [
      text("Obojí.", ["strong", "emphasis"]),
      text("Jen kurzíva.", ["emphasis"]),
    ],
  },
  {
    name: "repeated mark commands are idempotent",
    segments: [
      "Tučně.",
      "Tučně.",
      "Text.",
      "Konec tučně.",
      "Konec tučně.",
    ],
    expected: [text("Text.", ["strong"])],
  },
  {
    name: "bullet list uses explicit next item",
    segments: [
      "Začni seznam.",
      "První.",
      "Další položka.",
      "Druhá.",
      "Konec seznamu.",
    ],
    expected: [
      listStart("bullet"),
      listItem("bullet", "První."),
      listItem("bullet", "Druhá."),
      listEnd("bullet"),
    ],
  },
  {
    name: "task list follows Script A",
    segments: [
      "Začni úkoly.",
      "Připravit migrace.",
      "Další úkol.",
      "Napsat testy.",
      "Konec úkolů.",
    ],
    expected: [
      listStart("task"),
      listItem("task", "Připravit migrace."),
      listItem("task", "Napsat testy."),
      listEnd("task"),
    ],
  },
  {
    name: "list continuation stays in one item",
    segments: [
      "Začni seznam.",
      "První část.",
      "Pokračování.",
      "Další položka.",
      "Druhá.",
      "Konec seznamu.",
    ],
    expected: [
      listStart("bullet"),
      listItem("bullet", "První část."),
      listItemText("Pokračování."),
      listItem("bullet", "Druhá."),
      listEnd("bullet"),
    ],
  },
  {
    name: "doslova keeps a command word as literal text",
    segments: ["Doslova stop."],
    expected: [text("stop.")],
  },
  {
    name: "doslova applies to the next clause",
    segments: ["Doslova.", "Stop."],
    expected: [text("Stop.")],
  },
  {
    name: "doslova prevents a heading command",
    segments: ["Doslova.", "Nadpis."],
    expected: [text("Nadpis.")],
  },
  {
    name: "standalone stop ends processing and ignores later clauses",
    segments: ["Text.", "Stop.", "Po stopu."],
    expected: [text("Text."), stop()],
  },
  {
    name: "embedded stop word remains dictated text",
    segments: ["Slovo stop použijeme v ukázce"],
    expected: [text("Slovo stop použijeme v ukázce")],
  },
  {
    name: "stop inside a normal sentence remains dictated text",
    segments: ["Ve větě je slovo stop."],
    expected: [text("Ve větě je slovo stop.")],
  },
  {
    name: "split command prefix joins the next segment",
    segments: ["Nad", "pis.", "Plán."],
    expected: [heading(2, "Plán")],
  },
  {
    name: "split exact heading command joins a longer H1 command",
    segments: ["Nadpis", "první úrovně.", "Hlavní."],
    expected: [heading(1, "Hlavní")],
  },
  {
    name: "split heading command joins across multiple segments",
    segments: ["Nadpis", "první", "úrovně.", "Hlavní."],
    expected: [heading(1, "Hlavní")],
  },
  {
    name: "failed split prefix flushes literally",
    segments: ["Začni", "text."],
    expected: [text("Začni"), text("text.")],
  },
  {
    name: "diacritics in heading commands",
    segments: ["Nadpis první úrovně.", "Český nadpis."],
    expected: [heading(1, "Český nadpis")],
  },
  {
    name: "heading commands also match without diacritics",
    segments: ["Nadpis prvni urovne.", "Hlavni."],
    expected: [heading(1, "Hlavni")],
  },
  {
    name: "commands are case insensitive",
    segments: ["NADPIS PRVNÍ ÚROVNĚ.", "Hlavní."],
    expected: [heading(1, "Hlavní")],
  },
  {
    name: "overlong heading text preserves the heading command word without a heading",
    segments: ["Nadpis.", `${"a".repeat(161)}.`],
    expected: [
      text("Nadpis."),
      text(`${"a".repeat(161)}.`),
    ],
  },
  {
    name: "unclosed heading before stop is preserved literally",
    segments: ["Nadpis.", "Stop."],
    expected: [text("Nadpis."), stop()],
  },
  {
    name: "unexpected list end is preserved literally",
    segments: ["Konec seznamu."],
    expected: [text("Konec seznamu.")],
  },
  {
    name: "mismatched list next becomes list text",
    segments: [
      "Začni úkoly.",
      "Další položka.",
      "Text.",
      "Konec úkolů.",
    ],
    expected: [
      listStart("task"),
      listItem("task", "Další položka."),
      listItemText("Text."),
      listEnd("task"),
    ],
  },
  {
    name: "stop closes an open list before stopping",
    segments: ["Začni úkoly.", "Úkol.", "Stop."],
    expected: [
      listStart("task"),
      listItem("task", "Úkol."),
      listEnd("task"),
      stop(),
    ],
  },
  {
    name: "flush closes an open list",
    segments: ["Začni seznam.", "Položka."],
    flush: true,
    expected: [
      listStart("bullet"),
      listItem("bullet", "Položka."),
      listEnd("bullet"),
    ],
  },
  {
    name: "flush preserves a pending command prefix literally",
    segments: ["Nad"],
    flush: true,
    expected: [text("Nad")],
  },
  {
    name: "flush preserves a pending heading command literally",
    segments: ["Nadpis."],
    flush: true,
    expected: [text("Nadpis.")],
  },
  {
    name: "flush preserves a pending doslova command literally",
    segments: ["Doslova."],
    flush: true,
    expected: [text("Doslova.")],
  },
  {
    name: "pending exact heading command resolves with plain heading text",
    segments: ["Nadpis", "Plán migrace."],
    expected: [heading(2, "Plán migrace")],
  },
  {
    name: "split H2 prefix continues into an H1 command",
    segments: ["Nad", "pis", "první úrovně.", "Hlavní."],
    expected: [heading(1, "Hlavní")],
  },
  {
    name: "whole-segment heading command without punctuation",
    segments: ["Nadpis první úrovně", "Hlavní."],
    expected: [heading(1, "Hlavní")],
  },
  {
    name: "whole-segment stop without punctuation",
    segments: ["Stop"],
    expected: [stop()],
  },
  {
    name: "normal sentence containing command words stays literal",
    segments: ["Nový odstavec není příkaz."],
    expected: [text("Nový odstavec není příkaz.")],
  },
  {
    name: "failed split prefix preserves all following non-command words",
    segments: ["Nad", "není příkaz."],
    flush: true,
    expected: [text("Nad"), text("není příkaz.")],
  },
  {
    name: "internal comma in a list item is preserved",
    segments: [
      "Začni seznam.",
      "Připravit migrace, do pátku.",
      "Konec seznamu.",
    ],
    expected: [
      listStart("bullet"),
      listItem("bullet", "Připravit migrace,"),
      listItemText("do pátku."),
      listEnd("bullet"),
    ],
  },
  {
    name: "heading closes an open list",
    segments: [
      "Začni seznam.",
      "Položka.",
      "Nadpis.",
      "Nadpis text.",
    ],
    expected: [
      listStart("bullet"),
      listItem("bullet", "Položka."),
      listEnd("bullet"),
      heading(2, "Nadpis text"),
    ],
  },
  {
    name: "repeated list start is idempotent",
    segments: [
      "Začni seznam.",
      "Začni seznam.",
      "Položka.",
      "Konec seznamu.",
    ],
    expected: [
      listStart("bullet"),
      listItem("bullet", "Položka."),
      listEnd("bullet"),
    ],
  },
  {
    name: "switching list variant closes the previous list",
    segments: [
      "Začni seznam.",
      "Položka.",
      "Začni úkoly.",
      "Úkol.",
      "Konec úkolů.",
    ],
    expected: [
      listStart("bullet"),
      listItem("bullet", "Položka."),
      listEnd("bullet"),
      listStart("task"),
      listItem("task", "Úkol."),
      listEnd("task"),
    ],
  },
  {
    name: "doslova keeps active bold marks",
    segments: ["Tučně.", "Doslova stop.", "Konec tučně."],
    expected: [text("stop.", ["strong"])],
  },
  {
    name: "doslova inside a list becomes item text",
    segments: [
      "Začni seznam.",
      "Doslova nadpis.",
      "Konec seznamu.",
    ],
    expected: [
      listStart("bullet"),
      listItem("bullet", "nadpis."),
      listEnd("bullet"),
    ],
  },
  {
    name: "multi-sentence list item preserves the interior sentence boundary",
    segments: [
      "Začni seznam.",
      "Koupit mléko.",
      "Chléb.",
      "Konec seznamu.",
    ],
    expected: [
      listStart("bullet"),
      listItem("bullet", "Koupit mléko."),
      listItemText("Chléb."),
      listEnd("bullet"),
    ],
  },
  {
    name: "split doslova marker still protects the next clause",
    segments: ["Doslov", "a", "stop."],
    expected: [text("stop.")],
  },
  {
    name: "Script A produces the expected semantic instructions",
    segments: scriptA,
    expected: [
      heading(2, "Plán migrace"),
      paragraphBreak(),
      text("V první fázi ověříme databázi."),
      paragraphBreak(),
      text("Pozor na kompatibilitu API.", ["strong"]),
      listStart("task"),
      listItem("task", "Připravit migrace."),
      listItem("task", "Napsat testy."),
      listEnd("task"),
    ],
  },
  {
    name: "stop in the middle of a segment ignores trailing text",
    segments: ["Text. Stop. Další."],
    expected: [text("Text."), stop()],
  },
  {
    name: "next item command without a list starts the list",
    segments: ["Další úkol.", "Úkol."],
    expected: [
      listStart("task"),
      listItem("task", "Úkol."),
    ],
  },
  {
    name: "paragraph break closes an open list",
    segments: [
      "Začni seznam.",
      "Položka.",
      "Nový odstavec.",
      "Text.",
    ],
    expected: [
      listStart("bullet"),
      listItem("bullet", "Položka."),
      listEnd("bullet"),
      paragraphBreak(),
      text("Text."),
    ],
  },
  {
    name: "line break stays inside the current list item",
    segments: [
      "Začni seznam.",
      "Položka.",
      "Nový řádek.",
      "Pokračování.",
      "Konec seznamu.",
    ],
    expected: [
      listStart("bullet"),
      listItem("bullet", "Položka."),
      lineBreak(),
      listItemText("Pokračování."),
      listEnd("bullet"),
    ],
  },
];
