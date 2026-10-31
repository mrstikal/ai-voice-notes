import {
  AlignmentType,
  BorderStyle,
  CheckBox,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
  UnderlineType,
  type IParagraphOptions,
  type IRunOptions,
  type NumberingDefinition,
  type ParagraphChild,
} from "docx";
import type {
  Heading,
  List,
  ListItem,
  PhrasingContent,
  RootContent,
} from "mdast";

import {
  assertLosslessConversionSupported,
  parseNoteMarkdown,
} from "./markdown.ts";

export const DOCX_EXPORT_MAX_BYTES = 8 * 1024 * 1024;

const CZECH_LANGUAGE = { value: "cs-CZ" } as const;
const LIST_INDENT = 720;
const QUOTE_INDENT = 720;
const MAX_LIST_LEVEL = 8;

export class DocxListDepthError extends Error {
  constructor() {
    super(
      `Seznam je vnořený hlouběji než ${MAX_LIST_LEVEL + 1} úrovní, které DOCX umí věrně zobrazit.`,
    );
    this.name = "DocxListDepthError";
  }
}

export class DocxExportTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(
      `Exportovaný DOCX překračuje povolený limit ${maxBytes} bajtů.`,
    );
    this.name = "DocxExportTooLargeError";
    this.maxBytes = maxBytes;
  }
}

interface RenderContext {
  nextOrderedListId: number;
}

interface InlineFormat {
  readonly bold?: boolean;
  readonly italics?: boolean;
  readonly link?: boolean;
}

interface ParagraphContext {
  readonly quoteDepth: number;
  readonly continuationIndent?: number;
}

export interface NoteDocxOptions {
  readonly maxBytes?: number;
}

function clampListLevel(depth: number): number {
  return Math.max(0, Math.min(MAX_LIST_LEVEL, depth));
}

function headingLevel(depth: Heading["depth"]): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  switch (depth) {
    case 1:
      return HeadingLevel.HEADING_1;
    case 2:
      return HeadingLevel.HEADING_2;
    default:
      return HeadingLevel.HEADING_3;
  }
}

function normalizedText(value: string): string {
  return value.replace(/\s*\n\s*/g, " ");
}

function runOptions(format: InlineFormat): IRunOptions {
  return {
    bold: format.bold,
    italics: format.italics,
    language: CZECH_LANGUAGE,
    ...(format.link
      ? {
          color: "0563C1",
          style: "Hyperlink",
          underline: { type: UnderlineType.SINGLE },
        }
      : {}),
  };
}

function inlineChildren(
  nodes: readonly PhrasingContent[],
  format: InlineFormat,
): ParagraphChild[] {
  const children: ParagraphChild[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case "text": {
        const text = normalizedText(node.value);

        if (text !== "") {
          children.push(new TextRun({ ...runOptions(format), text }));
        }
        break;
      }
      case "strong":
        children.push(
          ...inlineChildren(node.children, { ...format, bold: true }),
        );
        break;
      case "emphasis":
        children.push(
          ...inlineChildren(node.children, { ...format, italics: true }),
        );
        break;
      case "inlineCode":
        children.push(
          new TextRun({
            ...runOptions(format),
            font: "Courier New",
            shading: { fill: "F2F2F2" },
            size: 20,
            text: node.value,
          }),
        );
        break;
      case "break":
        children.push(new TextRun({ break: 1, language: CZECH_LANGUAGE }));
        break;
      case "link": {
        if (format.link) {
          children.push(...inlineChildren(node.children, format));
          break;
        }

        const linkChildren = inlineChildren(node.children, {
          ...format,
          link: true,
        });
        children.push(
          new ExternalHyperlink({
            children:
              linkChildren.length > 0
                ? linkChildren
                : [
                    new TextRun({
                      ...runOptions({ ...format, link: true }),
                      text: node.url,
                    }),
                  ],
            link: node.url,
          }),
        );
        break;
      }
      default:
        break;
    }
  }

  return children;
}

function paragraphOptions(context: ParagraphContext): IParagraphOptions {
  const indent =
    context.quoteDepth * QUOTE_INDENT + (context.continuationIndent ?? 0);

  return {
    ...(context.quoteDepth > 0
      ? {
          border: {
            left: {
              color: "B8B8B8",
              size: 6,
              space: 8,
              style: BorderStyle.SINGLE,
            },
          },
        }
      : {}),
    ...(indent > 0 ? { indent: { left: indent } } : {}),
  };
}

function textParagraph(
  children: readonly PhrasingContent[],
  paragraphContext: ParagraphContext,
  options: IParagraphOptions = {},
  taskChecked: boolean | null = null,
): Paragraph {
  const runs: ParagraphChild[] = [];

  if (taskChecked !== null) {
    runs.push(
      new CheckBox({
        checked: taskChecked,
        checkedState: { font: "MS Gothic", value: "2612" },
        uncheckedState: { font: "MS Gothic", value: "2610" },
      }),
      new TextRun({ language: CZECH_LANGUAGE, text: " " }),
    );
  }

  runs.push(...inlineChildren(children, {}));

  return new Paragraph({
    ...paragraphOptions(paragraphContext),
    ...options,
    children: runs,
    includeIfEmpty: true,
  });
}

function codeParagraph(
  value: string,
  paragraphContext: ParagraphContext,
  options: IParagraphOptions = {},
): Paragraph {
  const lines = value.split(/\r\n|\r|\n/);
  const children = lines.map(
    (line, index) =>
      new TextRun({
        break: index === 0 ? undefined : 1,
        font: "Courier New",
        language: CZECH_LANGUAGE,
        size: 18,
        text: line,
      }),
  );

  return new Paragraph({
    ...paragraphOptions(paragraphContext),
    ...options,
    children,
    includeIfEmpty: true,
    shading: { fill: "F2F2F2" },
    spacing: { after: 160, before: 160 },
  });
}

function orderedListDefinition(
  start: number,
  context: RenderContext,
): NumberingDefinition {
  const reference = `note-ordered-list-${context.nextOrderedListId}`;
  context.nextOrderedListId += 1;

  return {
    reference,
    levels: Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, level) => ({
      alignment: AlignmentType.START,
      format: LevelFormat.DECIMAL,
      level,
      start,
      style: {
        paragraph: {
          indent: {
            hanging: 360,
            left: (level + 1) * LIST_INDENT,
          },
        },
      },
      text: `%${level + 1}.`,
    })),
  };
}

function listItemParagraphOptions(
  list: List,
  depth: number,
  definition: NumberingDefinition | null,
  quoteDepth: number,
  task: boolean,
): IParagraphOptions {
  const level = clampListLevel(depth);
  const quote = quoteDepth > 0
    ? {
        border: {
          left: {
            color: "B8B8B8",
            size: 6,
            space: 8,
            style: BorderStyle.SINGLE,
          },
        },
      }
    : {};

  if (task) {
    return {
      ...quote,
      indent: {
        left: (level + 1) * LIST_INDENT + quoteDepth * QUOTE_INDENT,
      },
    };
  }

  return {
    ...quote,
    ...(list.ordered && definition
      ? { numbering: { level, reference: definition } }
      : { bullet: { level } }),
  };
}

function renderListItemBlocks(
  item: ListItem,
  depth: number,
  context: RenderContext,
  quoteDepth: number,
  list: List,
  definition: NumberingDefinition | null,
): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let isFirstBlock = true;
  const continuationIndent = (clampListLevel(depth) + 1) * LIST_INDENT;

  for (const child of item.children) {
    if (child.type === "list") {
      paragraphs.push(
        ...renderList(child, context, depth + 1, quoteDepth),
      );
      isFirstBlock = false;
      continue;
    }

    if (child.type === "paragraph") {
      paragraphs.push(
        textParagraph(
          child.children,
          isFirstBlock
            ? { quoteDepth }
            : { continuationIndent, quoteDepth },
          isFirstBlock
            ? listItemParagraphOptions(
                list,
                depth,
                definition,
                quoteDepth,
                typeof item.checked === "boolean",
              )
            : {},
          isFirstBlock ? item.checked ?? null : null,
        ),
      );
      isFirstBlock = false;
      continue;
    }

    if (child.type === "heading") {
      paragraphs.push(
        textParagraph(
          child.children,
          isFirstBlock
            ? { quoteDepth }
            : { continuationIndent, quoteDepth },
          {
            ...(isFirstBlock
              ? listItemParagraphOptions(
                  list,
                  depth,
                  definition,
                  quoteDepth,
                  typeof item.checked === "boolean",
                )
              : {}),
            heading: headingLevel(child.depth),
          },
          isFirstBlock ? item.checked ?? null : null,
        ),
      );
      isFirstBlock = false;
      continue;
    }

    if (child.type === "code") {
      paragraphs.push(
        codeParagraph(
          child.value,
          {
            continuationIndent: isFirstBlock
              ? (clampListLevel(depth) + 1) * LIST_INDENT
              : continuationIndent,
            quoteDepth,
          },
          isFirstBlock
            ? listItemParagraphOptions(
                list,
                depth,
                definition,
                quoteDepth,
                typeof item.checked === "boolean",
              )
            : {},
        ),
      );
      isFirstBlock = false;
      continue;
    }

    if (child.type === "blockquote") {
      paragraphs.push(
        ...renderBlocks(child.children, context, quoteDepth + 1),
      );
      isFirstBlock = false;
    }
  }

  return paragraphs;
}

function renderList(
  list: List,
  context: RenderContext,
  depth: number,
  quoteDepth: number,
): Paragraph[] {
  if (depth > MAX_LIST_LEVEL) {
    throw new DocxListDepthError();
  }

  const definition = list.ordered
    ? orderedListDefinition(list.start ?? 1, context)
    : null;
  const paragraphs: Paragraph[] = [];

  for (const item of list.children) {
    paragraphs.push(
      ...renderListItemBlocks(
        item,
        depth,
        context,
        quoteDepth,
        list,
        definition,
      ),
    );
  }

  return paragraphs;
}

function renderBlock(
  node: RootContent,
  context: RenderContext,
  quoteDepth: number,
): Paragraph[] {
  switch (node.type) {
    case "heading":
      return [
        textParagraph(node.children, { quoteDepth }, {
          heading: headingLevel(node.depth),
        }),
      ];
    case "paragraph":
      return [textParagraph(node.children, { quoteDepth })];
    case "code":
      return [codeParagraph(node.value, { quoteDepth })];
    case "blockquote":
      return renderBlocks(node.children, context, quoteDepth + 1);
    case "list":
      return renderList(node, context, 0, quoteDepth);
    default:
      return [];
  }
}

function renderBlocks(
  nodes: readonly RootContent[],
  context: RenderContext,
  quoteDepth: number,
): Paragraph[] {
  return nodes.flatMap((node) => renderBlock(node, context, quoteDepth));
}

function plainInlineText(nodes: readonly PhrasingContent[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "inlineCode":
          return node.value;
        case "strong":
        case "emphasis":
        case "link":
          return plainInlineText(node.children);
        case "break":
          return "\n";
        default:
          return "";
      }
    })
    .join("");
}

function startsWithMatchingHeading(
  blocks: readonly RootContent[],
  title: string,
): boolean {
  const first = blocks[0];

  return (
    first?.type === "heading" &&
    first.depth === 1 &&
    plainInlineText(first.children).trim() === title
  );
}

function buildDocument(
  title: string,
  blocks: readonly RootContent[],
): Document {
  const context: RenderContext = { nextOrderedListId: 1 };
  const trimmedTitle = title.trim();
  const body = renderBlocks(blocks, context, 0);

  if (
    trimmedTitle !== "" &&
    !startsWithMatchingHeading(blocks, trimmedTitle)
  ) {
    body.unshift(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [
          new TextRun({
            bold: true,
            language: CZECH_LANGUAGE,
            text: trimmedTitle,
          }),
        ],
      }),
    );
  }

  return new Document({
    creator: "AI Voice Notes",
    description: "Export poznámky z aplikace AI Voice Notes.",
    styles: {
      default: {
        document: {
          paragraph: {
            spacing: { after: 120, line: 276 },
          },
          run: {
            language: CZECH_LANGUAGE,
            size: 22,
          },
        },
        hyperlink: {
          run: {
            color: "0563C1",
            underline: { type: UnderlineType.SINGLE },
          },
        },
        title: {
          run: {
            bold: true,
            language: CZECH_LANGUAGE,
            size: 36,
          },
        },
      },
    },
    sections: [{ children: body }],
    title: trimmedTitle,
  });
}

export async function renderNoteDocx(
  title: string,
  contentMd: string,
  options: NoteDocxOptions = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DOCX_EXPORT_MAX_BYTES;

  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("Limit velikosti DOCX musí být kladné celé číslo.");
  }

  const parsed = parseNoteMarkdown(contentMd);

  assertLosslessConversionSupported(parsed, "docx");

  const buffer = await Packer.toBuffer(buildDocument(title, parsed.ast.children));

  if (buffer.byteLength > maxBytes) {
    throw new DocxExportTooLargeError(maxBytes);
  }

  return buffer;
}
