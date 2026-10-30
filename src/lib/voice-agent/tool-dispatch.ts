import { randomBytes } from "node:crypto";

import { z } from "zod";

import { NoteServiceError } from "../notes/service.ts";
import {
  ReadToolError,
  createReadServices,
  type GetNoteToolResult,
  type ReadServices,
  type SearchNotesToolResult,
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

interface ToolSession {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  selectedNoteId: string | null;
  selectedNoteVersion: number | null;
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
      createdAt: now,
      expiresAt,
      id: newSessionId(),
      lastSearchNoteIds: [],
      seenCallIds: new Set(),
      selectedNoteId: null,
      selectedNoteVersion: null,
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

    return {
      noteId: note.noteId,
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
        session.selectedNoteId = null;
        session.selectedNoteVersion = null;

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
          session.selectedNoteId = null;
          session.selectedNoteVersion = null;

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
          session.selectedNoteId = null;
          session.selectedNoteVersion = null;
        }

        return readError(input.name, input.callId, error);
      }
    }

    return toolError(
      input.name,
      input.callId,
      "unknown_tool",
      "Takový nástroj není dostupný.",
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
