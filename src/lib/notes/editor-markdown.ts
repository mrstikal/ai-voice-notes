import type { JSONContent } from "@tiptap/core";
import { decodeHTML } from "entities";
import { Bold } from "@tiptap/extension-bold";
import { Blockquote } from "@tiptap/extension-blockquote";
import { Code } from "@tiptap/extension-code";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Document } from "@tiptap/extension-document";
import { HardBreak } from "@tiptap/extension-hard-break";
import { Heading } from "@tiptap/extension-heading";
import { Italic } from "@tiptap/extension-italic";
import { Link } from "@tiptap/extension-link";
import {
  BulletList,
  ListItem,
  OrderedList,
} from "@tiptap/extension-list";
import { Paragraph } from "@tiptap/extension-paragraph";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { Text } from "@tiptap/extension-text";
import { UndoRedo } from "@tiptap/extensions";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import type {
  Blockquote as MdastBlockquote,
  Code as MdastCode,
  Heading as MdastHeading,
  List as MdastList,
  ListItem as MdastListItem,
  Paragraph as MdastParagraph,
  PhrasingContent,
  Root,
  RootContent,
} from "mdast";

import {
  isSafeLinkDestination,
  parseNoteMarkdown,
  type ParsedNoteMarkdown,
} from "./markdown.ts";

const TIPTAP_DECODED_ENTITY_NAMES = new Set(["amp", "gt", "lt", "quot"]);

interface FenceState {
  readonly char: string;
  readonly length: number;
}

function decodeEntitiesInLine(
  line: string,
  initialInlineCodeLength: number,
): { readonly inlineCodeLength: number; readonly line: string } {
  let result = "";
  let index = 0;
  let inlineCodeLength = initialInlineCodeLength;

  while (index < line.length) {
    const character = line[index];

    if (character === "`") {
      let runLength = 1;
      while (line[index + runLength] === "`") {
        runLength += 1;
      }

      if (inlineCodeLength === 0) {
        inlineCodeLength = runLength;
      } else if (runLength === inlineCodeLength) {
        inlineCodeLength = 0;
      }

      result += line.slice(index, index + runLength);
      index += runLength;
      continue;
    }

    if (character === "&" && inlineCodeLength === 0) {
      const match = /^&([a-zA-Z][a-zA-Z0-9]+);/u.exec(line.slice(index));
      if (match) {
        const name = match[1] ?? "";
        if (!TIPTAP_DECODED_ENTITY_NAMES.has(name)) {
          result += decodeHTML(match[0]);
          index += match[0].length;
          continue;
        }
      }
    }

    result += character;
    index += 1;
  }

  return { inlineCodeLength, line: result };
}

function prepareMarkdownForVisual(markdown: string): string {
  let fence: FenceState | null = null;
  let inlineCodeLength = 0;

  return markdown
    .split("\n")
    .map((line) => {
      const fenceMatch = /^( {0,3})(`{3,}|~{3,})/u.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[2] ?? "";
        const char = marker[0] ?? "`";

        if (fence === null) {
          fence = { char, length: marker.length };
          return line;
        }

        if (fence.char === char && marker.length >= fence.length) {
          fence = null;
          return line;
        }
      }

      if (fence !== null) {
        return line;
      }

      if (/^ {4,}/u.test(line) || /^\t/u.test(line)) {
        return line;
      }

      const normalized = line.replace(/^(\s*)([-+*])[ \t]+$/u, "$1$2");
      const decoded = decodeEntitiesInLine(normalized, inlineCodeLength);
      inlineCodeLength = decoded.inlineCodeLength;
      return decoded.line;
    })
    .join("\n");
}


function decodeLinkAttributes(node: JSONContent): JSONContent {
  const marks = node.marks?.map((mark) => {
    if (mark.type !== "link") {
      return mark;
    }

    const href =
      typeof mark.attrs?.href === "string"
        ? decodeHTML(mark.attrs.href)
        : mark.attrs?.href;
    const title =
      typeof mark.attrs?.title === "string"
        ? decodeHTML(mark.attrs.title)
        : mark.attrs?.title;

    return {
      ...mark,
      attrs: {
        ...mark.attrs,
        href,
        title,
      },
    };
  });

  if (!node.content) {
    return marks ? { ...node, marks } : node;
  }

  return {
    ...node,
    marks,
    content: node.content.map(decodeLinkAttributes),
  };
}


function ensureListItemContent(node: JSONContent): JSONContent {
  if (
    (node.type === "listItem" || node.type === "taskItem") &&
    (!node.content || node.content.length === 0)
  ) {
    return { ...node, content: [{ type: "paragraph" }] };
  }

  if (!node.content) {
    return node;
  }

  return {
    ...node,
    content: node.content.map(ensureListItemContent),
  };
}

function paragraphEndsWithHardBreak(paragraph: JSONContent): boolean {
  const last = paragraph.content?.[paragraph.content.length - 1];
  if (
    !last ||
    last.type !== "text" ||
    typeof last.text !== "string" ||
    (last.marks ?? []).some((mark) => mark.type === "code")
  ) {
    return false;
  }

  const backslashes = /(\\+)$/u.exec(last.text);
  if (backslashes) {
    return ((backslashes[1]?.length ?? 0) % 2) === 1;
  }

  return / {2,}$/u.test(last.text);
}

function stripHardBreakMarker(text: string): string {
  if (/(\\+)$/u.test(text)) {
    return text.slice(0, -1);
  }

  return text.replace(/ +$/u, "");
}

function normalizeTaskItemHardBreaks(node: JSONContent): JSONContent {
  if (node.type === "taskItem" && node.content) {
    const content: JSONContent[] = [];

    for (const child of node.content) {
      const previous = content[content.length - 1];

      if (
        child.type === "paragraph" &&
        previous?.type === "paragraph" &&
        paragraphEndsWithHardBreak(previous)
      ) {
        const previousContent = previous.content ?? [];
        const last = previousContent[previousContent.length - 1];

        if (last?.type === "text" && typeof last.text === "string") {
          const trimmed = stripHardBreakMarker(last.text);
          content[content.length - 1] = {
            content: [
              ...previousContent.slice(0, -1),
              ...(trimmed === "" ? [] : [{ ...last, text: trimmed }]),
              { type: "hardBreak" },
              ...(child.content ?? []),
            ],
            type: "paragraph",
          };
          continue;
        }
      }

      content.push(child);
    }

    return { ...node, content: content.map(normalizeTaskItemHardBreaks) };
  }

  if (!node.content) {
    return node;
  }

  return {
    ...node,
    content: node.content.map(normalizeTaskItemHardBreaks),
  };
}

function nextInlineCodeLength(line: string, current: number): number {
  let open = current;

  for (const match of line.matchAll(/`+/gu)) {
    const length = match[0].length;
    if (open === 0) {
      open = length;
    } else if (length === open) {
      open = 0;
    }
  }

  return open;
}

function escapeBlockMarkerLine(line: string): string {
  const heading = /^( {0,3})(#{1,6})(?=\s|$)/u.exec(line);
  if (heading) {
    const indent = heading[1] ?? "";
    return `${indent}\\${line.slice(indent.length)}`;
  }

  const blockquote = /^( {0,3})>/u.exec(line);
  if (blockquote) {
    const indent = blockquote[1] ?? "";
    return `${indent}\\${line.slice(indent.length)}`;
  }

  const bullet = /^( {0,3})([-+*])(?=\s)/u.exec(line);
  if (bullet) {
    const indent = bullet[1] ?? "";
    return `${indent}\\${line.slice(indent.length)}`;
  }

  const ordered = /^( {0,3})(\d{1,9})([.)])(?=\s)/u.exec(line);
  if (ordered) {
    const indent = ordered[1] ?? "";
    const digits = ordered[2] ?? "";
    const delimiter = ordered[3] ?? "";
    return `${indent}${digits}\\${delimiter}${line.slice(indent.length + digits.length + delimiter.length)}`;
  }

  const thematic = /^( {0,3})((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/u.exec(line);
  if (thematic) {
    const indent = thematic[1] ?? "";
    return `${indent}\\${line.slice(indent.length)}`;
  }

  const setext = /^( {0,3})(=+|-+)\s*$/u.exec(line);
  if (setext) {
    const indent = setext[1] ?? "";
    return `${indent}\\${line.slice(indent.length)}`;
  }

  return line;
}

function escapeBlockMarkersInParagraph(markdown: string): string {
  if (markdown === "") {
    return markdown;
  }

  let openCodeLength = 0;

  return markdown
    .split("\n")
    .map((line) => {
      const escaped =
        openCodeLength === 0 ? escapeBlockMarkerLine(line) : line;
      openCodeLength = nextInlineCodeLength(line, openCodeLength);
      return escaped;
    })
    .join("\n");
}

const NoteParagraph = Paragraph.extend({
  renderMarkdown(node, helpers, context) {
    const rendered = this.parent?.(node, helpers, context) ?? "";
    return escapeBlockMarkersInParagraph(rendered);
  },
});

export const NOTE_EDITOR_EXTENSIONS = [
  Document,
  NoteParagraph,
  Text,
  Heading.configure({ levels: [1, 2, 3] }),
  Bold,
  Italic,
  Blockquote,
  Code,
  CodeBlock,
  HardBreak,
  UndoRedo,
  BulletList,
  OrderedList,
  ListItem,
  TaskList,
  TaskItem.configure({ nested: true }),
  Link.configure({
    autolink: false,
    defaultProtocol: "https",
    HTMLAttributes: {
      rel: "noopener noreferrer nofollow",
      target: "_blank",
    },
    isAllowedUri: (url) => isSafeLinkDestination(url),
    linkOnPaste: false,
    markdownLinks: false,
    openOnClick: false,
    protocols: ["http", "https", "mailto"],
  }),
  Markdown.configure({
    indentation: { size: 2, style: "space" },
  }),
];

const markdownManager = new MarkdownManager({
  extensions: NOTE_EDITOR_EXTENSIONS,
  indentation: { size: 2, style: "space" },
});

export type CanonicalMark =
  | { readonly type: "bold" }
  | { readonly type: "italic" }
  | { readonly type: "code" }
  | { readonly type: "link"; readonly href: string; readonly title: string | null };

export type CanonicalInline =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly marks: readonly CanonicalMark[];
    }
  | {
      readonly kind: "break";
      readonly marks: readonly CanonicalMark[];
    };

export interface CanonicalListItem {
  readonly checked: boolean | null;
  readonly content: readonly CanonicalBlock[];
}

export type CanonicalBlock =
  | {
      readonly kind: "paragraph";
      readonly content: readonly CanonicalInline[];
    }
  | {
      readonly kind: "heading";
      readonly level: number;
      readonly content: readonly CanonicalInline[];
    }
  | {
      readonly kind: "blockquote";
      readonly content: readonly CanonicalBlock[];
    }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly start: number | null;
      readonly task: boolean;
      readonly items: readonly CanonicalListItem[];
    }
  | {
      readonly kind: "codeBlock";
      readonly language: string | null;
      readonly value: string;
    };

export type VisualConversionFailure =
  | { readonly reason: "unsupported"; readonly parsed: ParsedNoteMarkdown }
  | { readonly reason: "lossy"; readonly detail: string };

export class VisualConversionError extends Error {
  readonly failure: VisualConversionFailure;

  constructor(failure: VisualConversionFailure) {
    super(
      failure.reason === "unsupported"
        ? "Vizuální režim není dostupný, protože poznámka obsahuje Markdown, který vizuální editor nepodporuje. Upravte ji ve zdrojovém režimu."
        : "Vizuální režim není dostupný, protože převod Markdownu by změnil význam poznámky. Upravte ji ve zdrojovém režimu.",
    );
    this.name = "VisualConversionError";
    this.failure = failure;
  }
}

export class VisualSerializationError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(
      "Vizuální obsah nelze bezpečně převést zpět do Markdownu. Zůstaňte ve vizuálním režimu a zkuste obsah upravit.",
    );
    this.name = "VisualSerializationError";
    this.detail = detail;
  }
}

function markKey(mark: CanonicalMark): string {
  switch (mark.type) {
    case "bold":
    case "italic":
    case "code":
      return mark.type;
    case "link":
      return `link:${mark.href}:${mark.title ?? ""}`;
  }
}

function sortMarks(marks: readonly CanonicalMark[]): CanonicalMark[] {
  return [...marks].sort((left, right) =>
    markKey(left).localeCompare(markKey(right), "en"),
  );
}

function marksEqual(
  left: readonly CanonicalMark[],
  right: readonly CanonicalMark[],
): boolean {
  return (
    left.length === right.length &&
    left.every((mark, index) => markKey(mark) === markKey(right[index]!))
  );
}

function normalizeWhitespace(value: string): string {
  return value.replace(/[ \t\n\r]+/gu, " ");
}

function isBlankText(value: string): boolean {
  return /^[ \n\r]*$/u.test(value);
}

function pushText(
  target: CanonicalInline[],
  text: string,
  marks: readonly CanonicalMark[],
  normalize: boolean,
): void {
  let value = normalize ? normalizeWhitespace(text) : text;

  if (
    normalize &&
    !marks.some((mark) => mark.type === "code") &&
    target[target.length - 1]?.kind === "break"
  ) {
    value = value.replace(/^[ \n\r]+/u, "");
  }

  if (value === "") {
    return;
  }

  const sortedMarks = sortMarks(marks);
  const last = target[target.length - 1];
  if (
    last?.kind === "text" &&
    marksEqual(last.marks, sortedMarks)
  ) {
    target[target.length - 1] = {
      ...last,
      text: last.text + value,
    };
    return;
  }

  target.push({ kind: "text", marks: sortedMarks, text: value });
}


function pushBreak(
  target: CanonicalInline[],
  marks: readonly CanonicalMark[],
): void {
  const last = target[target.length - 1];
  if (last?.kind === "text" && !last.marks.some((mark) => mark.type === "code")) {
    const trimmed = last.text.replace(/[ \n\r]+$/u, "");
    if (trimmed === "") {
      target.pop();
    } else if (trimmed !== last.text) {
      target[target.length - 1] = { ...last, text: trimmed };
    }
  }

  target.push({ kind: "break", marks: sortMarks(marks) });
}

function trimInline(inlines: CanonicalInline[]): CanonicalInline[] {
  while (inlines.length > 0) {
    const first = inlines[0]!;
    if (first.kind !== "text" || first.marks.some((mark) => mark.type === "code")) {
      break;
    }

    const trimmed = first.text.replace(/^[ \n\r]+/u, "");
    if (trimmed === "") {
      inlines.shift();
      continue;
    }

    if (trimmed !== first.text) {
      inlines[0] = { ...first, text: trimmed };
    }
    break;
  }

  while (inlines.length > 0) {
    const last = inlines[inlines.length - 1]!;
    if (last.kind !== "text" || last.marks.some((mark) => mark.type === "code")) {
      break;
    }

    const trimmed = last.text.replace(/[ \n\r]+$/u, "");
    if (trimmed === "") {
      inlines.pop();
      continue;
    }

    if (trimmed !== last.text) {
      inlines[inlines.length - 1] = { ...last, text: trimmed };
    }
    break;
  }

  if (
    inlines.length > 0 &&
    inlines.every(
      (inline) => inline.kind === "text" && isBlankText(inline.text),
    )
  ) {
    return [];
  }

  return inlines;
}

function mdastInline(
  nodes: readonly PhrasingContent[],
  marks: readonly CanonicalMark[] = [],
): CanonicalInline[] {
  const result: CanonicalInline[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case "text":
        pushText(result, node.value, marks, true);
        break;
      case "strong":
        result.push(...mdastInline(node.children, [...marks, { type: "bold" }]));
        break;
      case "emphasis":
        result.push(
          ...mdastInline(node.children, [...marks, { type: "italic" }]),
        );
        break;
      case "link":
        if (!isSafeLinkDestination(node.url)) {
          throw new Error("Do vizuálního editoru nelze převést nebezpečný odkaz.");
        }
        result.push(
          ...mdastInline(node.children, [
            ...marks,
            {
              href: node.url,
              title: node.title ?? null,
              type: "link",
            },
          ]),
        );
        break;
      case "inlineCode":
        pushText(result, node.value, [...marks, { type: "code" }], false);
        break;
      case "break":
        pushBreak(result, marks);
        break;
      default:
        throw new Error(
          `Do vizuálního editoru nelze převést uzel ${node.type}.`,
        );
    }
  }

  return result;
}

function canonicalListItem(item: MdastListItem): CanonicalListItem {
  return {
    checked: typeof item.checked === "boolean" ? item.checked : null,
    content: canonicalizeBlocks(item.children),
  };
}

function canonicalMdastList(node: MdastList): CanonicalBlock {
  const items = node.children.map(canonicalListItem);

  return {
    items,
    kind: "list",
    ordered: node.ordered === true,
    start: node.ordered === true ? (node.start ?? 1) : null,
    task: items.some((item) => item.checked !== null),
  };
}

function canonicalizeMdastBlock(node: RootContent): CanonicalBlock {
  switch (node.type) {
    case "paragraph":
      return canonicalizeMdastParagraph(node);
    case "heading":
      return canonicalizeMdastHeading(node);
    case "blockquote":
      return canonicalizeMdastBlockquote(node);
    case "list":
      return canonicalMdastList(node);
    case "code":
      return canonicalizeMdastCode(node);
    default:
      throw new Error(`Nepodporovaný blok Markdownu: ${node.type}.`);
  }
}

function canonicalizeMdastParagraph(node: MdastParagraph): CanonicalBlock {
  return {
    content: trimInline(mdastInline(node.children)),
    kind: "paragraph",
  };
}

function canonicalizeMdastHeading(node: MdastHeading): CanonicalBlock {
  if (node.depth < 1 || node.depth > 3) {
    throw new Error(`Nepodporovaná úroveň nadpisu: ${node.depth}.`);
  }

  return {
    content: trimInline(mdastInline(node.children)),
    kind: "heading",
    level: node.depth,
  };
}

function canonicalizeMdastBlockquote(node: MdastBlockquote): CanonicalBlock {
  return {
    content: canonicalizeBlocks(node.children),
    kind: "blockquote",
  };
}

function canonicalizeMdastCode(node: MdastCode): CanonicalBlock {
  return {
    kind: "codeBlock",
    language: node.lang ?? null,
    value: node.value.replace(/\n$/u, ""),
  };
}

function isEmptyCanonicalBlock(block: CanonicalBlock): boolean {
  return (
    (block.kind === "paragraph" ||
      block.kind === "heading" ||
      block.kind === "blockquote") &&
    block.content.length === 0
  );
}

function finalizeCanonicalBlocks(
  blocks: readonly CanonicalBlock[],
): CanonicalBlock[] {
  return mergeAdjacentLists(
    blocks.filter((block) => !isEmptyCanonicalBlock(block)),
  );
}

function canonicalizeBlocks(nodes: readonly RootContent[]): CanonicalBlock[] {
  return finalizeCanonicalBlocks(nodes.map(canonicalizeMdastBlock));
}

function mergeAdjacentLists(blocks: readonly CanonicalBlock[]): CanonicalBlock[] {
  const result: CanonicalBlock[] = [];

  for (const block of blocks) {
    const previous = result[result.length - 1];
    if (
      previous?.kind === "list" &&
      block.kind === "list" &&
      !previous.ordered &&
      !block.ordered
    ) {
      result[result.length - 1] = {
        ...previous,
        items: [...previous.items, ...block.items],
        task: previous.task || block.task,
      };
      continue;
    }

    result.push(block);
  }

  return result;
}

function tiptapMarks(node: JSONContent): CanonicalMark[] {
  const marks: CanonicalMark[] = [];

  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case "bold":
        marks.push({ type: "bold" });
        break;
      case "italic":
        marks.push({ type: "italic" });
        break;
      case "code":
        marks.push({ type: "code" });
        break;
      case "link":
        marks.push({
          href: String(mark.attrs?.href ?? ""),
          title:
            typeof mark.attrs?.title === "string" ? mark.attrs.title : null,
          type: "link",
        });
        break;
      default:
        throw new Error(`Nepodporovaný formát vizuálního editoru: ${mark.type}.`);
    }
  }

  return marks;
}

function tiptapInline(nodes: readonly JSONContent[] | undefined): CanonicalInline[] {
  const result: CanonicalInline[] = [];

  for (const node of nodes ?? []) {
    switch (node.type) {
      case "text": {
        const marks = tiptapMarks(node);
        pushText(
          result,
          node.text ?? "",
          marks,
          !marks.some((mark) => mark.type === "code"),
        );
        break;
      }
      case "hardBreak":
        pushBreak(result, tiptapMarks(node));
        break;
      default:
        throw new Error(
          `Nepodporovaný inline uzel vizuálního editoru: ${node.type}.`,
        );
    }
  }

  return result;
}

function tiptapListItems(
  node: JSONContent,
  checked: boolean | null,
): CanonicalListItem[] {
  return (node.content ?? []).map((item) => ({
    checked:
      checked === null
        ? null
        : item.attrs?.checked === true,
    content: canonicalizeTiptapBlocks(item.content),
  }));
}

function canonicalizeTiptapBlock(node: JSONContent): CanonicalBlock {
  switch (node.type) {
    case "paragraph":
      return {
        content: trimInline(tiptapInline(node.content)),
        kind: "paragraph",
      };
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      if (!Number.isInteger(level) || level < 1 || level > 3) {
        throw new Error(`Nepodporovaná úroveň nadpisu: ${level}.`);
      }

      return {
        content: trimInline(tiptapInline(node.content)),
        kind: "heading",
        level,
      };
    }
    case "blockquote":
      return {
        content: canonicalizeTiptapBlocks(node.content),
        kind: "blockquote",
      };
    case "bulletList":
      return {
        items: tiptapListItems(node, null),
        kind: "list",
        ordered: false,
        start: null,
        task: false,
      };
    case "orderedList":
      return {
        items: tiptapListItems(node, null),
        kind: "list",
        ordered: true,
        start: Number(node.attrs?.start ?? 1),
        task: false,
      };
    case "taskList":
      return {
        items: tiptapListItems(node, false),
        kind: "list",
        ordered: false,
        start: null,
        task: true,
      };
    case "codeBlock":
      return {
        kind: "codeBlock",
        language:
          typeof node.attrs?.language === "string" ? node.attrs.language : null,
        value: (node.content ?? [])
          .map((child) => child.text ?? "")
          .join("")
          .replace(/\n$/u, ""),
      };
    default:
      throw new Error(
        `Nepodporovaný blok vizuálního editoru: ${node.type}.`,
      );
  }
}

function canonicalizeTiptapBlocks(
  nodes: readonly JSONContent[] | undefined,
): CanonicalBlock[] {
  return finalizeCanonicalBlocks(
    (nodes ?? []).map(canonicalizeTiptapBlock),
  );
}

export function canonicalizeMarkdownAst(ast: Root): CanonicalBlock[] {
  return canonicalizeBlocks(ast.children);
}

export function canonicalizeEditorJson(json: JSONContent): CanonicalBlock[] {
  if (json.type !== "doc") {
    throw new Error("Vizuální dokument nemá očekávaný kořen.");
  }

  return canonicalizeTiptapBlocks(json.content);
}

function canonicalJson(blocks: readonly CanonicalBlock[]): string {
  return JSON.stringify(blocks);
}

export function canonicalBlocksEqual(
  left: readonly CanonicalBlock[],
  right: readonly CanonicalBlock[],
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function convertMarkdownToVisual(markdown: string): JSONContent {
  const parsed = parseNoteMarkdown(markdown);
  if (parsed.sourceOnly) {
    throw new VisualConversionError({ parsed, reason: "unsupported" });
  }

  let rawJson: JSONContent;
  try {
    rawJson = markdownManager.parse(prepareMarkdownForVisual(markdown));
  } catch (error) {
    throw new VisualConversionError({
      detail: error instanceof Error ? error.message : "neznámá chyba převodu",
      reason: "lossy",
    });
  }

  const json = normalizeTaskItemHardBreaks(
    ensureListItemContent(decodeLinkAttributes(rawJson)),
  );
  const expected = canonicalizeMarkdownAst(parsed.ast);

  let parsedCanonical: CanonicalBlock[];
  try {
    parsedCanonical = canonicalizeEditorJson(json);
  } catch (error) {
    throw new VisualConversionError({
      detail: error instanceof Error ? error.message : "neznámá chyba převodu",
      reason: "lossy",
    });
  }

  if (!canonicalBlocksEqual(expected, parsedCanonical)) {
    throw new VisualConversionError({
      detail: "Rozbor Markdownu a vizuální dokument se neshodují.",
      reason: "lossy",
    });
  }

  let roundTrip: string;
  try {
    roundTrip = markdownManager.serialize(json);
  } catch (error) {
    throw new VisualConversionError({
      detail: error instanceof Error ? error.message : "neznámá chyba převodu",
      reason: "lossy",
    });
  }

  const roundTripParsed = parseNoteMarkdown(roundTrip);
  if (roundTripParsed.sourceOnly) {
    throw new VisualConversionError({
      detail: "Zpětný převod vytvořil nepodporovaný Markdown.",
      reason: "lossy",
    });
  }

  if (roundTripParsed.graphemeCount !== parsed.graphemeCount) {
    throw new VisualConversionError({
      detail: "Zpětný převod změnil počet viditelných znaků.",
      reason: "lossy",
    });
  }

  if (
    !canonicalBlocksEqual(
      expected,
      canonicalizeMarkdownAst(roundTripParsed.ast),
    )
  ) {
    throw new VisualConversionError({
      detail: "Zpětný převod změnil význam Markdownu.",
      reason: "lossy",
    });
  }

  return json;
}

export function serializeVisualJson(input: JSONContent): string {
  const json = normalizeTaskItemHardBreaks(
    ensureListItemContent(decodeLinkAttributes(input)),
  );
  const expected = canonicalizeEditorJson(json);

  let markdown: string;
  try {
    markdown = markdownManager.serialize(json);
  } catch (error) {
    throw new VisualSerializationError(
      error instanceof Error ? error.message : "neznámá chyba převodu",
    );
  }

  const parsed = parseNoteMarkdown(markdown);

  if (parsed.sourceOnly) {
    throw new VisualSerializationError(
      "Vizuální dokument vytvořil nepodporovaný Markdown.",
    );
  }

  if (!canonicalBlocksEqual(expected, canonicalizeMarkdownAst(parsed.ast))) {
    throw new VisualSerializationError(
      "Vizuální dokument a vytvořený Markdown se neshodují.",
    );
  }

  return markdown;
}

export function assertVisualEditorRoundTrip(markdown: string): string {
  const json = convertMarkdownToVisual(markdown);
  return serializeVisualJson(json);
}
