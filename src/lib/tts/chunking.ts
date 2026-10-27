import { TTS_MAX_INPUT_CODE_UNITS } from "./provider.ts";

export class TtsTextError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TtsTextError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface TtsChunk {
  readonly index: number;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const sentenceSegmenter = new Intl.Segmenter("cs", {
  granularity: "sentence",
});
const graphemeSegmenter = new Intl.Segmenter("cs", {
  granularity: "grapheme",
});

function maxBoundaryAtOrBefore(
  boundaries: readonly number[],
  limit: number,
  after: number,
): number | null {
  let selected: number | null = null;

  for (const boundary of boundaries) {
    if (boundary > limit) {
      break;
    }

    if (boundary > after) {
      selected = boundary;
    }
  }

  return selected;
}

function paragraphBoundaries(text: string): number[] {
  const boundaries: number[] = [];
  const pattern = /\n+/gu;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    boundaries.push(match.index + match[0].length);
  }

  return boundaries;
}

function sentenceBoundaries(text: string): number[] {
  const boundaries: number[] = [];

  for (const segment of sentenceSegmenter.segment(text)) {
    boundaries.push(segment.index + segment.segment.length);
  }

  return boundaries;
}

function graphemeBoundaries(
  text: string,
  maxCodeUnits: number,
): number[] {
  const boundaries: number[] = [];

  for (const segment of graphemeSegmenter.segment(text)) {
    if (segment.segment.length > maxCodeUnits) {
      throw new TtsTextError(
        422,
        "tts_unspeakable_section",
        "Vybraný text obsahuje znak, který nelze rozdělit do povoleného limitu. Zkraťte výběr.",
        {
          grapheme: segment.segment,
          codeUnits: segment.segment.length,
          maxCodeUnits,
        },
      );
    }

    boundaries.push(segment.index + segment.segment.length);
  }

  return boundaries;
}

export function chunkText(
  text: string,
  maxCodeUnits: number = TTS_MAX_INPUT_CODE_UNITS,
): TtsChunk[] {
  if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits < 1) {
    throw new RangeError("Limit chunku musí být kladné celé číslo.");
  }

  if (text.trim() === "") {
    throw new TtsTextError(
      400,
      "tts_empty_selection",
      "Vybraný text neobsahuje nic, co by šlo přečíst nahlas.",
    );
  }

  const paragraphEnds = paragraphBoundaries(text);
  const sentenceEnds = sentenceBoundaries(text);
  const graphemeEnds = graphemeBoundaries(text, maxCodeUnits);
  const chunks: TtsChunk[] = [];
  let start = 0;

  while (start < text.length) {
    if (text.length - start <= maxCodeUnits) {
      chunks.push({
        index: chunks.length,
        text: text.slice(start),
        start,
        end: text.length,
      });
      break;
    }

    const limit = start + maxCodeUnits;
    const cut =
      maxBoundaryAtOrBefore(paragraphEnds, limit, start) ??
      maxBoundaryAtOrBefore(sentenceEnds, limit, start) ??
      maxBoundaryAtOrBefore(graphemeEnds, limit, start);

    if (cut === null) {
      throw new TtsTextError(
        422,
        "tts_unspeakable_section",
        "Vybraný text nelze bezpečně rozdělit do povoleného limitu. Zkraťte výběr.",
        { start, maxCodeUnits },
      );
    }

    chunks.push({
      index: chunks.length,
      text: text.slice(start, cut),
      start,
      end: cut,
    });
    start = cut;
  }

  return chunks;
}
