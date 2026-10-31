import { ConfigurationError } from "../config.ts";
import { SummaryError } from "../ai/summary.ts";
import {
  StructuredLlmError,
  type StructuredLlmService,
} from "../ai/structured.ts";
import { countGraphemes } from "../notes/limits.ts";
import { hashNoteSource } from "../notes/operations.ts";
import {
  EditProposalError,
  type CreateEditProposalInput,
  type CreatedEditProposalDto,
  type EditProposalService,
} from "../notes/proposals.ts";
import { NoteServiceError } from "../notes/service.ts";
import {
  ReadToolError,
  describeNoteSummaryOffer,
  generateNoteSummary,
  prepareNoteSummarySource,
  type MarkedSelection,
  type ReadNoteSectionResult,
  type ReadServices,
} from "../voice-agent/read-services.ts";
import {
  CHAINED_NOTE_PREVIEW_MAX_GRAPHEMES,
  CHAINED_TRANSCRIPT_MAX_GRAPHEMES,
  ChainedIntentError,
  interpretChainedIntent,
  isTodoCommand,
  normalizeTodoText,
  type ChainedIntent,
} from "./chained-intent.ts";
import type { LlmOperation } from "../ai/schemas.ts";

export const CHAINED_SEARCH_MAX_RESULTS = 3;
export const CHAINED_MAX_NOTES_PER_TURN = 1;
export const CHAINED_SUMMARY_TEXT_MAX_GRAPHEMES = 2_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ChainedOutcome =
  | {
      readonly kind: "search";
      readonly intent: ChainedIntent;
      readonly empty: boolean;
      readonly query: string;
      readonly results: readonly {
        readonly noteId: string;
        readonly title: string;
        readonly preview: string;
      }[];
      readonly speechText: null;
    }
  | {
      readonly kind: "note";
      readonly intent: ChainedIntent;
      readonly note: {
        readonly noteId: string;
        readonly title: string;
        readonly version: number;
        readonly text: string;
        readonly truncated: boolean;
        readonly empty: boolean;
      };
      readonly speechText: string;
    }
  | {
      readonly kind: "section";
      readonly intent: ChainedIntent;
      readonly section: ReadNoteSectionResult;
      readonly speechText: string;
    }
  | {
      readonly kind: "summary_offer";
      readonly intent: ChainedIntent;
      readonly noteId: string;
      readonly noteTitle: string;
      readonly noteVersion: number;
      readonly sourceGraphemes: number;
      readonly estimatedMaxCostUsd: number;
      readonly model: string;
      readonly configured: boolean;
      readonly blockedReason: string | null;
      readonly message: string;
      readonly speechText: null;
    }
  | {
      readonly kind: "proposal";
      readonly intent: ChainedIntent;
      readonly proposal: CreatedEditProposalDto;
      readonly speechText: string;
    }
  | {
      readonly kind: "unclear";
      readonly intent: ChainedIntent;
      readonly clarification: string;
      readonly speechText: string;
    }
  | {
      readonly kind: "needs_selection";
      readonly intent: ChainedIntent;
      readonly message: string;
      readonly speechText: string;
    };

export interface ChainedSummaryResult {
  readonly noteId: string;
  readonly noteTitle: string;
  readonly noteVersion: number;
  readonly sourceGraphemes: number;
  readonly summaryText: string;
  readonly speechText: string;
}

export interface ChainedTurnInput {
  readonly transcript: string;
  readonly selectedNoteId?: string;
  readonly selection?: MarkedSelection | null;
}

export interface ChainedSummaryInput {
  readonly noteId: string;
  readonly selection?: MarkedSelection | null;
}

export interface ChainedDependencies {
  readonly llm: Pick<
    StructuredLlmService,
    "requestChainedIntent" | "requestSummary"
  >;
  readonly readServices: ReadServices;
  readonly proposals: Pick<EditProposalService, "create">;
}

export class ChainedControllerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly provider: "openrouter" | "elevenlabs" | "notes" | "proposal";
  readonly details: Record<string, unknown> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    provider: ChainedControllerError["provider"],
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ChainedControllerError";
    this.status = status;
    this.code = code;
    this.provider = provider;
    this.details = details;
  }
}

function assertTranscript(transcript: string): string {
  const trimmed = transcript.trim();
  const graphemes = countGraphemes(trimmed);

  if (graphemes === 0) {
    throw new ChainedControllerError(
      400,
      "chained_empty_transcript",
      "Přepis je prázdný. Zkuste to znovu.",
      "elevenlabs",
    );
  }

  if (graphemes > CHAINED_TRANSCRIPT_MAX_GRAPHEMES) {
    throw new ChainedControllerError(
      422,
      "chained_transcript_too_large",
      `Příkaz může mít nejvýše ${CHAINED_TRANSCRIPT_MAX_GRAPHEMES} znaků.`,
      "elevenlabs",
    );
  }

  return trimmed;
}

function assertNoteId(noteId: string): string {
  if (!UUID_PATTERN.test(noteId)) {
    throw new ChainedControllerError(
      400,
      "chained_invalid_note",
      "Vybraná poznámka nemá platné ID.",
      "notes",
    );
  }

  return noteId;
}

function needsSelection(intent: ChainedIntent): ChainedOutcome {
  return {
    intent,
    kind: "needs_selection",
    message:
      "Nejdřív vyberte jednu poznámku z výsledků hledání. Příkaz se pak provede jen nad ní.",
    speechText:
      "Nejdřív vyberte jednu poznámku z výsledků hledání. Příkaz se pak provede jen nad ní.",
  };
}

function toControllerError(error: unknown): ChainedControllerError {
  if (error instanceof ChainedControllerError) {
    return error;
  }

  if (error instanceof ChainedIntentError) {
    return new ChainedControllerError(
      502,
      error.code,
      error.message,
      "openrouter",
    );
  }

  if (error instanceof StructuredLlmError) {
    return new ChainedControllerError(
      error.status,
      error.code,
      error.message,
      "openrouter",
      error.details,
    );
  }

  if (error instanceof ConfigurationError) {
    return new ChainedControllerError(
      503,
      "openrouter_not_configured",
      "OpenRouter není nakonfigurovaný. Řetězený režim nelze spustit.",
      "openrouter",
    );
  }

  if (error instanceof ReadToolError) {
    return new ChainedControllerError(
      error.status,
      error.code,
      error.message,
      "notes",
    );
  }

  if (error instanceof SummaryError) {
    return new ChainedControllerError(
      error.status,
      error.code,
      error.message,
      "openrouter",
    );
  }

  if (error instanceof NoteServiceError) {
    return new ChainedControllerError(
      error.status,
      error.code,
      error.message,
      "notes",
    );
  }

  if (error instanceof EditProposalError) {
    return new ChainedControllerError(
      error.status,
      error.code,
      error.message,
      "proposal",
      error.code === "proposal_ambiguous"
        ? {
            candidates: (
              error as EditProposalError & {
                candidates?: readonly unknown[];
              }
            ).candidates,
          }
        : undefined,
    );
  }

  return new ChainedControllerError(
    503,
    "chained_failed",
    "Řetězený příkaz se nepodařilo provést. Zkuste to znovu.",
    "openrouter",
  );
}

function normalizeTodoOperation(operation: LlmOperation): LlmOperation {
  if (operation.type === "append_bounded_section") {
    return {
      ...operation,
      text: normalizeTodoText(operation.text),
    };
  }

  return operation;
}

export async function runChainedTurn(
  input: ChainedTurnInput,
  deps: ChainedDependencies,
): Promise<ChainedOutcome> {
  try {
    const transcript = assertTranscript(input.transcript);
    const selectedNoteId =
      input.selectedNoteId === undefined
        ? null
        : assertNoteId(input.selectedNoteId);
    const selection = input.selection ?? null;
    const intent = await interpretChainedIntent(
      {
        hasSelectedNote: selectedNoteId !== null,
        hasSelection: selection !== null,
        transcript,
      },
      deps.llm,
    );

    if (intent.action === "unclear") {
      return {
        clarification: intent.clarification,
        intent,
        kind: "unclear",
        speechText: intent.clarification,
      };
    }

    if (intent.action === "search_notes") {
      const result = await deps.readServices.searchNotes({
        maxResults: CHAINED_SEARCH_MAX_RESULTS,
        query: intent.query,
      });

      return {
        empty: result.empty,
        intent,
        kind: "search",
        query: result.query,
        results: result.results.map((item) => ({
          noteId: item.noteId,
          preview: item.preview,
          title: item.title,
        })),
        speechText: null,
      };
    }

    if (selectedNoteId === null) {
      return needsSelection(intent);
    }

    if (intent.action === "get_note") {
      const note = await deps.readServices.getNote({
        noteId: selectedNoteId,
      });

      return {
        intent,
        kind: "note",
        note: {
          empty: note.empty,
          noteId: note.noteId,
          text: note.content,
          title: note.title,
          truncated: note.truncated,
          version: note.version,
        },
        speechText: note.empty
          ? "Vybraná poznámka je prázdná."
          : note.truncated
            ? `${note.content} Poznámka je delší; přečetl jsem jen prvních ${CHAINED_NOTE_PREVIEW_MAX_GRAPHEMES.toLocaleString("cs-CZ")} znaků.`
            : note.content,
      };
    }

    if (intent.action === "read_note_section") {
      const section = await deps.readServices.readNoteSection({
        noteId: selectedNoteId,
        section: intent.section,
        selection,
      });

      return {
        intent,
        kind: "section",
        section,
        speechText:
          section.status === "ok"
            ? section.text
            : (section.message ??
              "Vybraná část poznámky je prázdná nebo nejednoznačná."),
      };
    }

    if (intent.action === "summarize_note") {
      const note = await deps.readServices.getNoteDetail({
        noteId: selectedNoteId,
      });
      const source = prepareNoteSummarySource(note, selection);
      const offer = describeNoteSummaryOffer(source.sourceText);

      return {
        blockedReason: offer.blockedReason,
        configured: offer.configured,
        estimatedMaxCostUsd: offer.estimatedMaxCostUsd,
        intent,
        kind: "summary_offer",
        message:
          "Shrnutí je samostatný placený požadavek na OpenRouter. Odesílá se až po vašem potvrzení.",
        model: offer.model,
        noteId: note.id,
        noteTitle: note.title,
        noteVersion: note.version,
        sourceGraphemes: source.sourceGraphemes,
        speechText: null,
      };
    }

    if (intent.action === "propose_edit") {
      const note = await deps.readServices.getNoteDetail({
        noteId: selectedNoteId,
      });
      const operation = isTodoCommand(transcript)
        ? normalizeTodoOperation(intent.operation)
        : intent.operation;
      const proposalInput: CreateEditProposalInput = {
        expectedSourceHash: hashNoteSource(note.contentMd),
        expectedVersion: note.version,
        operation,
      };
      const proposal = await deps.proposals.create(note.id, proposalInput);

      return {
        intent,
        kind: "proposal",
        proposal,
        speechText:
          "Návrh úpravy je připravený v panelu. Poznámka se zatím nezměnila; potvrďte nebo zamítněte návrh.",
      };
    }

    return needsSelection(intent);
  } catch (error) {
    throw toControllerError(error);
  }
}

export async function generateChainedSummary(
  input: ChainedSummaryInput,
  deps: Pick<ChainedDependencies, "llm" | "readServices">,
): Promise<ChainedSummaryResult> {
  try {
    const noteId = assertNoteId(input.noteId);
    const note = await deps.readServices.getNoteDetail({ noteId });
    const selection = input.selection ?? null;
    const source = prepareNoteSummarySource(note, selection);
    const generated = await generateNoteSummary(
      { note, selection },
      deps.llm,
    );
    const text = Array.from(generated.summaryText.trim())
      .slice(0, CHAINED_SUMMARY_TEXT_MAX_GRAPHEMES)
      .join("")
      .trim();

    return {
      noteId: note.id,
      noteTitle: note.title,
      noteVersion: note.version,
      sourceGraphemes: source.sourceGraphemes,
      speechText: text,
      summaryText: text,
    };
  } catch (error) {
    throw toControllerError(error);
  }
}
