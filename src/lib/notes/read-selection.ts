import { publicEnvInt } from "../env-limits.ts";
import { countGraphemes } from "./limits.ts";
import { parseNoteMarkdown } from "./markdown.ts";
import { TtsTextError } from "../tts/chunking.ts";
import {
  collectTtsBlockSpans,
  type TtsBlockSpan,
} from "../tts/source-options.ts";
import { selectTtsText } from "../tts/selection.ts";

export const READ_SELECTION_MAX_PARAGRAPHS = publicEnvInt(
  process.env.NEXT_PUBLIC_READ_SELECTION_MAX_PARAGRAPHS,
  "NEXT_PUBLIC_READ_SELECTION_MAX_PARAGRAPHS",
  5,
);
export const READ_SELECTION_TRANSCRIPT_MAX_GRAPHEMES = publicEnvInt(
  process.env.NEXT_PUBLIC_READ_SELECTION_TRANSCRIPT_MAX_GRAPHEMES,
  "NEXT_PUBLIC_READ_SELECTION_TRANSCRIPT_MAX_GRAPHEMES",
  500,
);

export type ReadSelectionScope =
  | "full"
  | "range"
  | "paragraph"
  | "tasks"
  | "last_paragraphs";

export interface ReadSelectionRequest {
  readonly transcript: string;
  readonly note: {
    readonly id: string;
    readonly contentMd: string;
    readonly version: number;
  };
  readonly selection?: {
    readonly start: number;
    readonly end: number;
  };
  readonly paragraphIndex?: number;
  readonly summary?: {
    readonly noteId: string;
    readonly noteVersion: number;
    readonly text: string;
  } | null;
}

export type ReadSelectionResult =
  | {
      readonly action: "read";
      readonly selection: {
        readonly scope: ReadSelectionScope;
        readonly start?: number;
        readonly end?: number;
        readonly paragraphIndex?: number;
        readonly count?: number;
      };
      readonly text: string;
      readonly noteVersion: number;
    }
  | {
      readonly action: "summary";
      readonly text: string;
      readonly noteVersion: number;
    }
  | {
      readonly action: "clarify";
      readonly message: string;
    }
  | {
      readonly action: "summary_missing";
      readonly message: string;
    }
  | {
      readonly action: "summary_stale";
      readonly message: string;
    };

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("cs")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const NUMBER_WORDS: Record<string, number> = {
  jeden: 1,
  jedna: 1,
  jedno: 1,
  dva: 2,
  dve: 2,
  tri: 3,
  ctyri: 4,
  pet: 5,
};

function parseCount(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const numeric = Number(value);

  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 5) {
    return numeric;
  }

  return NUMBER_WORDS[value] ?? null;
}

function paragraphSpans(contentMd: string): readonly TtsBlockSpan[] {
  const parsed = parseNoteMarkdown(contentMd);

  return collectTtsBlockSpans(parsed.ast).filter(
    (span) => span.node.type === "paragraph",
  );
}

function selectionRead(
  request: ReadSelectionRequest,
  scope: ReadSelectionScope,
  extra: {
    readonly start?: number;
    readonly end?: number;
    readonly paragraphIndex?: number;
    readonly count?: number;
  } = {},
): ReadSelectionResult {
  try {
    const selected = selectTtsText(request.note.contentMd, {
      scope,
      ...(extra.start === undefined ? {} : { start: extra.start }),
      ...(extra.end === undefined ? {} : { end: extra.end }),
      ...(extra.paragraphIndex === undefined
        ? {}
        : { paragraphIndex: extra.paragraphIndex }),
    });

    return {
      action: "read",
      selection: { scope, ...extra },
      text: selected.text,
      noteVersion: request.note.version,
    };
  } catch (error) {
    if (error instanceof TtsTextError) {
      return {
        action: "clarify",
        message: error.message,
      };
    }

    throw error;
  }
}

export function parseReadSelection(
  request: ReadSelectionRequest,
): ReadSelectionResult {
  const transcript = request.transcript.trim();

  if (countGraphemes(transcript) > READ_SELECTION_TRANSCRIPT_MAX_GRAPHEMES) {
    return {
      action: "clarify",
      message: "Hlasový příkaz je příliš dlouhý. Zkuste ho zopakovat krátce.",
    };
  }

  const folded = fold(transcript);

  if (
    folded === "precist shrnuti" ||
    folded === "precist souhrn" ||
    folded === "precist shrnuti poznamky"
  ) {
    if (!request.summary || request.summary.text.trim() === "") {
      return {
        action: "summary_missing",
        message:
          "Shrnutí ještě není vytvořené. Nejprve použijte tlačítko Vytvořit shrnutí v části Shrnutí poznámky; hlasový příkaz sám nic negeneruje.",
      };
    }

    if (
      request.summary.noteId !== request.note.id ||
      request.summary.noteVersion !== request.note.version
    ) {
      return {
        action: "summary_stale",
        message:
          request.summary.noteId !== request.note.id
            ? "Shrnutí patří k jiné poznámce. Vytvořte ho znovu pro tuto poznámku; cizí shrnutí se nepřečte."
            : "Shrnutí je ze starší verze poznámky. Vytvořte ho znovu; staré shrnutí se nepřečte.",
      };
    }

    return {
      action: "summary",
      noteVersion: request.note.version,
      text: request.summary.text,
    };
  }

  if (
    folded === "precist vse" ||
    folded === "precist celou poznamku" ||
    folded === "precist celou poznamku nahlas"
  ) {
    return selectionRead(request, "full");
  }

  if (
    folded === "precist ukoly" ||
    folded === "precist ukoly nahlas" ||
    folded === "jen ukoly"
  ) {
    return selectionRead(request, "tasks");
  }

  if (
    folded === "precist oznaceny text" ||
    folded === "precist oznaceny text nahlas" ||
    folded === "precist vybrany text"
  ) {
    if (!request.selection) {
      return {
        action: "clarify",
        message:
          "Nejprve označte text v náhledu nebo zadejte rozsah, potom příkaz zopakujte.",
      };
    }

    return selectionRead(request, "range", request.selection);
  }

  if (
    folded === "precist tento odstavec" ||
    folded === "precist tento odstavec nahlas"
  ) {
    if (request.paragraphIndex !== undefined) {
      return selectionRead(request, "paragraph", {
        paragraphIndex: request.paragraphIndex,
      });
    }

    if (!request.selection) {
      return {
        action: "clarify",
        message:
          "Označte text v požadovaném odstavci, nebo vyberte odstavec v přehrávači.",
      };
    }

    const spans = paragraphSpans(request.note.contentMd);
    const span = spans.find(
      (item) =>
        request.selection!.start >= item.start &&
        request.selection!.end <= item.end,
    );

    if (!span) {
      return {
        action: "clarify",
        message:
          "Označený text neleží v jednom podporovaném odstavci. Vyberte celý odstavec.",
      };
    }

    const index = spans.indexOf(span);

    return selectionRead(request, "paragraph", { paragraphIndex: index });
  }

  const lastParagraphs = /^precist posledni(?:ch)? (\S+) (?:odstavec|odstavce|odstavcu)$/u.exec(
    folded,
  );
  const count = parseCount(lastParagraphs?.[1]);

  if (count !== null) {
    try {
      const selected = selectTtsText(request.note.contentMd, {
        scope: "last_paragraphs",
        paragraphCount: count,
      });

      return {
        action: "read",
        selection: { scope: "last_paragraphs", count },
        text: selected.text,
        noteVersion: request.note.version,
      };
    } catch (error) {
      if (error instanceof TtsTextError) {
        return { action: "clarify", message: error.message };
      }

      throw error;
    }
  }

  if (folded.includes("posledni") && folded.includes("odstavec")) {
    return {
      action: "clarify",
      message:
        "Kolik posledních odstavců mám přečíst? Řekněte například „přečíst poslední dva odstavce“ (1–5).",
    };
  }

  if (folded.startsWith("precist") || folded.startsWith("precti")) {
    return {
      action: "clarify",
      message:
        "Nerozumím rozsahu čtení. Řekněte „přečíst vše“, „přečíst označený text“, „přečíst tento odstavec“, „přečíst úkoly“, „přečíst shrnutí“ nebo „přečíst poslední dva odstavce“.",
    };
  }

  return {
    action: "clarify",
    message:
      "Tento příkaz není příkazem pro čtení. Zkuste „přečíst vše“ nebo „přečíst úkoly“.",
  };
}

export function stableReadSelectionText(
  contentMd: string,
  selection: ReadSelectionResult,
): string | null {
  return selection.action === "read" ? selection.text : null;
}
