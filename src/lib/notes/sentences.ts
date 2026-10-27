import type { Root, RootContent } from "mdast";

import { renderMarkdownBlock } from "./markdown.ts";

const sentenceSegmenter = new Intl.Segmenter("cs", {
  granularity: "sentence",
});

export interface SentenceSpan {
  readonly sentenceIndex: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface ProseBlock {
  readonly blockIndex: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly sentences: readonly SentenceSpan[];
}

export interface UnsupportedProseBlock {
  readonly blockIndex: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly reason: "unsupported_inline_markup";
}

export interface ProseCollection {
  readonly plain: readonly ProseBlock[];
  readonly unsupported: readonly UnsupportedProseBlock[];
}

export function normalizeMatchText(value: string): string {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("cs")
    .replace(/[\s\p{P}]+/gu, " ")
    .trim();
}

export function matchesPhrases(
  text: string,
  startPhrase: string,
  endPhrase: string,
): boolean {
  const normalized = normalizeMatchText(text);
  const start = normalizeMatchText(startPhrase);
  const end = normalizeMatchText(endPhrase);

  return (
    normalized !== "" &&
    start !== "" &&
    end !== "" &&
    normalized.startsWith(start) &&
    normalized.endsWith(end)
  );
}

export function containsPhrases(
  text: string,
  startPhrase: string,
  endPhrase: string,
): boolean {
  return matchesPhrases(text, startPhrase, endPhrase);
}

interface SourceMapping {
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

function mapRenderedToSource(
  rendered: string,
  source: string,
  sourceOffset: number,
): SourceMapping | null {
  const starts: number[] = [];
  const ends: number[] = [];
  let sourceIndex = 0;

  for (let renderedIndex = 0; renderedIndex < rendered.length; renderedIndex += 1) {
    const character = rendered.charAt(renderedIndex);

    if (/\s/u.test(character)) {
      const start = sourceIndex;

      while (sourceIndex < source.length && /\s/u.test(source.charAt(sourceIndex))) {
        sourceIndex += 1;
      }

      if (sourceIndex === start) {
        return null;
      }

      const run = source.slice(start, sourceIndex);

      if (/[\r\n]/u.test(run)) {
        if (character === "\n" || character === "\r") {
          // A hard break stays as a rendered line ending. Consume through
          // that newline; if the rendering has no following whitespace,
          // also consume the stripped indentation of the continuation line.
          const crlf = run.indexOf("\r\n");
          const newline = crlf === -1 ? run.search(/[\r\n]/u) : crlf;
          const consumed = crlf === -1 ? newline + 1 : newline + 2;
          const runEnd = sourceIndex;
          const nextRendered = rendered.charAt(renderedIndex + 1);

          sourceIndex = start + consumed;

          if (nextRendered === "" || !/\s/u.test(nextRendered)) {
            while (
              sourceIndex < runEnd &&
              /\s/u.test(source.charAt(sourceIndex))
            ) {
              sourceIndex += 1;
            }
          }

          starts.push(sourceOffset + start);
          ends.push(sourceOffset + sourceIndex);
          continue;
        }

        // A soft break is collapsed to one rendered space, so the whole
        // source whitespace run belongs to this rendered space.
        starts.push(sourceOffset + start);
        ends.push(sourceOffset + sourceIndex);
        continue;
      }

      // Plain multiple spaces are preserved in the rendering; align them one
      // source character per rendered character and rewind the rest of the
      // run for the next rendered whitespace character.
      sourceIndex = start + 1;
      starts.push(sourceOffset + start);
      ends.push(sourceOffset + start + 1);
      continue;
    }

    if (source.charAt(sourceIndex) !== character) {
      return null;
    }

    starts.push(sourceOffset + sourceIndex);
    ends.push(sourceOffset + sourceIndex + 1);
    sourceIndex += 1;
  }

  return { starts, ends };
}

function segmentSentences(
  text: string,
  sourceOffset: number,
  mapping: SourceMapping | null = null,
): SentenceSpan[] {
  const sentences: SentenceSpan[] = [];
  let sentenceIndex = 0;

  for (const segment of sentenceSegmenter.segment(text)) {
    const raw = segment.segment;
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;

    if (leading + trailing >= raw.length) {
      continue;
    }

    const renderedStart = segment.index + leading;
    const renderedEnd = segment.index + raw.length - trailing;
    const start =
      mapping === null
        ? sourceOffset + renderedStart
        : mapping.starts[renderedStart];
    const end =
      mapping === null
        ? sourceOffset + renderedEnd
        : mapping.ends[renderedEnd - 1];

    if (start === undefined || end === undefined) {
      continue;
    }

    sentences.push({
      sentenceIndex,
      start,
      end,
      text: text.slice(renderedStart, renderedEnd),
    });
    sentenceIndex += 1;
  }

  return sentences;
}

function paragraphSource(
  node: RootContent,
  source: string,
): { readonly start: number; readonly end: number; readonly text: string } | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;

  if (start === undefined || end === undefined || end < start) {
    return null;
  }

  return {
    start,
    end,
    text: source.slice(start, end),
  };
}

export function collectProseBlocks(
  source: string,
  ast: Root,
): ProseCollection {
  const plain: ProseBlock[] = [];
  const unsupported: UnsupportedProseBlock[] = [];

  ast.children.forEach((node, blockIndex) => {
    if (node.type !== "paragraph") {
      return;
    }

    const location = paragraphSource(node, source);

    if (location === null) {
      return;
    }

    const rendered = renderMarkdownBlock(node);

    if (rendered.length === 0) {
      return;
    }

    const normalizedSource = location.text
      .replace(/\s+/gu, " ")
      .trim();
    const normalizedRendered = rendered.replace(/\s+/gu, " ").trim();

    if (normalizedSource !== normalizedRendered) {
      unsupported.push({
        blockIndex,
        start: location.start,
        end: location.end,
        text: rendered,
        reason: "unsupported_inline_markup",
      });
      return;
    }

    // Segment the whitespace-collapsed rendering so a soft/hard line break
    // does not split one sentence, then map every rendered boundary back to
    // the exact original Markdown source offsets.
    const mapping = mapRenderedToSource(
      rendered,
      location.text,
      location.start,
    );

    if (mapping === null) {
      unsupported.push({
        blockIndex,
        start: location.start,
        end: location.end,
        text: rendered,
        reason: "unsupported_inline_markup",
      });
      return;
    }

    plain.push({
      blockIndex,
      start: location.start,
      end: location.end,
      text: rendered,
      sentences: segmentSentences(rendered, location.start, mapping),
    });
  });

  return { plain, unsupported };
}

export function sentenceCandidates(
  prose: ProseCollection,
  startPhrase: string,
  endPhrase: string,
): {
  readonly matches: readonly {
    readonly block: ProseBlock;
    readonly sentence: SentenceSpan;
    readonly id: string;
    readonly ordinal: number;
    readonly snippet: string;
  }[];
  readonly unsupported: readonly UnsupportedProseBlock[];
} {
  const matches: {
    block: ProseBlock;
    sentence: SentenceSpan;
    id: string;
    ordinal: number;
    snippet: string;
  }[] = [];
  let ordinal = 1;

  for (const block of prose.plain) {
    for (const sentence of block.sentences) {
      if (!matchesPhrases(sentence.text, startPhrase, endPhrase)) {
        continue;
      }

      matches.push({
        block,
        sentence,
        id: `p${block.blockIndex}:s${sentence.sentenceIndex}`,
        ordinal,
        snippet: sentence.text,
      });
      ordinal += 1;
    }
  }

  return {
    matches,
    unsupported: prose.unsupported.filter((block) =>
      segmentSentences(block.text, block.start).some((sentence) =>
        matchesPhrases(sentence.text, startPhrase, endPhrase),
      ),
    ),
  };
}
