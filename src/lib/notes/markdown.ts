import type {
  Heading,
  Link,
  List,
  ListItem,
  PhrasingContent,
  Root,
  RootContent,
} from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";

import { countGraphemes } from "./limits.ts";

export const SAFE_LINK_PROTOCOLS = ["http:", "https:", "mailto:"] as const;

const SUPPORTED_NODE_TYPES = new Set([
  "root",
  "heading",
  "paragraph",
  "text",
  "strong",
  "emphasis",
  "break",
  "blockquote",
  "list",
  "listItem",
  "link",
  "inlineCode",
  "code",
]);

const markdownProcessor = unified().use(remarkParse).use(remarkGfm);

export type SourceOnlyReason =
  | { readonly type: "unsupported_node"; readonly nodeType: string }
  | { readonly type: "unsupported_heading_depth"; readonly depth: number }
  | { readonly type: "unsafe_link"; readonly url: string };

export type ConversionTarget = "visual" | "docx";

export interface SafeMarkdownLink {
  readonly url: string;
  readonly text: string;
}

export interface ParsedNoteMarkdown {
  readonly source: string;
  readonly ast: Root;
  readonly plainText: string;
  readonly searchText: string;
  readonly graphemeCount: number;
  readonly sourceOnly: boolean;
  readonly sourceOnlyReasons: readonly SourceOnlyReason[];
  readonly safeLinks: readonly SafeMarkdownLink[];
}

export class UnsupportedMarkdownError extends Error {
  readonly target: ConversionTarget;
  readonly reasons: readonly SourceOnlyReason[];

  constructor(target: ConversionTarget, reasons: readonly SourceOnlyReason[]) {
    super(
      target === "visual"
        ? "Tento obsah nelze zobrazit ve vizuálním editoru, protože obsahuje nepodporovaný Markdown. Upravte jej ve zdrojovém režimu."
        : "Tento obsah nelze převést do DOCX, protože obsahuje nepodporovaný Markdown.",
    );
    this.name = "UnsupportedMarkdownError";
    this.target = target;
    this.reasons = reasons;
  }
}

const UNSAFE_LINK_VALUE_PATTERN = /[\u0000-\u001F\u007F\s\\\p{Cf}]/u;
const UNSAFE_LINK_DECODED_PATTERN = /[\u0000-\u001F\u007F\\\p{Cf}]/u;
const MAX_PERCENT_DECODE_PASSES = 8;

function decodePercentEscapesTolerantly(value: string): string | null {
  let current = value;

  for (let pass = 0; pass < MAX_PERCENT_DECODE_PASSES; pass += 1) {
    let changed = false;
    let next = "";

    for (let index = 0; index < current.length; index += 1) {
      const character = current.charAt(index);
      if (character !== "%") {
        next += character;
        continue;
      }

      const hex = current.slice(index + 1, index + 3);
      if (!/^[0-9a-f]{2}$/iu.test(hex)) {
        next += character;
        continue;
      }

      next += String.fromCharCode(Number.parseInt(hex, 16));
      index += 2;
      changed = true;
    }

    if (!changed) {
      return next;
    }

    current = next;
  }

  return null;
}

function hasUnsafeScheme(raw: string, decoded: string): boolean {
  const firstSegment = decoded.split(/[/?#]/, 1)[0] ?? "";
  const colonIndex = firstSegment.indexOf(":");

  if (colonIndex === -1) {
    return false;
  }

  const scheme = firstSegment.slice(0, colonIndex).trim().toLowerCase();

  if (scheme === "http" || scheme === "https") {
    for (const candidate of [raw, decoded]) {
      try {
        return new URL(candidate).hostname === "";
      } catch {
        continue;
      }
    }

    return true;
  }

  return scheme !== "mailto";
}

export function isSafeLinkDestination(destination: string): boolean {
  const value = destination.trim();

  if (value === "" || value !== destination) {
    return false;
  }

  if (UNSAFE_LINK_VALUE_PATTERN.test(value)) {
    return false;
  }

  if (value.startsWith("//")) {
    return false;
  }

  const decoded = decodePercentEscapesTolerantly(value);
  if (
    decoded === null ||
    decoded.startsWith("//") ||
    UNSAFE_LINK_DECODED_PATTERN.test(decoded)
  ) {
    return false;
  }

  return !hasUnsafeScheme(value, decoded);
}

export function parseMarkdown(source: string): Root {
  return markdownProcessor.parse(source);
}

export function collectMarkdownReasons(
  root: Root | RootContent,
): SourceOnlyReason[] {
  const reasons: SourceOnlyReason[] = [];

  visit(root, (node) => {
    if (node.type === "heading") {
      const heading = node as Heading;
      if (heading.depth < 1 || heading.depth > 3) {
        reasons.push({
          type: "unsupported_heading_depth",
          depth: heading.depth,
        });
        return SKIP;
      }

      return;
    }

    if (node.type === "link") {
      const link = node as Link;
      if (!isSafeLinkDestination(link.url)) {
        reasons.push({ type: "unsafe_link", url: link.url });
      }

      return;
    }

    if (!SUPPORTED_NODE_TYPES.has(node.type)) {
      reasons.push({ type: "unsupported_node", nodeType: node.type });
      return SKIP;
    }
  });

  return reasons;
}

export function renderMarkdownInline(
  nodes: readonly PhrasingContent[],
): string {
  return nodes.map(renderInlineNode).join("");
}

function renderInlineNode(node: PhrasingContent): string {
  switch (node.type) {
    case "text":
      return node.value.replace(/\s*\n\s*/g, " ");
    case "strong":
    case "emphasis":
    case "link":
      return renderMarkdownInline(node.children);
    case "inlineCode":
      return node.value;
    case "break":
      return "\n";
    default:
      return "";
  }
}

function renderListItem(item: ListItem): string {
  return item.children
    .map(renderMarkdownBlock)
    .filter((block) => block.length > 0)
    .join("\n");
}

function renderList(node: List): string {
  return node.children
    .map(renderListItem)
    .filter((item) => item.length > 0)
    .join("\n");
}

export function renderMarkdownBlock(node: RootContent): string {
  switch (node.type) {
    case "heading":
    case "paragraph":
      return renderMarkdownInline(node.children);
    case "blockquote":
      return renderBlocks(node.children);
    case "list":
      return renderList(node);
    case "code":
      return node.value;
    default:
      return "";
  }
}

function renderBlocks(nodes: readonly RootContent[]): string {
  return nodes
    .map(renderMarkdownBlock)
    .filter((block) => block.length > 0)
    .join("\n\n");
}

function collectSafeLinks(root: Root): SafeMarkdownLink[] {
  const links: SafeMarkdownLink[] = [];

  visit(root, "link", (node) => {
    if (isSafeLinkDestination(node.url)) {
      links.push({ url: node.url, text: renderMarkdownInline(node.children) });
    }
  });

  return links;
}

export function parseNoteMarkdown(source: string): ParsedNoteMarkdown {
  const ast = parseMarkdown(source);
  const sourceOnlyReasons = collectMarkdownReasons(ast);
  const sourceOnly = sourceOnlyReasons.length > 0;
  const plainText = sourceOnly ? source : renderBlocks(ast.children);
  const searchText = sourceOnly ? source : plainText;

  return {
    source,
    ast,
    plainText,
    searchText,
    graphemeCount: countGraphemes(plainText),
    sourceOnly,
    sourceOnlyReasons,
    safeLinks: sourceOnly ? [] : collectSafeLinks(ast),
  };
}

export function assertLosslessConversionSupported(
  parsed: ParsedNoteMarkdown,
  target: ConversionTarget,
): void {
  if (parsed.sourceOnly) {
    throw new UnsupportedMarkdownError(target, parsed.sourceOnlyReasons);
  }
}
