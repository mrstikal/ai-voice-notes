import { z } from "zod";

import { loadConfig } from "../config.ts";
import { getDb, type AppDatabase } from "../db/client.ts";
import type { NoteSnapshot } from "../db/schema.ts";
import {
  NOTE_EDIT_MAX_BYTES,
  jsonError,
} from "../security/http.ts";
import { noteMutationPayloadSchema } from "../security/schemas.ts";
import {
  DEFAULT_NOTE_GRAPHEME_LIMITS,
  NoteLimitError,
  TITLE_MAX_GRAPHEMES,
  validateNoteGraphemeLimits,
  type NoteGraphemeLimits,
} from "./limits.ts";
import {
  getTtsCache,
  purgeNoteTtsCacheBestEffort,
  type TtsCache,
} from "../tts/cache.ts";
import { parseNoteMarkdown } from "./markdown.ts";
import { refreshNoteSearch } from "../search/fts.ts";
import {
  NoteMetadataError,
  normalizeNoteMetadata,
  sortTags,
  tagsEqual,
} from "./tags.ts";
import * as repository from "./repository.ts";

const expectedVersionSchema = z
  .number()
  .int()
  .positive()
  .max(2_147_483_647);

export const createNoteInputSchema = noteMutationPayloadSchema;

export const updateNoteInputSchema = z
  .object({
    title: z.string(),
    contentMd: z.string(),
    expectedVersion: expectedVersionSchema,
    draft: z.boolean().optional(),
  })
  .strict();

export const updateNoteMetadataInputSchema = z
  .object({
    category: z.string().max(50).nullable(),
    tags: z.array(z.string()).max(100),
    expectedVersion: expectedVersionSchema,
  })
  .strict();

export const updateNoteTitleInputSchema = z
  .object({
    title: z.string(),
    expectedVersion: expectedVersionSchema,
  })
  .strict();

export const deleteNoteInputSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
  })
  .strict();

export const restoreNoteInputSchema = deleteNoteInputSchema;

export type CreateNoteInput = z.infer<typeof createNoteInputSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteInputSchema>;
export type UpdateNoteMetadataInput = z.infer<typeof updateNoteMetadataInputSchema>;
export type UpdateNoteTitleInput = z.infer<typeof updateNoteTitleInputSchema>;
export type DeleteNoteInput = z.infer<typeof deleteNoteInputSchema>;
export type RestoreNoteInput = z.infer<typeof restoreNoteInputSchema>;

export interface NoteSummaryDto {
  readonly id: string;
  readonly title: string;
  readonly category: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export interface NoteDetailDto extends NoteSummaryDto {
  readonly contentMd: string;
  readonly contentPlain: string;
  readonly tags: string[];
}

export interface NotePageDto {
  readonly items: NoteSummaryDto[];
  readonly page: number;
  readonly pageSize: number;
  readonly hasNext: boolean;
}

export interface NoteServiceOptions {
  readonly db: AppDatabase;
  readonly limits?: NoteGraphemeLimits;
  readonly ttsCache?: Pick<TtsCache, "purgeNote">;
}

export interface NoteService {
  listActiveNotes(page: number): Promise<NotePageDto>;
  listDeletedNotes(page: number): Promise<NotePageDto>;
  getNote(id: string): Promise<NoteDetailDto>;
  createNote(input: CreateNoteInput): Promise<NoteDetailDto>;
  updateNote(id: string, input: UpdateNoteInput): Promise<NoteDetailDto>;
  updateNoteMetadata(
    id: string,
    input: UpdateNoteMetadataInput,
  ): Promise<NoteDetailDto>;
  updateNoteTitle(
    id: string,
    input: UpdateNoteTitleInput,
  ): Promise<NoteDetailDto>;
  deleteNote(id: string, expectedVersion: number): Promise<NoteDetailDto>;
  restoreNote(id: string, expectedVersion: number): Promise<NoteDetailDto>;
}

export const EMPTY_NOTE_SNAPSHOT: NoteSnapshot = {
  title: "",
  contentMd: "",
  category: null,
  tags: [],
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class NoteServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "NoteServiceError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class NoteNotFoundError extends NoteServiceError {
  constructor() {
    super(404, "note_not_found", "Poznámka nebyla nalezena.");
    this.name = "NoteNotFoundError";
  }
}

export class NoteConflictError extends NoteServiceError {
  readonly latestVersion: number;

  constructor(latestVersion: number) {
    super(
      409,
      "version_conflict",
      "Poznámka byla mezitím změněna. Načtěte ji znovu.",
      { latestVersion },
    );
    this.name = "NoteConflictError";
    this.latestVersion = latestVersion;
  }
}

export class InvalidNoteIdError extends NoteServiceError {
  constructor() {
    super(400, "invalid_id", "Neplatné ID poznámky.");
    this.name = "InvalidNoteIdError";
  }
}

export class InvalidPageError extends NoteServiceError {
  constructor(message = "Číslo stránky musí být kladné celé číslo.") {
    super(400, "invalid_page", message);
    this.name = "InvalidPageError";
  }
}

export class NoteValidationError extends NoteServiceError {
  constructor(message: string) {
    super(400, "invalid_note", message);
    this.name = "NoteValidationError";
  }
}

export class NoteTooLargeError extends NoteServiceError {
  constructor() {
    super(
      413,
      "payload_too_large",
      `Poznámka překračuje limit ${NOTE_EDIT_MAX_BYTES} bajtů.`,
    );
    this.name = "NoteTooLargeError";
  }
}

export function toNoteErrorResponse(error: unknown): Response {
  if (error instanceof NoteServiceError) {
    return jsonError(
      error.status,
      error.code,
      error.message,
      undefined,
      error.details,
    );
  }

  return jsonError(
    500,
    "internal_error",
    "Požadavek se nepodařilo zpracovat.",
  );
}

export function assertNoteId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new InvalidNoteIdError();
  }
}

export function prepareNoteContent(
  title: string,
  contentMd: string,
  limits: NoteGraphemeLimits,
): { contentPlain: string } {
  if (Buffer.byteLength(contentMd, "utf8") > NOTE_EDIT_MAX_BYTES) {
    throw new NoteTooLargeError();
  }

  const parsed = parseNoteMarkdown(contentMd);

  try {
    validateNoteGraphemeLimits(title, parsed.graphemeCount, limits);
  } catch (error) {
    if (error instanceof NoteLimitError) {
      throw new NoteValidationError(error.message);
    }

    throw error;
  }

  return { contentPlain: parsed.plainText };
}

function toSummary(note: repository.NoteRow): NoteSummaryDto {
  return {
    id: note.id,
    title: note.title,
    category: note.category,
    version: note.version,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    deletedAt: note.deletedAt,
  };
}

function toDetail(
  note: repository.NoteRow,
  tags: string[],
): NoteDetailDto {
  return {
    ...toSummary(note),
    contentMd: note.contentMd,
    contentPlain: note.contentPlain,
    tags: sortTags(tags),
  };
}

function toSnapshot(
  note: repository.NoteRow,
  tags: string[],
): NoteSnapshot {
  return {
    title: note.title,
    contentMd: note.contentMd,
    category: note.category,
    tags,
  };
}

export function parsePageParam(
  value: string | string[] | null | undefined,
): number {
  const raw = Array.isArray(value) ? value[0] : value;

  if (raw === undefined || raw === null) {
    return 1;
  }

  if (!/^\d+$/.test(raw)) {
    throw new InvalidPageError();
  }

  const page = Number(raw);

  if (!Number.isSafeInteger(page) || page < 1) {
    throw new InvalidPageError();
  }

  return page;
}

function pageWindow(page: number): { pageSize: number; offset: number } {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new InvalidPageError();
  }

  const pageSize = 10;
  const offset = (page - 1) * pageSize;

  if (!Number.isSafeInteger(offset)) {
    throw new InvalidPageError("Číslo stránky je příliš velké.");
  }

  return { pageSize, offset };
}

async function throwCasFailure(
  db: repository.NotesExecutor,
  id: string,
  expectDeleted: boolean,
): Promise<never> {
  const latest = await repository.findNoteById(db, id);

  if (!latest) {
    throw new NoteNotFoundError();
  }

  if (expectDeleted ? latest.deletedAt === null : latest.deletedAt !== null) {
    throw new NoteNotFoundError();
  }

  throw new NoteConflictError(latest.version);
}

export interface SeedNoteCreateInput {
  readonly seedKey: string;
  readonly title: string;
  readonly contentMd: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export async function createSeededNoteInTransaction(
  db: repository.NotesExecutor,
  input: SeedNoteCreateInput,
  limits: NoteGraphemeLimits = DEFAULT_NOTE_GRAPHEME_LIMITS,
): Promise<NoteDetailDto> {
  const prepared = prepareNoteContent(input.title, input.contentMd, limits);
  const note = await repository.insertNote(db, {
    seedKey: input.seedKey,
    title: input.title,
    contentMd: input.contentMd,
    contentPlain: prepared.contentPlain,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
  const tags: string[] = [];

  await repository.insertRevision(db, {
    noteId: note.id,
    noteVersion: 1,
    reason: "initial",
    beforeSnapshot: EMPTY_NOTE_SNAPSHOT,
    afterSnapshot: toSnapshot(note, tags),
    createdAt: input.createdAt,
  });
  await refreshNoteSearch(db, note.id);

  return toDetail(note, tags);
}

export function createNoteService(options: NoteServiceOptions): NoteService {
  const db = options.db;
  const limits = options.limits ?? DEFAULT_NOTE_GRAPHEME_LIMITS;

  return {
    async listActiveNotes(page) {
      const { pageSize, offset } = pageWindow(page);
      const rows = await repository.listActiveNotesPage(db, {
        limit: pageSize + 1,
        offset,
      });

      return {
        items: rows.slice(0, pageSize).map(toSummary),
        page,
        pageSize,
        hasNext: rows.length > pageSize,
      };
    },

    async listDeletedNotes(page) {
      const { pageSize, offset } = pageWindow(page);
      const rows = await repository.listDeletedNotesPage(db, {
        limit: pageSize + 1,
        offset,
      });

      return {
        items: rows.slice(0, pageSize).map(toSummary),
        page,
        pageSize,
        hasNext: rows.length > pageSize,
      };
    },

    async getNote(id) {
      assertNoteId(id);

      const note = await repository.findNoteById(db, id);
      if (!note || note.deletedAt) {
        throw new NoteNotFoundError();
      }

      const tags = await repository.getNoteTags(db, id);
      return toDetail(note, tags);
    },

    async createNote(input) {
      const prepared = prepareNoteContent(input.title, input.contentMd, limits);

      return db.transaction(async (tx) => {
        const note = await repository.insertNote(tx, {
          title: input.title,
          contentMd: input.contentMd,
          contentPlain: prepared.contentPlain,
        });
        const tags: string[] = [];

        await repository.insertRevision(tx, {
          noteId: note.id,
          noteVersion: 1,
          reason: "initial",
          beforeSnapshot: EMPTY_NOTE_SNAPSHOT,
          afterSnapshot: toSnapshot(note, tags),
        });
        await refreshNoteSearch(tx, note.id);

        return toDetail(note, tags);
      });
    },

    async updateNote(id, input) {
      assertNoteId(id);
      const prepared = prepareNoteContent(input.title, input.contentMd, limits);
      let contentChanged = false;

      const result = await db.transaction(async (tx) => {
        const current = await repository.findNoteByIdForUpdate(tx, id);
        if (!current || current.deletedAt) {
          throw new NoteNotFoundError();
        }

        if (current.version !== input.expectedVersion) {
          throw new NoteConflictError(current.version);
        }

        const tags = await repository.getNoteTags(tx, id);
        const draft = input.draft === true;
        const unchanged =
          current.title === input.title &&
          current.contentMd === input.contentMd;
        contentChanged = current.contentMd !== input.contentMd;

        if (unchanged && draft) {
          return toDetail(current, tags);
        }

        const updated = await repository.updateNoteCas(tx, {
          id,
          expectedVersion: input.expectedVersion,
          title: input.title,
          contentMd: input.contentMd,
          contentPlain: prepared.contentPlain,
        });

        if (!updated) {
          await throwCasFailure(tx, id, false);
          throw new NoteConflictError(current.version);
        }

        if (!draft) {
          await repository.insertRevision(tx, {
            noteId: id,
            noteVersion: updated.version,
            reason: "manual",
            beforeSnapshot: toSnapshot(current, tags),
            afterSnapshot: toSnapshot(updated, tags),
          });
        }

        await refreshNoteSearch(tx, id);

        return toDetail(updated, tags);
      });

      if (contentChanged) {
        await purgeNoteTtsCacheBestEffort(options.ttsCache, id);
      }

      return result;
    },

    async updateNoteMetadata(id, input) {
      assertNoteId(id);
      let normalized: ReturnType<typeof normalizeNoteMetadata>;

      try {
        normalized = normalizeNoteMetadata(input.category, input.tags);
      } catch (error) {
        if (error instanceof NoteMetadataError) {
          throw new NoteValidationError(error.message);
        }

        throw error;
      }

      return db.transaction(async (tx) => {
        const current = await repository.findNoteByIdForUpdate(tx, id);
        if (!current || current.deletedAt) {
          throw new NoteNotFoundError();
        }

        if (current.version !== input.expectedVersion) {
          throw new NoteConflictError(current.version);
        }

        const currentTags = sortTags(await repository.getNoteTags(tx, id));

        if (
          current.category === normalized.category &&
          tagsEqual(currentTags, normalized.tags)
        ) {
          return toDetail(current, currentTags);
        }

        const updated = await repository.updateNoteMetadataCas(tx, {
          id,
          expectedVersion: input.expectedVersion,
          category: normalized.category,
        });

        if (!updated) {
          await throwCasFailure(tx, id, false);
          throw new NoteConflictError(current.version);
        }

        await repository.replaceNoteTags(tx, id, normalized.tags);

        await repository.insertRevision(tx, {
          noteId: id,
          noteVersion: updated.version,
          reason: "metadata",
          beforeSnapshot: toSnapshot(current, currentTags),
          afterSnapshot: toSnapshot(updated, normalized.tags),
        });
        await refreshNoteSearch(tx, id);

        return toDetail(updated, normalized.tags);
      });
    },

    async updateNoteTitle(id, input) {
      assertNoteId(id);

      return db.transaction(async (tx) => {
        const current = await repository.findNoteByIdForUpdate(tx, id);
        if (!current || current.deletedAt) {
          throw new NoteNotFoundError();
        }

        if (current.version !== input.expectedVersion) {
          throw new NoteConflictError(current.version);
        }

        const tags = await repository.getNoteTags(tx, id);

        if (current.title === input.title) {
          return toDetail(current, tags);
        }

        const prepared = prepareNoteContent(input.title, current.contentMd, limits);
        const updated = await repository.updateNoteCas(tx, {
          id,
          expectedVersion: input.expectedVersion,
          title: input.title,
          contentMd: current.contentMd,
          contentPlain: prepared.contentPlain,
        });

        if (!updated) {
          await throwCasFailure(tx, id, false);
          throw new NoteConflictError(current.version);
        }

        await repository.insertRevision(tx, {
          noteId: id,
          noteVersion: updated.version,
          reason: "voice",
          beforeSnapshot: toSnapshot(current, tags),
          afterSnapshot: toSnapshot(updated, tags),
        });
        await refreshNoteSearch(tx, id);

        return toDetail(updated, tags);
      });
    },

    async deleteNote(id, expectedVersion) {
      assertNoteId(id);

      return db.transaction(async (tx) => {
        const current = await repository.findNoteByIdForUpdate(tx, id);
        if (!current || current.deletedAt) {
          throw new NoteNotFoundError();
        }

        if (current.version !== expectedVersion) {
          throw new NoteConflictError(current.version);
        }

        const tags = await repository.getNoteTags(tx, id);
        const updated = await repository.softDeleteNoteCas(
          tx,
          id,
          expectedVersion,
        );

        if (!updated) {
          await throwCasFailure(tx, id, false);
          throw new NoteConflictError(current.version);
        }

        await refreshNoteSearch(tx, id);

        return toDetail(updated, tags);
      });
    },

    async restoreNote(id, expectedVersion) {
      assertNoteId(id);

      return db.transaction(async (tx) => {
        const current = await repository.findNoteByIdForUpdate(tx, id);
        if (!current || !current.deletedAt) {
          throw new NoteNotFoundError();
        }

        if (current.version !== expectedVersion) {
          throw new NoteConflictError(current.version);
        }

        const tags = await repository.getNoteTags(tx, id);
        const updated = await repository.restoreNoteCas(
          tx,
          id,
          expectedVersion,
        );

        if (!updated) {
          await throwCasFailure(tx, id, true);
          throw new NoteConflictError(current.version);
        }

        await repository.insertRevision(tx, {
          noteId: id,
          noteVersion: updated.version,
          reason: "restore",
          beforeSnapshot: toSnapshot(current, tags),
          afterSnapshot: toSnapshot(updated, tags),
        });
        await refreshNoteSearch(tx, id);

        return toDetail(updated, tags);
      });
    },
  };
}

export function getNoteService(): NoteService {
  const config = loadConfig();

  return createNoteService({
    db: getDb(),
    limits: {
      title: TITLE_MAX_GRAPHEMES,
      content: config.noteMaxCharacters,
    },
    ttsCache: getTtsCache(),
  });
}
