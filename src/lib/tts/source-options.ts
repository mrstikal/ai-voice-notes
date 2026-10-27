import type { List, ListItem, Root, RootContent } from "mdast";
import { visit } from "unist-util-visit";

import {
  collectMarkdownReasons,
  parseNoteMarkdown,
  renderMarkdownBlock,
  type SourceOnlyReason,
} from "../notes/markdown.ts";

export interface TtsBlockSpan {
  readonly node: RootContent;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface TtsTaskItemInfo {
  readonly text: string;
  readonly reasons: readonly SourceOnlyReason[];
}

export interface TtsTaskListInfo {
  readonly items: readonly TtsTaskItemInfo[];
  readonly blockStart: number;
  readonly blockEnd: number;
}

export interface TtsSourceParagraphOption {
  readonly index: number;
  readonly text: string;
}

export interface TtsSourceTaskListOption {
  readonly index: number;
  readonly text: string;
  readonly itemCount: number;
}

export interface TtsSourceOptions {
  readonly plainText: string;
  readonly paragraphs: readonly TtsSourceParagraphOption[];
  readonly taskLists: readonly TtsSourceTaskListOption[];
  readonly sourceOnly: boolean;
}

export function collectTtsBlockSpans(ast: Root): TtsBlockSpan[] {
  const spans: TtsBlockSpan[] = [];
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

function taskItemText(item: ListItem): TtsTaskItemInfo {
  const paragraphs = item.children.filter(
    (child) => child.type === "paragraph",
  );

  return {
    text: paragraphs
      .map((child) => renderMarkdownBlock(child))
      .join("\n")
      .trim(),
    reasons: paragraphs.flatMap((child) => collectMarkdownReasons(child)),
  };
}

export function collectTtsTaskLists(
  spans: readonly TtsBlockSpan[],
): TtsTaskListInfo[] {
  const lists: TtsTaskListInfo[] = [];

  for (const span of spans) {
    visit(span.node, "list", (node: List) => {
      const items = node.children
        .filter((item) => item.checked === true || item.checked === false)
        .map(taskItemText)
        .filter((item) => item.text.length > 0 || item.reasons.length > 0);

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

export function getTtsSourceOptions(contentMd: string): TtsSourceOptions {
  const parsed = parseNoteMarkdown(contentMd);
  const spans = collectTtsBlockSpans(parsed.ast);
  const paragraphs = spans
    .filter((span) => span.node.type === "paragraph")
    .map((span, index) => ({ index, text: span.text }));
  const taskLists = collectTtsTaskLists(spans).map((list, index) => ({
    index,
    text: list.items
      .map((item) => item.text)
      .filter((text) => text.length > 0)
      .join("\n"),
    itemCount: list.items.length,
  }));

  return {
    plainText: parsed.plainText,
    paragraphs,
    taskLists,
    sourceOnly: parsed.sourceOnly,
  };
}
