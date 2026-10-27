import { countGraphemes } from "@/lib/notes/limits";

import {
  HEADING_MAX_GRAPHEMES,
  INITIAL_VOICE_FORMAT_STATE,
  addInlineMark,
  findLongerVoiceCommand,
  isPossibleVoiceCommandPrefix,
  matchVoiceCommand,
  removeInlineMark,
  splitVoiceClauses,
  type InlineMark,
  type PendingHeading,
  type PendingLiteral,
  type PendingPrefix,
  type VoiceClause,
  type VoiceCommand,
  type VoiceFormatState,
  type VoiceListVariant,
} from "./format-state";

export type VoiceInstruction =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly marks: readonly InlineMark[];
    }
  | { readonly kind: "line_break" }
  | { readonly kind: "paragraph_break" }
  | {
      readonly kind: "heading";
      readonly depth: 1 | 2;
      readonly text: string;
    }
  | {
      readonly kind: "list_start";
      readonly variant: VoiceListVariant;
    }
  | {
      readonly kind: "list_item";
      readonly variant: VoiceListVariant;
      readonly text: string;
      readonly marks: readonly InlineMark[];
    }
  | {
      readonly kind: "list_item_text";
      readonly text: string;
      readonly marks: readonly InlineMark[];
    }
  | {
      readonly kind: "list_end";
      readonly variant: VoiceListVariant;
    }
  | { readonly kind: "stop" };

export interface ParseVoiceCommandsResult {
  readonly instructions: readonly VoiceInstruction[];
  readonly state: VoiceFormatState;
  readonly stopped: boolean;
}

export interface FlushVoiceCommandsResult {
  readonly instructions: readonly VoiceInstruction[];
  readonly state: VoiceFormatState;
}

export interface TaskStateVoiceCommand {
  readonly taskText: string;
  readonly checked: boolean;
}

const TASK_DONE_PATTERN =
  /^\s*ozna[cč](?:it)?\s+[úu]kol(?:u)?\s+(.+?)\s+jako\s+(?:hotov[ýyé](?:ho|mu)?|spln[ěe]n[ýyé]|spln[ěe]no)\s*$/iu;
const TASK_UNDONE_PATTERN =
  /^\s*zru[sš](?:it)?\s+ozna[cč]en[íi]\s+[úu]kolu\s+(.+?)\s*$/iu;

function cleanTaskText(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .replace(/^[\s„“"'‚‘(\[]+/u, "")
    .replace(/[\s„“"'‚‘)\]]+$/u, "")
    .trim();
}

export function parseTaskVoiceCommand(
  text: string,
): TaskStateVoiceCommand | null {
  const normalized = text
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.!?…]+$/u, "")
    .trim();

  if (normalized === "") {
    return null;
  }

  const done = TASK_DONE_PATTERN.exec(normalized);

  if (done !== null) {
    const taskText = cleanTaskText(done[1] ?? "");

    return taskText === "" ? null : { taskText, checked: true };
  }

  const undone = TASK_UNDONE_PATTERN.exec(normalized);

  if (undone !== null) {
    const taskText = cleanTaskText(undone[1] ?? "");

    return taskText === "" ? null : { taskText, checked: false };
  }

  return null;
}

interface WorkingState {
  marks: readonly InlineMark[];
  listVariant: VoiceListVariant | null;
  listItemOpen: boolean;
  pendingHeading: PendingHeading | null;
  pendingLiteral: PendingLiteral | null;
  pendingPrefix: PendingPrefix | null;
}

function copyState(state: VoiceFormatState): WorkingState {
  return {
    marks: [...state.marks],
    listVariant: state.listVariant,
    listItemOpen: state.listItemOpen,
    pendingHeading: state.pendingHeading,
    pendingLiteral: state.pendingLiteral,
    pendingPrefix: state.pendingPrefix,
  };
}

function snapshotState(state: WorkingState): VoiceFormatState {
  return {
    marks: [...state.marks],
    listVariant: state.listVariant,
    listItemOpen: state.listItemOpen,
    pendingHeading: state.pendingHeading,
    pendingLiteral: state.pendingLiteral,
    pendingPrefix: state.pendingPrefix,
  };
}

function emitText(
  state: WorkingState,
  text: string,
  instructions: VoiceInstruction[],
): void {
  if (text === "") {
    return;
  }

  const marks = [...state.marks];

  if (state.listVariant !== null) {
    if (!state.listItemOpen) {
      instructions.push({
        kind: "list_item",
        variant: state.listVariant,
        text,
        marks,
      });
      state.listItemOpen = true;
      return;
    }

    instructions.push({ kind: "list_item_text", text, marks });
    return;
  }

  instructions.push({ kind: "text", text, marks });
}

function closeList(
  state: WorkingState,
  instructions: VoiceInstruction[],
): void {
  if (state.listVariant === null) {
    return;
  }

  instructions.push({ kind: "list_end", variant: state.listVariant });
  state.listVariant = null;
  state.listItemOpen = false;
}

function flushPendingHeadingLiteral(
  state: WorkingState,
  instructions: VoiceInstruction[],
): void {
  const pending = state.pendingHeading;
  state.pendingHeading = null;

  if (pending !== null) {
    emitText(state, pending.commandText, instructions);
  }
}

function flushPendingLiteral(
  state: WorkingState,
  instructions: VoiceInstruction[],
): void {
  const pending = state.pendingLiteral;
  state.pendingLiteral = null;

  if (pending !== null) {
    emitText(state, pending.commandText, instructions);
  }
}

function flushPendingPrefixLiteral(
  state: WorkingState,
  instructions: VoiceInstruction[],
): void {
  const pending = state.pendingPrefix;
  state.pendingPrefix = null;

  if (pending !== null) {
    emitText(state, pending.text, instructions);
  }
}

function flushAllPending(
  state: WorkingState,
  instructions: VoiceInstruction[],
): void {
  flushPendingPrefixLiteral(state, instructions);
  flushPendingHeadingLiteral(state, instructions);
  flushPendingLiteral(state, instructions);
  closeList(state, instructions);
}

function resolvePendingPrefix(
  state: WorkingState,
  pending: PendingPrefix,
  instructions: VoiceInstruction[],
): void {
  if (pending.exactCommand !== null) {
    processCommand(
      pending.exactCommand,
      { text: pending.text, delimiter: "", raw: pending.text },
      state,
      instructions,
    );
    return;
  }

  emitText(state, pending.text, instructions);
}

function processCommand(
  command: VoiceCommand,
  clause: VoiceClause,
  state: WorkingState,
  instructions: VoiceInstruction[],
): void {
  switch (command.type) {
    case "paragraph_break":
      closeList(state, instructions);
      instructions.push({ kind: "paragraph_break" });
      return;
    case "line_break":
      instructions.push({ kind: "line_break" });
      return;
    case "heading":
      closeList(state, instructions);
      state.pendingHeading = {
        depth: command.depth,
        commandText: `${clause.text}${clause.delimiter}`,
      };
      return;
    case "strong_start":
      state.marks = addInlineMark(state.marks, "strong");
      return;
    case "strong_end":
      state.marks = removeInlineMark(state.marks, "strong");
      return;
    case "emphasis_start":
      state.marks = addInlineMark(state.marks, "emphasis");
      return;
    case "emphasis_end":
      state.marks = removeInlineMark(state.marks, "emphasis");
      return;
    case "list_start":
      if (state.listVariant === command.variant) {
        return;
      }

      closeList(state, instructions);
      instructions.push({
        kind: "list_start",
        variant: command.variant,
      });
      state.listVariant = command.variant;
      state.listItemOpen = false;
      return;
    case "list_next":
      if (state.listVariant === command.variant) {
        state.listItemOpen = false;
        return;
      }

      if (state.listVariant === null) {
        instructions.push({
          kind: "list_start",
          variant: command.variant,
        });
        state.listVariant = command.variant;
        state.listItemOpen = false;
        return;
      }

      emitText(state, `${clause.text}${clause.delimiter}`, instructions);
      return;
    case "list_end":
      if (state.listVariant === command.variant) {
        closeList(state, instructions);
        return;
      }

      emitText(state, `${clause.text}${clause.delimiter}`, instructions);
      return;
    case "stop":
      return;
    case "literal":
      state.pendingLiteral = {
        commandText: `${clause.text}${clause.delimiter}`,
      };
      return;
  }
}

function processText(
  clause: VoiceClause,
  state: WorkingState,
  instructions: VoiceInstruction[],
): void {
  const fullText = `${clause.text}${clause.delimiter}`;

  if (fullText === "") {
    return;
  }

  emitText(state, fullText, instructions);
}

function consumeHeading(
  clause: VoiceClause,
  state: WorkingState,
  instructions: VoiceInstruction[],
): void {
  const pending = state.pendingHeading;
  state.pendingHeading = null;

  if (pending === null) {
    processText(clause, state, instructions);
    return;
  }

  const text = clause.text.trim();

  if (text === "") {
    emitText(state, pending.commandText, instructions);

    if (clause.delimiter !== "") {
      emitText(state, clause.delimiter, instructions);
    }

    return;
  }

  if (countGraphemes(text) > HEADING_MAX_GRAPHEMES) {
    emitText(state, pending.commandText, instructions);
    processText(clause, state, instructions);
    return;
  }

  instructions.push({ kind: "heading", depth: pending.depth, text });
}

function parseDoslova(clause: VoiceClause): { readonly rest: string } | null {
  const match = /^\s*doslova\b(.*)$/iu.exec(clause.text);

  if (!match) {
    return null;
  }

  return {
    rest: (match[1] ?? "").replace(/^[\s,;:]+/u, ""),
  };
}

export function parseVoiceCommands(
  segment: string,
  state: VoiceFormatState = INITIAL_VOICE_FORMAT_STATE,
): ParseVoiceCommandsResult {
  const instructions: VoiceInstruction[] = [];
  const working = copyState(state);
  const clauses = splitVoiceClauses(segment);
  let index = 0;

  if (working.pendingPrefix !== null && clauses.length > 0) {
    const pending = working.pendingPrefix;
    working.pendingPrefix = null;
    const first = clauses[0]!;
    const longer = findLongerVoiceCommand(pending.text, first.text);

    if (longer !== null) {
      if (
        clauses.length === 1 &&
        first.delimiter === "" &&
        isPossibleVoiceCommandPrefix(longer.joinedText)
      ) {
        working.pendingPrefix = {
          text: longer.joinedText,
          exactCommand: longer.command,
        };
        index = 1;
      } else if (longer.command.type === "stop") {
        flushAllPending(working, instructions);
        instructions.push({ kind: "stop" });
        return {
          instructions,
          state: INITIAL_VOICE_FORMAT_STATE,
          stopped: true,
        };
      } else {
        processCommand(
          longer.command,
          {
            text: longer.joinedText,
            delimiter: first.delimiter,
            raw: `${longer.joinedText}${first.delimiter}`,
          },
          working,
          instructions,
        );
        index = 1;
      }
    } else {
      const combinedCandidates =
        clauses.length === 1 && first.delimiter === ""
          ? [`${pending.text}${first.text}`, `${pending.text} ${first.text}`]
          : [];
      const prefixCandidate = combinedCandidates.find((candidate) =>
        isPossibleVoiceCommandPrefix(candidate),
      );

      if (prefixCandidate !== undefined) {
        working.pendingPrefix = {
          text: prefixCandidate,
          exactCommand: matchVoiceCommand(prefixCandidate),
        };
        index = 1;
      } else {
        resolvePendingPrefix(working, pending, instructions);
      }
    }
  }

  for (; index < clauses.length; index += 1) {
    const clause = clauses[index]!;
    const isLast = index === clauses.length - 1;

    if (working.pendingLiteral !== null) {
      emitText(working, `${clause.text}${clause.delimiter}`, instructions);
      working.pendingLiteral = null;
      continue;
    }

    const literal = parseDoslova(clause);
    const command =
      literal === null ? matchVoiceCommand(clause.text) : null;

    if (working.pendingHeading !== null) {
      if (literal !== null || command !== null) {
        flushPendingHeadingLiteral(working, instructions);
      } else {
        consumeHeading(clause, working, instructions);
        continue;
      }
    }

    if (literal !== null) {
      if (literal.rest === "") {
        working.pendingLiteral = {
          commandText: `${clause.text}${clause.delimiter}`,
        };
      } else {
        emitText(
          working,
          `${literal.rest}${clause.delimiter}`,
          instructions,
        );
      }

      continue;
    }

    if (
      isLast &&
      clause.delimiter === "" &&
      isPossibleVoiceCommandPrefix(clause.text)
    ) {
      working.pendingPrefix = {
        text: clause.text,
        exactCommand: matchVoiceCommand(clause.text),
      };
      continue;
    }

    if (command !== null) {
      if (command.type === "stop") {
        flushAllPending(working, instructions);
        instructions.push({ kind: "stop" });
        return {
          instructions,
          state: INITIAL_VOICE_FORMAT_STATE,
          stopped: true,
        };
      }

      processCommand(command, clause, working, instructions);
      continue;
    }

    processText(clause, working, instructions);
  }

  return {
    instructions,
    state: snapshotState(working),
    stopped: false,
  };
}

export function flushVoiceCommands(
  state: VoiceFormatState,
): FlushVoiceCommandsResult {
  const instructions: VoiceInstruction[] = [];
  const working = copyState(state);
  flushAllPending(working, instructions);

  return {
    instructions,
    state: INITIAL_VOICE_FORMAT_STATE,
  };
}
