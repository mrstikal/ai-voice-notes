import { randomBytes } from "node:crypto";

import { z } from "zod";

import { ConfigurationError } from "../config.ts";
import { NoteServiceError } from "../notes/service.ts";
import {
  READ_TOOL_SECTIONS,
  ReadToolError,
  createDefaultSummaryGenerator,
  createReadServices,
  describeNoteSummaryOffer,
  prepareNoteSummarySource,
  type GetNoteToolResult,
  type MarkedSelection,
  type ReadNoteSectionName,
  type ReadNoteSectionResult,
  type ReadServices,
  type SearchNotesToolResult,
  type SummaryGenerator,
} from "./read-services.ts";

export const TOOL_SESSION_TTL_MS = 9 * 60 * 1000;
export const MAX_TOOL_CALLS_PER_TURN = 4;
export const MAX_TOOL_CALLS_PER_SESSION = 20;
export const MAX_ACTIVE_TOOL_SESSIONS = 20;

export interface ToolSessionHandle {
  readonly sessionId: string;
  readonly expiresAt: string;
}

export interface ToolCallInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface ToolCallOutcome {
  readonly name: string;
  readonly callId: string;
  readonly ok: boolean;
  readonly response: unknown;
}

export interface SelectedNote {
  readonly noteId: string;
  readonly title: string;
  readonly version: number;
  readonly preview: string;
  readonly previewTruncated: boolean;
}

export interface MarkedSelectionResult extends SelectedNote {
  readonly selection: MarkedSelection | null;
}

export interface SummaryApprovalResult {
  readonly status: "generated" | "cached";
  readonly noteId: string;
  readonly noteTitle: string;
  readonly noteVersion: number;
  readonly summaryText: string;
  readonly sourceGraphemes: number;
  readonly model: string | null;
}

export class ToolSessionError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ToolSessionError";
    this.status = status;
    this.code = code;
  }
}

interface PendingSummary {
  readonly noteId: string;
  readonly noteVersion: number;
  readonly selection: MarkedSelection | null;
  readonly sourceGraphemes: number;
}

interface CachedSummary {
  readonly noteId: string;
  readonly noteTitle: string;
  readonly noteVersion: number;
  readonly summaryText: string;
  readonly sourceGraphemes: number;
}

interface ToolSession {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  selectedNoteId: string | null;
  selectedNoteVersion: number | null;
  selection: MarkedSelection | null;
  pendingSummary: PendingSummary | null;
  cachedSummary: CachedSummary | null;
  summaryInFlight: boolean;
  lastSearchNoteIds: readonly string[];
  totalCalls: number;
  readonly turnCalls: Map<string, number>;
  readonly seenCallIds: Set<string>;
}

const searchArgumentsSchema = z
  .object({
    maxResults: z.number().int().min(1).max(5).optional(),
    query: z.string().trim().min(1).max(200),
  })
  .strict();

const getNoteArgumentsSchema = z
  .object({
    noteId: z.string().min(1).max(64),
  })
  .strict();

const readNoteSectionArgumentsSchema = z
  .object({
    noteId: z.string().min(1).max(64),
    section: z.enum(READ_TOOL_SECTIONS),
  })
  .strict();

const summarizeNoteArgumentsSchema = getNoteArgumentsSchema;

function sameSelection(
  left: MarkedSelection | null,
  right: MarkedSelection | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return left.start === right.start && left.end === right.end;
}

function isStatusError(
  error: unknown,
): error is { status: number; code: string; message: string } {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as Record<string, unknown>;

  return (
    typeof candidate.status === "number" &&
    Number.isInteger(candidate.status) &&
    candidate.status >= 400 &&
    candidate.status <= 599 &&
    typeof candidate.code === "string" &&
    candidate.code.trim() !== "" &&
    typeof candidate.message === "string" &&
    candidate.message.trim() !== ""
  );
}

function nowMs(now: () => number): number {
  const value = now();

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Čas musí být nezáporné celé číslo.");
  }

  return value;
}

function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}

function toolError(
  name: string,
  callId: string,
  code: string,
  message: string,
): ToolCallOutcome {
  return {
    callId,
    name,
    ok: false,
    response: { error: { code, message } },
  };
}

function readError(
  name: string,
  callId: string,
  error: unknown,
): ToolCallOutcome {
  if (error instanceof ReadToolError) {
    return toolError(name, callId, error.code, error.message);
  }

  if (error instanceof NoteServiceError) {
    return toolError(
      name,
      callId,
      error.status === 404 ? "note_not_found" : "note_unavailable",
      error.status === 404
        ? "Vybraná poznámka neexistuje nebo byla smazána."
        : "Poznámku se nepodařilo načíst.",
    );
  }

  return toolError(
    name,
    callId,
    "tool_unavailable",
    "Čtecí nástroj se nepodařilo provést.",
  );
}

export class ToolSessionStore {
  private readonly sessions = new Map<string, ToolSession>();

  constructor(
    private readonly readServices: ReadServices,
    private readonly now: () => number = Date.now,
    private readonly summarize: SummaryGenerator =
      createDefaultSummaryGenerator(),
  ) {}

  createSession(options: { readonly expiresAt: Date }): ToolSessionHandle {
    const now = nowMs(this.now);
    const expiresAt = options.expiresAt.getTime();

    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
      throw new ToolSessionError(
        400,
        "invalid_expiry",
        "Relace nástrojů musí mít budoucí čas vypršení.",
      );
    }

    this.prune(now);

    if (this.sessions.size >= MAX_ACTIVE_TOOL_SESSIONS) {
      throw new ToolSessionError(
        503,
        "tool_session_limit",
        "Je otevřeno příliš mnoho hlasových relací. Zkuste to znovu později.",
      );
    }

    const session: ToolSession = {
      cachedSummary: null,
      createdAt: now,
      expiresAt,
      id: newSessionId(),
      lastSearchNoteIds: [],
      pendingSummary: null,
      seenCallIds: new Set(),
      selectedNoteId: null,
      selectedNoteVersion: null,
      selection: null,
      summaryInFlight: false,
      totalCalls: 0,
      turnCalls: new Map(),
    };
    this.sessions.set(session.id, session);

    return {
      expiresAt: new Date(expiresAt).toISOString(),
      sessionId: session.id,
    };
  }

  endSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  async selectNote(
    sessionId: string,
    noteId: string,
  ): Promise<SelectedNote> {
    const session = this.requireSession(sessionId);

    if (!session.lastSearchNoteIds.includes(noteId)) {
      throw new ToolSessionError(
        409,
        "note_not_selected",
        "Poznámku lze vybrat jen z posledních výsledků hledání.",
      );
    }

    let note: GetNoteToolResult;

    try {
      note = await this.readServices.getNote({ noteId });
    } catch (error) {
      throw this.toSelectionError(error);
    }

    session.selectedNoteId = note.noteId;
    session.selectedNoteVersion = note.version;
    session.selection = null;
    session.pendingSummary = null;
    session.cachedSummary = null;

    return {
      noteId: note.noteId,
      preview: note.content,
      previewTruncated: note.truncated,
      title: note.title,
      version: note.version,
    };
  }

  async markSelection(
    sessionId: string,
    noteId: string,
    selection: MarkedSelection | null,
  ): Promise<MarkedSelectionResult> {
    const session = this.requireSession(sessionId);

    if (session.selectedNoteId !== noteId) {
      throw new ToolSessionError(
        409,
        "note_not_selected",
        "Označit pasáž lze jen v poznámce, kterou uživatel výslovně vybral.",
      );
    }

    let note: GetNoteToolResult;

    try {
      note = await this.readServices.getNote({ noteId });
    } catch (error) {
      throw this.toSelectionError(error);
    }

    if (note.version !== session.selectedNoteVersion) {
      this.clearSelection(session);

      throw new ToolSessionError(
        409,
        "note_stale",
        "Vybraná poznámka se mezitím změnila. Nechte uživatele vybrat znovu.",
      );
    }

    if (selection !== null) {
      try {
        await this.readServices.validateSelection({ noteId, selection });
      } catch (error) {
        if (error instanceof ReadToolError) {
          throw new ToolSessionError(
            error.status,
            error.code,
            error.message,
          );
        }

        throw error;
      }
    }

    session.selection = selection;
    session.pendingSummary = null;
    session.cachedSummary = null;

    return {
      noteId: note.noteId,
      preview: note.content,
      previewTruncated: note.truncated,
      selection,
      title: note.title,
      version: note.version,
    };
  }

  async dispatch(input: ToolCallInput): Promise<ToolCallOutcome> {
    const session = this.requireSession(input.sessionId);

    if (
      input.turnId.trim() === "" ||
      input.turnId.length > 128 ||
      input.callId.trim() === "" ||
      input.callId.length > 128
    ) {
      return toolError(
        input.name,
        input.callId,
        "invalid_arguments",
        "Neplatné ID tahu nebo volání nástroje.",
      );
    }

    if (session.seenCallIds.has(input.callId)) {
      return toolError(
        input.name,
        input.callId,
        "duplicate_call_id",
        "Stejné volání nástroje už bylo zpracováno.",
      );
    }

    const turnCalls = session.turnCalls.get(input.turnId) ?? 0;

    if (
      session.totalCalls >= MAX_TOOL_CALLS_PER_SESSION ||
      turnCalls >= MAX_TOOL_CALLS_PER_TURN
    ) {
      return toolError(
        input.name,
        input.callId,
        "tool_call_limit",
        `V jednom tahu lze použít nejvýše ${MAX_TOOL_CALLS_PER_TURN} volání a v celé relaci nejvýše ${MAX_TOOL_CALLS_PER_SESSION}.`,
      );
    }

    session.seenCallIds.add(input.callId);
    session.totalCalls += 1;
    session.turnCalls.set(input.turnId, turnCalls + 1);

    if (input.name === "search_notes") {
      const parsed = searchArgumentsSchema.safeParse(input.arguments);

      if (!parsed.success) {
        return toolError(
          input.name,
          input.callId,
          "invalid_arguments",
          "Hledání potřebuje český výraz do 200 znaků a volitelně 1 až 5 výsledků.",
        );
      }

      try {
        const result = await this.readServices.searchNotes(parsed.data);
        session.lastSearchNoteIds = result.results.map(
          (item) => item.noteId,
        );
        this.clearSelection(session);

        return {
          callId: input.callId,
          name: input.name,
          ok: true,
          response: result satisfies SearchNotesToolResult,
        };
      } catch (error) {
        return readError(input.name, input.callId, error);
      }
    }

    if (input.name === "get_note") {
      const parsed = getNoteArgumentsSchema.safeParse(input.arguments);

      if (!parsed.success) {
        return toolError(
          input.name,
          input.callId,
          "invalid_arguments",
          "Čtení poznámky potřebuje její UUID.",
        );
      }

      if (session.selectedNoteId !== parsed.data.noteId) {
        return toolError(
          input.name,
          input.callId,
          "note_not_selected",
          "Nejprve nechte uživatele vybrat jednu poznámku z výsledků hledání.",
        );
      }

      try {
        const note = await this.readServices.getNote(parsed.data);

        if (note.version !== session.selectedNoteVersion) {
          this.clearSelection(session);

          return toolError(
            input.name,
            input.callId,
            "note_stale",
            "Vybraná poznámka se mezitím změnila. Nechte uživatele vybrat znovu.",
          );
        }

        return {
          callId: input.callId,
          name: input.name,
          ok: true,
          response: note,
        };
      } catch (error) {
        if (error instanceof NoteServiceError && error.status === 404) {
          this.clearSelection(session);
        }

        return readError(input.name, input.callId, error);
      }
    }

    if (input.name === "read_note_section") {
      const parsed = readNoteSectionArgumentsSchema.safeParse(input.arguments);

      if (!parsed.success) {
        return toolError(
          input.name,
          input.callId,
          "invalid_arguments",
          "Čtení části poznámky potřebuje její UUID a část last_paragraph, tasks nebo selection.",
        );
      }

      return this.readSelectedSection(
        input,
        session,
        parsed.data.noteId,
        parsed.data.section,
      );
    }

    if (input.name === "summarize_note") {
      const parsed = summarizeNoteArgumentsSchema.safeParse(input.arguments);

      if (!parsed.success) {
        return toolError(
          input.name,
          input.callId,
          "invalid_arguments",
          "Shrnutí potřebuje UUID vybrané poznámky.",
        );
      }

      return this.summarizeSelectedNote(
        input,
        session,
        parsed.data.noteId,
      );
    }

    return toolError(
      input.name,
      input.callId,
      "unknown_tool",
      "Takový nástroj není dostupný.",
    );
  }

  async approveSummary(sessionId: string): Promise<SummaryApprovalResult> {
    const session = this.requireSession(sessionId);
    const pending = session.pendingSummary;

    if (pending === null) {
      throw new ToolSessionError(
        409,
        "summary_not_requested",
        "Shrnutí nejdřív musí vyžádat asistent; potvrzení bez požadavku se neprovede.",
      );
    }

    if (session.summaryInFlight) {
      throw new ToolSessionError(
        409,
        "summary_in_progress",
        "Shrnutí už se připravuje. Počkejte na jeho dokončení.",
      );
    }

    const cached = session.cachedSummary;

    if (
      cached !== null &&
      cached.noteId === pending.noteId &&
      cached.noteVersion === pending.noteVersion
    ) {
      session.pendingSummary = null;

      return {
        model: null,
        noteId: cached.noteId,
        noteTitle: cached.noteTitle,
        noteVersion: cached.noteVersion,
        sourceGraphemes: cached.sourceGraphemes,
        status: "cached",
        summaryText: cached.summaryText,
      };
    }

    session.summaryInFlight = true;
    session.pendingSummary = null;

    try {
      const note = await this.readServices.getNoteDetail({
        noteId: pending.noteId,
      });

      if (note.version !== pending.noteVersion) {
        this.clearSelection(session);

        throw new ToolSessionError(
          409,
          "note_stale",
          "Vybraná poznámka se mezitím změnila. Shrnutí nebylo vytvořeno; vyberte poznámku znovu.",
        );
      }

      const generated = await this.summarize({
        note,
        selection: pending.selection,
      });

      session.cachedSummary = {
        noteId: note.id,
        noteTitle: note.title,
        noteVersion: note.version,
        sourceGraphemes: generated.sourceGraphemes,
        summaryText: generated.summaryText,
      };

      return {
        model: null,
        noteId: note.id,
        noteTitle: note.title,
        noteVersion: note.version,
        sourceGraphemes: generated.sourceGraphemes,
        status: "generated",
        summaryText: generated.summaryText,
      };
    } catch (error) {
      if (error instanceof ToolSessionError) {
        throw error;
      }

      throw this.toApprovalError(error);
    } finally {
      session.summaryInFlight = false;
    }
  }

  private async readSelectedSection(
    input: ToolCallInput,
    session: ToolSession,
    noteId: string,
    section: ReadNoteSectionName,
  ): Promise<ToolCallOutcome> {
    if (session.selectedNoteId !== noteId) {
      return toolError(
        input.name,
        input.callId,
        "note_not_selected",
        "Nejprve nechte uživatele vybrat jednu poznámku z výsledků hledání.",
      );
    }

    try {
      const result = await this.readServices.readNoteSection({
        noteId,
        section,
        selection: session.selection,
      });

      if (result.version !== session.selectedNoteVersion) {
        this.clearSelection(session);

        return toolError(
          input.name,
          input.callId,
          "note_stale",
          "Vybraná poznámka se mezitím změnila. Nechte uživatele vybrat znovu.",
        );
      }

      return {
        callId: input.callId,
        name: input.name,
        ok: true,
        response: result satisfies ReadNoteSectionResult,
      };
    } catch (error) {
      if (error instanceof NoteServiceError && error.status === 404) {
        this.clearSelection(session);
      }

      return readError(input.name, input.callId, error);
    }
  }

  private async summarizeSelectedNote(
    input: ToolCallInput,
    session: ToolSession,
    noteId: string,
  ): Promise<ToolCallOutcome> {
    if (session.selectedNoteId !== noteId) {
      return toolError(
        input.name,
        input.callId,
        "note_not_selected",
        "Nejprve nechte uživatele vybrat jednu poznámku z výsledků hledání.",
      );
    }

    try {
      const note = await this.readServices.getNoteDetail({ noteId });

      if (note.version !== session.selectedNoteVersion) {
        this.clearSelection(session);

        return toolError(
          input.name,
          input.callId,
          "note_stale",
          "Vybraná poznámka se mezitím změnila. Nechte uživatele vybrat znovu.",
        );
      }

      const cached = session.cachedSummary;

      if (
        cached !== null &&
        cached.noteId === note.id &&
        cached.noteVersion === note.version
      ) {
        return {
          callId: input.callId,
          name: input.name,
          ok: true,
          response: {
            noteId: note.id,
            noteTitle: note.title,
            noteVersion: note.version,
            sourceGraphemes: cached.sourceGraphemes,
            status: "cached",
            summaryText: cached.summaryText,
          },
        };
      }

      const source = prepareNoteSummarySource(note, session.selection);

      if (
        session.pendingSummary === null ||
        session.pendingSummary.noteId !== note.id ||
        session.pendingSummary.noteVersion !== note.version ||
        !sameSelection(session.pendingSummary.selection, session.selection)
      ) {
        session.pendingSummary = {
          noteId: note.id,
          noteVersion: note.version,
          selection: session.selection,
          sourceGraphemes: source.sourceGraphemes,
        };
      }

      const offer = describeNoteSummaryOffer(source.sourceText);

      return {
        callId: input.callId,
        name: input.name,
        ok: true,
        response: {
          blockedReason: offer.blockedReason,
          configured: offer.configured,
          estimatedMaxCostUsd: offer.estimatedMaxCostUsd,
          message:
            "Shrnutí je samostatný placený požadavek na OpenRouter. Dokud ho uživatel nepovolí tlačítkem v panelu, žádné shrnutí neexistuje a nic se neodesílá.",
          model: offer.model,
          noteId: note.id,
          noteTitle: note.title,
          noteVersion: note.version,
          selection: session.selection,
          sourceGraphemes: source.sourceGraphemes,
          status: "needs_user_cost_confirmation",
        },
      };
    } catch (error) {
      if (error instanceof NoteServiceError && error.status === 404) {
        this.clearSelection(session);
      }

      return readError(input.name, input.callId, error);
    }
  }

  private clearSelection(session: ToolSession): void {
    session.selectedNoteId = null;
    session.selectedNoteVersion = null;
    session.selection = null;
    session.pendingSummary = null;
    session.cachedSummary = null;
  }

  private toApprovalError(error: unknown): ToolSessionError {
    if (error instanceof ReadToolError) {
      return new ToolSessionError(error.status, error.code, error.message);
    }

    if (error instanceof NoteServiceError) {
      return new ToolSessionError(
        error.status === 404 ? 404 : 409,
        error.status === 404 ? "note_not_found" : "note_unavailable",
        error.status === 404
          ? "Vybraná poznámka neexistuje nebo byla smazána."
          : "Poznámku se nepodařilo načíst.",
      );
    }

    if (error instanceof ConfigurationError) {
      return new ToolSessionError(
        503,
        "summary_unavailable",
        "Shrnutí není dostupné. OpenRouter není nakonfigurovaný.",
      );
    }

    if (isStatusError(error)) {
      return new ToolSessionError(
        error.status,
        error.code,
        error.message,
      );
    }

    return new ToolSessionError(
      503,
      "summary_failed",
      "Shrnutí se nepodařilo vytvořit. Zkuste to znovu.",
    );
  }

  prune(now?: number): void {
    const at = now ?? nowMs(this.now);

    for (const [sessionId, session] of this.sessions) {
      if (at >= session.expiresAt) {
        this.sessions.delete(sessionId);
      }
    }
  }

  size(): number {
    return this.sessions.size;
  }

  private requireSession(sessionId: string): ToolSession {
    const now = nowMs(this.now);
    this.prune(now);
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new ToolSessionError(
        404,
        "tool_session_not_found",
        "Hlasová relace nástrojů neexistuje nebo už vypršela.",
      );
    }

    return session;
  }

  private toSelectionError(error: unknown): ToolSessionError {
    if (error instanceof ReadToolError) {
      return new ToolSessionError(
        error.status,
        error.code,
        error.message,
      );
    }

    if (error instanceof NoteServiceError) {
      return new ToolSessionError(
        error.status === 404 ? 404 : 409,
        error.status === 404 ? "note_not_found" : "note_unavailable",
        error.status === 404
          ? "Vybraná poznámka neexistuje nebo byla smazána."
          : "Poznámku se nepodařilo načíst.",
      );
    }

    return new ToolSessionError(
      503,
      "tool_unavailable",
      "Poznámku se nepodařilo načíst.",
    );
  }
}

let sharedStore: ToolSessionStore | null = null;

export function getToolSessionStore(): ToolSessionStore {
  sharedStore ??= new ToolSessionStore(createReadServices());
  return sharedStore;
}

export function setToolSessionStoreForTests(
  store: ToolSessionStore | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Testovací úložiště lze nastavit pouze v NODE_ENV=test.");
  }

  sharedStore = store;
}

export function resetToolSessionStoreForTests(): void {
  setToolSessionStoreForTests(null);
}
