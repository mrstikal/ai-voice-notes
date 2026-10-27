export type InlineMark = "strong" | "emphasis";
export type VoiceListVariant = "bullet" | "task";

export type VoiceCommand =
  | { readonly type: "paragraph_break"; readonly normalized: "novy odstavec" }
  | { readonly type: "line_break"; readonly normalized: "novy radek" }
  | {
      readonly type: "heading";
      readonly normalized: "nadpis" | "nadpis prvni urovne" | "nadpis druhe urovne";
      readonly depth: 1 | 2;
    }
  | { readonly type: "strong_start"; readonly normalized: "tucne" }
  | { readonly type: "strong_end"; readonly normalized: "konec tucne" }
  | { readonly type: "emphasis_start"; readonly normalized: "kurzivou" }
  | { readonly type: "emphasis_end"; readonly normalized: "konec kurzivou" }
  | {
      readonly type: "list_start";
      readonly normalized: "zacni seznam" | "zacni ukoly";
      readonly variant: VoiceListVariant;
    }
  | {
      readonly type: "list_next";
      readonly normalized: "dalsi polozka" | "dalsi ukol";
      readonly variant: VoiceListVariant;
    }
  | {
      readonly type: "list_end";
      readonly normalized: "konec seznamu" | "konec ukolu";
      readonly variant: VoiceListVariant;
    }
  | { readonly type: "stop"; readonly normalized: "stop" }
  | { readonly type: "literal"; readonly normalized: "doslova" };

export const VOICE_COMMANDS: readonly VoiceCommand[] = [
  { type: "paragraph_break", normalized: "novy odstavec" },
  { type: "line_break", normalized: "novy radek" },
  { type: "heading", normalized: "nadpis", depth: 2 },
  { type: "heading", normalized: "nadpis prvni urovne", depth: 1 },
  { type: "heading", normalized: "nadpis druhe urovne", depth: 2 },
  { type: "strong_start", normalized: "tucne" },
  { type: "strong_end", normalized: "konec tucne" },
  { type: "emphasis_start", normalized: "kurzivou" },
  { type: "emphasis_end", normalized: "konec kurzivou" },
  { type: "list_start", normalized: "zacni seznam", variant: "bullet" },
  { type: "list_next", normalized: "dalsi polozka", variant: "bullet" },
  { type: "list_end", normalized: "konec seznamu", variant: "bullet" },
  { type: "list_start", normalized: "zacni ukoly", variant: "task" },
  { type: "list_next", normalized: "dalsi ukol", variant: "task" },
  { type: "list_end", normalized: "konec ukolu", variant: "task" },
  { type: "stop", normalized: "stop" },
  { type: "literal", normalized: "doslova" },
];

export const MAX_VOICE_COMMAND_LENGTH = Math.max(
  ...VOICE_COMMANDS.map((command) => command.normalized.length),
);

export const HEADING_MAX_GRAPHEMES = 160;

export function normalizeVoiceText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

export function matchVoiceCommand(text: string): VoiceCommand | null {
  const normalized = normalizeVoiceText(text);

  return (
    VOICE_COMMANDS.find((command) => command.normalized === normalized) ??
    null
  );
}

export function findLongerVoiceCommand(
  prefix: string,
  next: string,
): { readonly command: VoiceCommand; readonly joinedText: string } | null {
  const normalizedPrefix = normalizeVoiceText(prefix);
  const normalizedNext = normalizeVoiceText(next);

  if (normalizedPrefix === "" || normalizedNext === "") {
    return null;
  }

  const candidates = [
    {
      text: `${prefix}${next}`,
      normalized: `${normalizedPrefix}${normalizedNext}`,
    },
    {
      text: `${prefix} ${next}`,
      normalized: `${normalizedPrefix} ${normalizedNext}`,
    },
  ];

  for (const candidate of candidates) {
    const command = VOICE_COMMANDS.find(
      (entry) =>
        entry.normalized === candidate.normalized &&
        entry.normalized.length > normalizedPrefix.length,
    );

    if (command) {
      return { command, joinedText: candidate.text };
    }
  }

  return null;
}

export function isPossibleVoiceCommandPrefix(text: string): boolean {
  const normalized = normalizeVoiceText(text);

  if (normalized === "" || normalized.length > MAX_VOICE_COMMAND_LENGTH) {
    return false;
  }

  return VOICE_COMMANDS.some(
    (command) =>
      command.normalized.length > normalized.length &&
      command.normalized.startsWith(normalized),
  );
}

export interface VoiceClause {
  readonly text: string;
  readonly delimiter: string;
  readonly raw: string;
}

const CLAUSE_PUNCTUATION = new Set([".", "!", "?", ",", ";", ":", "…"]);

export function splitVoiceClauses(segment: string): VoiceClause[] {
  if (segment.trim() === "") {
    return [];
  }

  const clauses: VoiceClause[] = [];
  let start = 0;

  for (let index = 0; index < segment.length; index += 1) {
    if (!CLAUSE_PUNCTUATION.has(segment[index]!)) {
      continue;
    }

    let end = index;

    while (
      end + 1 < segment.length &&
      CLAUSE_PUNCTUATION.has(segment[end + 1]!)
    ) {
      end += 1;
    }

    const next = segment[end + 1];

    if (next !== undefined && !/\s/u.test(next)) {
      index = end;
      continue;
    }

    const raw = segment.slice(start, end + 1);
    const delimiter = segment.slice(index, end + 1);
    const text = raw.slice(0, raw.length - delimiter.length).trim();

    clauses.push({ text, delimiter, raw: raw.trim() });
    start = end + 1;
    index = end;
  }

  if (start < segment.length) {
    const raw = segment.slice(start).trim();

    if (raw !== "") {
      clauses.push({ text: raw, delimiter: "", raw });
    }
  }

  return clauses;
}

export interface PendingHeading {
  readonly depth: 1 | 2;
  readonly commandText: string;
}

export interface PendingLiteral {
  readonly commandText: string;
}

export interface PendingPrefix {
  readonly text: string;
  readonly exactCommand: VoiceCommand | null;
}

export interface VoiceFormatState {
  readonly marks: readonly InlineMark[];
  readonly listVariant: VoiceListVariant | null;
  readonly listItemOpen: boolean;
  readonly pendingHeading: PendingHeading | null;
  readonly pendingLiteral: PendingLiteral | null;
  readonly pendingPrefix: PendingPrefix | null;
}

export const INITIAL_VOICE_FORMAT_STATE: VoiceFormatState = {
  marks: [],
  listVariant: null,
  listItemOpen: false,
  pendingHeading: null,
  pendingLiteral: null,
  pendingPrefix: null,
};

const MARK_ORDER: readonly InlineMark[] = ["strong", "emphasis"];

export function sortInlineMarks(
  marks: Iterable<InlineMark>,
): readonly InlineMark[] {
  const set = new Set(marks);
  return MARK_ORDER.filter((mark) => set.has(mark));
}

export function stripTrailingSentencePunctuation(value: string): string {
  return value.replace(/[.!?…]+$/u, "").trimEnd();
}

export function addInlineMark(
  marks: readonly InlineMark[],
  mark: InlineMark,
): readonly InlineMark[] {
  return sortInlineMarks([...marks, mark]);
}

export function removeInlineMark(
  marks: readonly InlineMark[],
  mark: InlineMark,
): readonly InlineMark[] {
  return marks.filter((entry) => entry !== mark);
}
