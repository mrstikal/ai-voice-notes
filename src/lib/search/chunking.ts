import { getEncoding } from "js-tiktoken";

import {
  collectTtsBlockSpans,
  type TtsBlockSpan,
} from "../tts/source-options.ts";
import { parseNoteMarkdown } from "../notes/markdown.ts";

export const CHUNK_MIN_TOKENS = 300;
export const CHUNK_MAX_TOKENS = 800;
export const PENDING_CHUNK_MODEL = "pending";

export interface SearchChunk {
  readonly chunkIndex: number;
  readonly text: string;
  readonly tokenCount: number;
}

const encoding = getEncoding("cl100k_base");
const graphemeSegmenter = new Intl.Segmenter("cs", {
  granularity: "grapheme",
});

const GRAPHEME_TOKEN_CACHE_MAX = 10_000;
const graphemeTokenCache = new Map<string, number>();

function tokenCount(text: string): number {
  const cached = graphemeTokenCache.get(text);

  if (cached !== undefined) {
    return cached;
  }

  const count = encoding.encode(text).length;

  if (
    text.length <= 256 &&
    graphemeTokenCache.size < GRAPHEME_TOKEN_CACHE_MAX
  ) {
    graphemeTokenCache.set(text, count);
  }

  return count;
}

function splitGraphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
}

function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?…])\s+/u).map((part) => part.trim());

  return parts.filter((part) => part !== "");
}

interface ChunkPiece {
  readonly text: string;
  readonly tokens: number;
}

function hardSplit(text: string): ChunkPiece[] {
  const pieces: ChunkPiece[] = [];
  let current = "";
  let currentTokens = 0;

  for (const grapheme of splitGraphemes(text)) {
    const graphemeTokens = tokenCount(grapheme);

    if (
      current !== "" &&
      currentTokens + graphemeTokens > CHUNK_MAX_TOKENS
    ) {
      pieces.push({ text: current, tokens: currentTokens });
      current = grapheme;
      currentTokens = graphemeTokens;
    } else {
      current += grapheme;
      currentTokens += graphemeTokens;
    }
  }

  if (current !== "") {
    pieces.push({ text: current, tokens: currentTokens });
  }

  return pieces;
}

function splitOversizedBlock(block: string): ChunkPiece[] {
  if (
    block.length <= 16_000 &&
    tokenCount(block) <= CHUNK_MAX_TOKENS
  ) {
    return [{ text: block, tokens: tokenCount(block) }];
  }

  const sentences = splitSentences(block);
  const pieces: ChunkPiece[] = [];

  for (const sentence of sentences.length > 0 ? sentences : [block]) {
    if (
      sentence.length <= 16_000 &&
      tokenCount(sentence) <= CHUNK_MAX_TOKENS
    ) {
      pieces.push({ text: sentence, tokens: tokenCount(sentence) });
    } else {
      pieces.push(...hardSplit(sentence));
    }
  }

  return pieces;
}

interface TextBlock {
  readonly startsHeading: boolean;
  readonly text: string;
}

function normalBlocks(contentMd: string): TextBlock[] {
  const parsed = parseNoteMarkdown(contentMd);
  const spans: TtsBlockSpan[] = collectTtsBlockSpans(parsed.ast);

  return spans
    .filter(
      (span) =>
        span.node.type === "heading" ||
        span.node.type === "paragraph" ||
        span.node.type === "code" ||
        span.node.type === "list" ||
        span.node.type === "blockquote",
    )
    .map((span) => ({
      startsHeading: span.node.type === "heading",
      text: span.text.trim(),
    }))
    .filter((block) => block.text !== "");
}

function sourceOnlyBlocks(contentMd: string): TextBlock[] {
  const parsed = parseNoteMarkdown(contentMd);
  const source = parsed.searchText.trim();

  if (source === "") {
    return [];
  }

  return source
    .split(/\n{2,}/u)
    .map((text) => ({ startsHeading: false, text: text.trim() }))
    .filter((block) => block.text !== "");
}

export function chunkNoteMarkdown(contentMd: string): SearchChunk[] {
  const parsed = parseNoteMarkdown(contentMd);
  const blocks = parsed.sourceOnly
    ? sourceOnlyBlocks(contentMd)
    : normalBlocks(contentMd);
  const chunks: ChunkPiece[] = [];
  let current = "";
  let currentTokens = 0;

  const flush = () => {
    if (current.trim() !== "") {
      chunks.push({ text: current.trim(), tokens: currentTokens });
      current = "";
      currentTokens = 0;
    }
  };

  for (const block of blocks) {
    if (block.startsHeading && current !== "") {
      flush();
    }

    const pieces = splitOversizedBlock(block.text);

    for (const piece of pieces) {
      const separatorTokens = current === "" ? 0 : tokenCount("\n\n");
      const candidateTokens =
        currentTokens + separatorTokens + piece.tokens;

      if (current !== "" && candidateTokens > CHUNK_MAX_TOKENS) {
        flush();
        current = piece.text;
        currentTokens = piece.tokens;
      } else {
        current =
          current === "" ? piece.text : `${current}\n\n${piece.text}`;
        currentTokens =
          currentTokens + separatorTokens + piece.tokens;
      }

      if (currentTokens >= CHUNK_MIN_TOKENS) {
        flush();
      }
    }
  }

  flush();

  return chunks.map((chunk, chunkIndex) => ({
    chunkIndex,
    text: chunk.text,
    tokenCount: chunk.tokens,
  }));
}
