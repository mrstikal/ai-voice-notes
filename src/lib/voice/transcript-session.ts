import {
  flushVoiceCommands,
  parseVoiceCommands,
  type VoiceInstruction,
} from "./commands";
import {
  INITIAL_VOICE_FORMAT_STATE,
  stripTrailingSentencePunctuation,
  type InlineMark,
  type VoiceFormatState,
  type VoiceListVariant,
} from "./format-state";

export interface CommittedTranscriptEvent {
  readonly text: string;
  readonly providerId?: string | null;
}

export interface AcceptedTranscriptSegment {
  readonly sequence: number;
  readonly text: string;
  readonly providerId: string | null;
}

export class TranscriptSession {
  private readonly seenProviderIds = new Set<string>();
  private sequence = 0;
  private closed = false;

  accept(
    event: CommittedTranscriptEvent,
  ): AcceptedTranscriptSegment | null {
    if (this.closed || event.text.trim() === "") {
      return null;
    }

    const providerId = event.providerId?.trim() ?? "";

    if (providerId !== "") {
      if (this.seenProviderIds.has(providerId)) {
        return null;
      }

      this.seenProviderIds.add(providerId);
    }

    this.sequence += 1;

    return {
      sequence: this.sequence,
      text: event.text,
      providerId: providerId === "" ? null : providerId,
    };
  }

  close(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export interface InsertResult {
  readonly content: string;
  readonly cursor: number;
}

export function insertCommittedTextAtCursor(
  content: string,
  text: string,
  cursor: number,
): InsertResult {
  const safeCursor = Math.max(0, Math.min(cursor, content.length));

  if (text === "") {
    return { content, cursor: safeCursor };
  }

  const before = content.slice(0, safeCursor);
  const after = content.slice(safeCursor);
  const leading =
    before.length > 0 && !/\s$/u.test(before) && !/^\s/u.test(text)
      ? " "
      : "";
  const trailing =
    after.length > 0 && !/^\s/u.test(after) && !/\s$/u.test(text) ? " " : "";
  const inserted = `${leading}${text}${trailing}`;

  return {
    content: `${before}${inserted}${after}`,
    cursor: safeCursor + inserted.length,
  };
}

export function appendCommittedText(content: string, text: string): string {
  if (text === "") {
    return content;
  }

  const separator =
    content.length > 0 && !/\s$/u.test(content) && !/^\s/u.test(text)
      ? " "
      : "";

  return `${content}${separator}${text}`;
}

export type VoiceInlineRun =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly marks: readonly InlineMark[];
    }
  | { readonly kind: "line_break" };

export type VoiceRenderedPart =
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
      readonly kind: "list_item";
      readonly variant: VoiceListVariant;
      readonly runs: readonly VoiceInlineRun[];
      readonly continuation: boolean;
    }
  | {
      readonly kind: "list_end";
      readonly variant: VoiceListVariant;
    };

export interface VoiceFormattingBatch {
  readonly batchIndex: number;
  readonly instructions: readonly VoiceInstruction[];
  readonly parts: readonly VoiceRenderedPart[];
  readonly labels: readonly string[];
  readonly stateBefore: VoiceFormatState;
  readonly stateAfter: VoiceFormatState;
  readonly stopped: boolean;
}

export interface VoicePendingListItem {
  readonly variant: VoiceListVariant;
  readonly runs: readonly VoiceInlineRun[];
  readonly continuation: boolean;
}

export interface RenderVoiceOptions {
  readonly listHasItemBeforeBatch: boolean;
  readonly pendingBlockBoundary: boolean;
  readonly pendingListItem: VoicePendingListItem | null;
}

export interface RenderedVoiceInstructions {
  readonly parts: readonly VoiceRenderedPart[];
  readonly labels: readonly string[];
  readonly pendingListItem: VoicePendingListItem | null;
}

const BLOCK_END = /\n[ \t]*\n$/u;

function escapeMarkdownText(text: string): string {
  return text
    .replace(/\\/gu, "\\\\")
    .replace(/([`*_[\]<>~])/gu, "\\$1")
    .replace(/^(\s*)(#{1,6}|>|[-+])(?=\s)/gmu, "$1\\$2")
    .replace(/^(\s*)(\d+[.)])(?=\s)/gmu, "$1\\$2");
}

function renderTextRun(
  text: string,
  marks: readonly InlineMark[],
): string {
  const escaped = escapeMarkdownText(text);

  if (escaped === "") {
    return "";
  }

  let rendered = escaped;

  if (marks.includes("emphasis")) {
    rendered = `*${rendered}*`;
  }

  if (marks.includes("strong")) {
    rendered = `**${rendered}**`;
  }

  return rendered;
}

function renderInlineRuns(runs: readonly VoiceInlineRun[]): string {
  let rendered = "";

  for (const run of runs) {
    if (run.kind === "line_break") {
      rendered = `${rendered.replace(/[ \t]+$/u, "")}\n`;
      continue;
    }

    const text = renderTextRun(run.text, run.marks);

    if (text === "") {
      continue;
    }

    if (
      rendered !== "" &&
      !rendered.endsWith("\n") &&
      !rendered.endsWith(" ")
    ) {
      rendered += " ";
    }

    rendered += text;
  }

  return rendered.trimEnd();
}

function finalizeListRuns(
  runs: readonly VoiceInlineRun[],
): readonly VoiceInlineRun[] {
  const result = runs.map((run) => ({ ...run }));

  for (let index = result.length - 1; index >= 0; index -= 1) {
    const run = result[index]!;

    if (run.kind !== "text") {
      continue;
    }

    const stripped = stripTrailingSentencePunctuation(run.text);
    result[index] = { ...run, text: stripped };

    if (stripped !== "") {
      break;
    }
  }

  return result.filter(
    (run) => run.kind === "line_break" || run.text !== "",
  );
}

function listLabel(variant: VoiceListVariant): string {
  return variant === "task" ? "úkol" : "položka";
}

export function renderVoiceInstructions(
  instructions: readonly VoiceInstruction[],
  options: RenderVoiceOptions,
): RenderedVoiceInstructions {
  const parts: VoiceRenderedPart[] = [];
  const labels: string[] = [];
  let listHasItem = options.listHasItemBeforeBatch;
  let currentItem:
    | {
        readonly variant: VoiceListVariant;
        readonly runs: VoiceInlineRun[];
        readonly continuation: boolean;
      }
    | null =
    options.pendingListItem === null
      ? null
      : {
          variant: options.pendingListItem.variant,
          runs: [...options.pendingListItem.runs],
          continuation: options.pendingListItem.continuation,
        };
  let blockBoundary = options.pendingBlockBoundary;

  function flushItem() {
    if (currentItem === null) {
      return;
    }

    parts.push({
      kind: "list_item",
      variant: currentItem.variant,
      runs: finalizeListRuns(currentItem.runs),
      continuation: currentItem.continuation,
    });
    currentItem = null;
    listHasItem = true;
  }

  function ensureTextBlockBoundary() {
    if (!blockBoundary) {
      return;
    }

    parts.push({ kind: "paragraph_break" });
    blockBoundary = false;
  }

  for (const instruction of instructions) {
    switch (instruction.kind) {
      case "text":
        if (currentItem !== null) {
          currentItem.runs.push({
            kind: "text",
            text: instruction.text,
            marks: instruction.marks,
          });
        } else {
          ensureTextBlockBoundary();
          parts.push({
            kind: "text",
            text: instruction.text,
            marks: instruction.marks,
          });
        }
        break;
      case "line_break":
        if (currentItem !== null) {
          currentItem.runs.push({ kind: "line_break" });
        } else {
          parts.push({ kind: "line_break" });
        }
        labels.push("Nový řádek");
        break;
      case "paragraph_break":
        flushItem();
        parts.push({ kind: "paragraph_break" });
        labels.push("Nový odstavec");
        blockBoundary = false;
        break;
      case "heading":
        flushItem();
        parts.push({
          kind: "heading",
          depth: instruction.depth,
          text: instruction.text,
        });
        labels.push(`Nadpis H${instruction.depth}: ${instruction.text}`);
        blockBoundary = false;
        break;
      case "list_start":
        flushItem();
        listHasItem = false;
        labels.push(
          instruction.variant === "task"
            ? "Začátek úkolů"
            : "Začátek seznamu",
        );
        blockBoundary = false;
        break;
      case "list_item":
        flushItem();
        currentItem = {
          variant: instruction.variant,
          runs: [
            {
              kind: "text",
              text: instruction.text,
              marks: instruction.marks,
            },
          ],
          continuation: listHasItem,
        };
        listHasItem = true;
        labels.push(
          `${listLabel(instruction.variant)}: ${instruction.text}`,
        );
        blockBoundary = false;
        break;
      case "list_item_text":
        if (currentItem !== null) {
          currentItem.runs.push({
            kind: "text",
            text: instruction.text,
            marks: instruction.marks,
          });
        } else {
          parts.push({
            kind: "text",
            text: instruction.text,
            marks: instruction.marks,
          });
        }
        break;
      case "list_end":
        flushItem();
        parts.push({ kind: "list_end", variant: instruction.variant });
        labels.push(
          instruction.variant === "task"
            ? "Konec úkolů"
            : "Konec seznamu",
        );
        listHasItem = false;
        blockBoundary = true;
        break;
      case "stop":
        flushItem();
        labels.push("Stop");
        blockBoundary = false;
        break;
      default:
        break;
    }
  }

  const pendingListItem: VoicePendingListItem | null =
    currentItem === null
      ? null
      : {
          variant: currentItem.variant,
          runs: [...currentItem.runs],
          continuation: currentItem.continuation,
        };

  return { parts, labels, pendingListItem };
}

function computePendingBlockBoundary(
  instructions: readonly VoiceInstruction[],
  initial: boolean,
): boolean {
  let pending = initial;

  for (const instruction of instructions) {
    switch (instruction.kind) {
      case "list_end":
        pending = true;
        break;
      case "paragraph_break":
      case "heading":
      case "list_start":
      case "list_item":
      case "text":
      case "stop":
        pending = false;
        break;
      default:
        break;
    }
  }

  return pending;
}

function computeListHasItem(
  instructions: readonly VoiceInstruction[],
  initial: boolean,
): boolean {
  let hasItem = initial;

  for (const instruction of instructions) {
    if (instruction.kind === "list_start") {
      hasItem = false;
    } else if (instruction.kind === "list_item") {
      hasItem = true;
    } else if (instruction.kind === "list_end") {
      hasItem = false;
    }
  }

  return hasItem;
}

function ensureParagraphBreak(
  content: string,
  cursor: number,
): InsertResult {
  const before = content.slice(0, cursor);

  if (before === "" || BLOCK_END.test(before)) {
    return { content, cursor };
  }

  const separator = before.endsWith("\n") ? "\n" : "\n\n";

  return {
    content: `${before}${separator}${content.slice(cursor)}`,
    cursor: cursor + separator.length,
  };
}

function insertBlock(
  content: string,
  cursor: number,
  block: string,
  separation: "blank" | "line",
): InsertResult {
  const before = content.slice(0, cursor);
  const after = content.slice(cursor);
  let prefix = "";

  if (separation === "blank") {
    if (before !== "" && !BLOCK_END.test(before)) {
      prefix = before.endsWith("\n") ? "\n" : "\n\n";
    }
  } else if (before !== "" && !before.endsWith("\n")) {
    prefix = "\n";
  }

  const isHeading = /^#{1,6} /u.test(block);
  let suffix = "";

  if (after === "") {
    suffix = isHeading ? "\n\n" : "";
  } else if (!after.startsWith("\n")) {
    suffix = isHeading ? "\n\n" : "\n";
  } else if (isHeading && !after.startsWith("\n\n")) {
    suffix = "\n";
  }

  const afterLeadingNewlines = after.match(/^\n+/u)?.[0].length ?? 0;
  const cursorAdvance = isHeading
    ? Math.min(2, suffix.length + afterLeadingNewlines)
    : suffix.length;

  return {
    content: `${before}${prefix}${block}${suffix}${after}`,
    cursor: cursor + prefix.length + block.length + cursorAdvance,
  };
}

export function applyVoicePartsToMarkdown(
  content: string,
  cursor: number,
  parts: readonly VoiceRenderedPart[],
): InsertResult {
  let result = content;
  let position = Math.max(0, Math.min(cursor, content.length));

  for (const part of parts) {
    switch (part.kind) {
      case "text": {
        const inserted = insertCommittedTextAtCursor(
          result,
          renderTextRun(part.text, part.marks),
          position,
        );
        result = inserted.content;
        position = inserted.cursor;
        break;
      }
      case "line_break": {
        const before = result.slice(0, position);

        if (!before.endsWith("\n")) {
          result = `${before}\n${result.slice(position)}`;
          position += 1;
        }
        break;
      }
      case "paragraph_break": {
        const inserted = ensureParagraphBreak(result, position);
        result = inserted.content;
        position = inserted.cursor;
        break;
      }
      case "heading": {
        const block = `${"#".repeat(part.depth)} ${escapeMarkdownText(part.text)}`;
        const inserted = insertBlock(result, position, block, "blank");
        result = inserted.content;
        position = inserted.cursor;
        break;
      }
      case "list_item": {
        const marker = part.variant === "task" ? "- [ ] " : "- ";
        const block = `${marker}${renderInlineRuns(part.runs)}`;
        const inserted = insertBlock(
          result,
          position,
          block,
          part.continuation ? "line" : "blank",
        );
        result = inserted.content;
        position = inserted.cursor;
        break;
      }
      case "list_end":
        break;
      default:
        break;
    }
  }

  return { content: result, cursor: position };
}

export class VoiceFormattingSession {
  private state: VoiceFormatState = INITIAL_VOICE_FORMAT_STATE;
  private listHasItem = false;
  private pendingBlockBoundary = false;
  private pendingListItem: VoicePendingListItem | null = null;
  private nextBatchIndex = 0;

  reset(): void {
    this.state = INITIAL_VOICE_FORMAT_STATE;
    this.listHasItem = false;
    this.pendingBlockBoundary = false;
    this.pendingListItem = null;
    this.nextBatchIndex = 0;
  }

  accept(segment: string): VoiceFormattingBatch {
    const stateBefore = this.state;
    const parsed = parseVoiceCommands(segment, stateBefore);
    const rendered = renderVoiceInstructions(parsed.instructions, {
      listHasItemBeforeBatch: this.listHasItem,
      pendingBlockBoundary: this.pendingBlockBoundary,
      pendingListItem: this.pendingListItem,
    });

    this.state = parsed.state;
    this.pendingListItem = rendered.pendingListItem;
    this.listHasItem = computeListHasItem(
      parsed.instructions,
      this.listHasItem,
    );
    this.pendingBlockBoundary = computePendingBlockBoundary(
      parsed.instructions,
      this.pendingBlockBoundary,
    );

    return {
      batchIndex: this.nextBatchIndex++,
      instructions: parsed.instructions,
      parts: rendered.parts,
      labels: rendered.labels,
      stateBefore,
      stateAfter: parsed.state,
      stopped: parsed.stopped,
    };
  }

  flush(): VoiceFormattingBatch {
    const stateBefore = this.state;
    const flushed = flushVoiceCommands(stateBefore);
    const rendered = renderVoiceInstructions(flushed.instructions, {
      listHasItemBeforeBatch: this.listHasItem,
      pendingBlockBoundary: this.pendingBlockBoundary,
      pendingListItem: this.pendingListItem,
    });

    this.state = INITIAL_VOICE_FORMAT_STATE;
    this.listHasItem = false;
    this.pendingBlockBoundary = false;
    this.pendingListItem = null;

    return {
      batchIndex: this.nextBatchIndex++,
      instructions: flushed.instructions,
      parts: rendered.parts,
      labels: rendered.labels,
      stateBefore,
      stateAfter: flushed.state,
      stopped: false,
    };
  }

  getState(): VoiceFormatState {
    return this.state;
  }
}
