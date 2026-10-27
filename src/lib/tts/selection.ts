import type { List, ListItem, Root, RootContent } from "mdast";
import { visit } from "unist-util-visit";

import {
  collectMarkdownReasons,
  parseNoteMarkdown,
  renderMarkdownBlock,
  type SourceOnlyReason,
} from "../notes/markdown.ts";
import { TtsTextError } from "./chunking.ts";

export const TTS_SCOPES = ["full", "range", "paragraph", "tasks"] as const;

export type TtsScope = (typeof TTS_SCOPES)[number];

export interface TtsSelectionRequest {
  readonly scope: TtsScope;
  readonly start?: number;
  readonly end?: number;
  readonly paragraphIndex?: number;
  readonly listIndex?: number;
}

export interface TtsSelection extends TtsSelectionRequest {
  readonly text: string;
}

const graphemeSegmenter = new Intl.Segmenter("cs", {
  granularity: "grapheme",
});

interface BlockSpan {
  readonly node: RootContent;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

interface TaskItemInfo {
  readonly text: string;
  readonly reasons: readonly SourceOnlyReason[];
}

interface TaskListInfo {
  readonly items: readonly TaskItemInfo[];
  readonly blockStart: number;
  readonly blockEnd: number;
}

function collectBlockSpans(ast: Root): BlockSpan[] {
  const spans: BlockSpan[] = [];
  let offset = 0;

  for (const node of ast.children) {
    const text = renderMarkdownBlock(node);

    if (text.length === 0) {
      continue;
    }

    if (offset > 0) {
      offset += 2;
    }

    spans.push({
      node,
      text,
      start: offset,
      end: offset + text.length,
    });
    offset += text.length;
  }

  return spans;
}

function graphemeBoundaries(text: string): Set<number> {
  const boundaries = new Set<number>([0, text.length]);

  for (const segment of graphemeSegmenter.segment(text)) {
    boundaries.add(segment.index);
  }

  return boundaries;
}

function validateRange(
  request: TtsSelectionRequest,
  text: string,
  textLength: number,
): { readonly start: number; readonly end: number } {
  const { start, end } = request;

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start === undefined ||
    end === undefined ||
    start < 0 ||
    end > textLength ||
    start >= end
  ) {
    throw new TtsTextError(
      400,
      "tts_invalid_range",
      "Vybraný rozsah textu je neplatný.",
      { start, end, textLength },
    );
  }

  const boundaries = graphemeBoundaries(text);

  if (!boundaries.has(start) || !boundaries.has(end)) {
    throw new TtsTextError(
      400,
      "tts_range_splits_grapheme",
      "Vybraný rozsah rozděluje znak. Upravte výběr.",
      { start, end },
    );
  }

  return { start, end };
}

function taskItemText(item: ListItem): TaskItemInfo {
  const paragraphs = item.children.filter(
    (child) => child.type === "paragraph",
  );

  return {
    text: paragraphs
      .map((child) => renderMarkdownBlock(child))
      .join("\n")
      .trim(),
    reasons: paragraphs.flatMap((child) =>
      collectMarkdownReasons(child),
    ),
  };
}

function unsupportedBlockError(
  reasons: readonly SourceOnlyReason[],
): TtsTextError {
  return new TtsTextError(
    422,
    "tts_unsupported_markdown",
    "Vybraný blok obsahuje nepodporované prvky, které nelze bezpečně přečíst nahlas.",
    { reasons },
  );
}

function assertBlockSupported(node: RootContent): void {
  const reasons = collectMarkdownReasons(node);

  if (reasons.length > 0) {
    throw unsupportedBlockError(reasons);
  }
}

function assertTaskItemsSupported(
  items: readonly TaskItemInfo[],
): void {
  const reasons = items.flatMap((item) => item.reasons);

  if (reasons.length > 0) {
    throw unsupportedBlockError(reasons);
  }
}

function collectTaskLists(spans: readonly BlockSpan[]): TaskListInfo[] {
  const lists: TaskListInfo[] = [];

  for (const span of spans) {
    visit(span.node, "list", (node: List) => {
      const items = node.children
        .filter(
          (item) => item.checked === true || item.checked === false,
        )
        .map(taskItemText)
        .filter(
          (item) => item.text.length > 0 || item.reasons.length > 0,
        );

      if (items.length > 0) {
        lists.push({
          items,
          blockStart: span.start,
          blockEnd: span.end,
        });
      }
    });
  }

  return lists;
}

function selectParagraph(
  request: TtsSelectionRequest,
  plainText: string,
  spans: readonly BlockSpan[],
): string {
  const paragraphs = spans.filter(
    (span) => span.node.type === "paragraph",
  );

  if (request.paragraphIndex !== undefined) {
    if (
      !Number.isSafeInteger(request.paragraphIndex) ||
      request.paragraphIndex < 0 ||
      request.paragraphIndex >= paragraphs.length
    ) {
      throw new TtsTextError(
        400,
        "tts_invalid_paragraph",
        "Vybraný odstavec neexistuje.",
        { paragraphIndex: request.paragraphIndex },
      );
    }

    const paragraph = paragraphs[request.paragraphIndex]!;
    assertBlockSupported(paragraph.node);

    return paragraph.text;
  }

  if (request.start !== undefined || request.end !== undefined) {
    const range = validateRange(request, plainText, plainText.length);
    const paragraph = paragraphs.find(
      (span) => range.start >= span.start && range.end <= span.end,
    );

    if (!paragraph) {
      throw new TtsTextError(
        400,
        "tts_selection_not_paragraph",
        "Výběr musí ležet uvnitř jednoho odstavce.",
      );
    }

    assertBlockSupported(paragraph.node);

    return paragraph.text;
  }

  throw new TtsTextError(
    400,
    "tts_missing_selection",
    "Vyberte odstavec nebo v něm umístěte kurzor.",
  );
}

function selectTasks(
  request: TtsSelectionRequest,
  plainText: string,
  spans: readonly BlockSpan[],
): string {
  const lists = collectTaskLists(spans);

  if (lists.length === 0) {
    throw new TtsTextError(
      400,
      "tts_no_tasks",
      "V poznámce není žádný úkol k přečtení.",
    );
  }

  if (request.listIndex !== undefined) {
    if (
      !Number.isSafeInteger(request.listIndex) ||
      request.listIndex < 0 ||
      request.listIndex >= lists.length
    ) {
      throw new TtsTextError(
        400,
        "tts_invalid_task_list",
        "Vybraný seznam úkolů neexistuje.",
        { listIndex: request.listIndex },
      );
    }

    const list = lists[request.listIndex]!;
    assertTaskItemsSupported(list.items);

    return list.items
      .map((item) => item.text)
      .filter((text) => text.length > 0)
      .join("\n");
  }

  if (request.start !== undefined || request.end !== undefined) {
    const range = validateRange(request, plainText, plainText.length);
    const list = lists.find(
      (item) =>
        range.start >= item.blockStart && range.end <= item.blockEnd,
    );

    if (!list) {
      throw new TtsTextError(
        400,
        "tts_no_tasks",
        "V místě výběru není žádný seznam úkolů.",
      );
    }

    assertTaskItemsSupported(list.items);

    return list.items
      .map((item) => item.text)
      .filter((text) => text.length > 0)
      .join("\n");
  }

  const items = lists.flatMap((list) => list.items);
  assertTaskItemsSupported(items);

  return items
    .map((item) => item.text)
    .filter((text) => text.length > 0)
    .join("\n");
}

export function selectTtsText(
  contentMd: string,
  request: TtsSelectionRequest,
): TtsSelection {
  const parsed = parseNoteMarkdown(contentMd);
  const plainText = parsed.plainText;
  const spans = collectBlockSpans(parsed.ast);
  const sourceOnlyError = () =>
    new TtsTextError(
      422,
      "tts_unsupported_markdown",
      "Tento Markdown obsahuje nepodporované prvky, které nelze bezpečně přečíst nahlas.",
      { reasons: parsed.sourceOnlyReasons },
    );
  let text: string;

  switch (request.scope) {
    case "full":
      if (parsed.sourceOnly) {
        throw sourceOnlyError();
      }

      text = plainText;
      break;
    case "range": {
      if (parsed.sourceOnly) {
        throw sourceOnlyError();
      }

      const range = validateRange(request, plainText, plainText.length);
      text = plainText.slice(range.start, range.end);
      break;
    }
    case "paragraph":
      if (
        parsed.sourceOnly &&
        (request.start !== undefined || request.end !== undefined)
      ) {
        throw sourceOnlyError();
      }

      text = selectParagraph(request, plainText, spans);
      break;
    case "tasks":
      if (
        parsed.sourceOnly &&
        (request.start !== undefined || request.end !== undefined)
      ) {
        throw sourceOnlyError();
      }

      text = selectTasks(request, plainText, spans);
      break;
    default:
      throw new TtsTextError(
        400,
        "tts_invalid_scope",
        "Neplatný rozsah čtení nahlas.",
      );
  }

  if (text.trim() === "") {
    throw new TtsTextError(
      400,
      "tts_empty_selection",
      "Vybraný text neobsahuje nic, co by šlo přečíst nahlas.",
    );
  }

  return { ...request, text };
}
