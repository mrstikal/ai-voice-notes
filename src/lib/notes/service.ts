import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { loadConfig } from "../config.ts";
import { getDb, type AppDatabase } from "../db/client.ts";
import { meetingSaves, type NoteSnapshot } from "../db/schema.ts";
import {
  NOTE_EDIT_MAX_BYTES,
  jsonError,
} from "../security/http.ts";
import { noteMutationPayloadSchema } from "../security/schemas.ts";
import {
  DEFAULT_NOTE_GRAPHEME_LIMITS,
  NoteLimitError,
  TITLE_MAX_GRAPHEMES,
  countGraphemes,
  validateNoteGraphemeLimits,
  type NoteGraphemeLimits,
} from "./limits.ts";
import {
  MEETING_SAVE_LABEL_MAX_GRAPHEMES,
  MEETING_SAVE_MAX_BYTES,
  MEETING_SAVE_MAX_PARTS,
  MEETING_SAVE_TITLE_MAX_GRAPHEMES,
} from "../meetings/save-shared.ts";
import {
  getTtsCache,
  purgeNoteTtsCacheBestEffort,
  type TtsCache,
} from "../tts/cache.ts";
import { parseNoteMarkdown } from "./markdown.ts";
import { refreshNoteSearch } from "../search/fts.ts";
import { refreshNoteChunks } from "../search/index-state.ts";
import {
  NOTE_CATEGORIES,
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

export const updateNoteVoiceContentInputSchema = z
  .object({
    baselineContentMd: z.string(),
    contentMd: z.string(),
    expectedVersion: expectedVersionSchema,
  })
  .strict();

export const updateNoteMetadataInputSchema = z
  .object({
    category: z
      .union([z.enum(NOTE_CATEGORIES), z.literal("")])
      .nullable(),
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

const meetingSaveSegmentSchema = z
  .object({
    label: z.string().max(1_000),
    text: z.string().max(MEETING_SAVE_MAX_BYTES),
  })
  .strict();

export const saveMeetingInputSchema = z
  .object({
    requestId: z.string().uuid(),
    title: z.string().max(1_000),
    segments: z.array(meetingSaveSegmentSchema).max(2_000).optional(),
    text: z.string().max(MEETING_SAVE_MAX_BYTES).optional(),
  })
  .strict()
  .refine(
    (input) => (input.segments !== undefined) !== (input.text !== undefined),
    "Přepis musí mít právě jednu formu: segments, nebo text.",
  );

export type CreateNoteInput = z.infer<typeof createNoteInputSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteInputSchema>;
export type UpdateNoteVoiceContentInput = z.infer<
  typeof updateNoteVoiceContentInputSchema
>;
export type UpdateNoteMetadataInput = z.infer<typeof updateNoteMetadataInputSchema>;
export type UpdateNoteTitleInput = z.infer<typeof updateNoteTitleInputSchema>;
export type DeleteNoteInput = z.infer<typeof deleteNoteInputSchema>;
export type RestoreNoteInput = z.infer<typeof restoreNoteInputSchema>;
export type SaveMeetingInput = z.infer<typeof saveMeetingInputSchema>;

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
  readonly meetingSaveAfterNoteInsert?: (insertedCount: number) => Promise<void> | void;
}

export interface SaveMeetingResult {
  readonly requestId: string;
  readonly noteIds: readonly string[];
  readonly count: number;
  readonly duplicate: boolean;
}

export interface MeetingNotePart {
  readonly title: string;
  readonly contentMd: string;
  readonly contentPlain: string;
}

interface MeetingCanonicalEntry {
  readonly plain: string;
  readonly markdown: string;
}

export interface NoteService {
  listActiveNotes(page: number): Promise<NotePageDto>;
  listDeletedNotes(page: number): Promise<NotePageDto>;
  getNote(id: string): Promise<NoteDetailDto>;
  createNote(input: CreateNoteInput): Promise<NoteDetailDto>;
  updateNote(id: string, input: UpdateNoteInput): Promise<NoteDetailDto>;
  updateNoteVoiceContent(
    id: string,
    input: UpdateNoteVoiceContentInput,
  ): Promise<NoteDetailDto>;
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
  saveMeeting(input: SaveMeetingInput): Promise<SaveMeetingResult>;
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
  await refreshNoteChunks(db, note);

  return toDetail(note, tags);
}

export class MeetingSaveConflictError extends NoteServiceError {
  constructor() {
    super(
      409,
      "meeting_save_conflict",
      "Tento přepis už byl uložen s jiným obsahem. Upravte uloženou poznámku, nebo přepis zahoďte a vytvořte nový.",
    );
    this.name = "MeetingSaveConflictError";
  }
}

export class MeetingTranscriptTooLongError extends NoteServiceError {
  constructor(details: {
    readonly limit: number;
    readonly totalGraphemes: number;
    readonly maxParts: number;
    readonly requiredParts: number;
    readonly reason: "single_paragraph" | "too_many_parts";
  }) {
    super(
      422,
      "meeting_transcript_too_long",
      details.reason === "single_paragraph"
        ? `Jeden odstavec přepisu má ${details.totalGraphemes} znaků, ale poznámka může mít nejvýše ${details.limit}. Zkraťte jej nebo si přepis stáhněte.`
        : `Přepis by vyžadoval ${details.requiredParts} poznámek, ale uložit lze nejvýše ${details.maxParts}. Zkraťte přepis nebo si jej stáhněte.`,
      { ...details },
    );
    this.name = "MeetingTranscriptTooLongError";
  }
}

export class MeetingTranscriptEmptyError extends NoteServiceError {
  constructor() {
    super(400, "meeting_transcript_empty", "Přepis je prázdný.");
    this.name = "MeetingTranscriptEmptyError";
  }
}

export class MeetingTitleEmptyError extends NoteServiceError {
  constructor() {
    super(400, "meeting_title_empty", "Zadejte název zápisu.");
    this.name = "MeetingTitleEmptyError";
  }
}

export class MeetingTitleTooLongError extends NoteServiceError {
  constructor(limit: number, message?: string) {
    super(
      400,
      "meeting_title_too_long",
      message ??
        `Název zápisu včetně číslování částí může mít nejvýše ${limit} znaků.`,
    );
    this.name = "MeetingTitleTooLongError";
  }
}

export class MeetingLabelTooLongError extends NoteServiceError {
  constructor(limit: number) {
    super(
      400,
      "meeting_label_too_long",
      `Název mluvčího může mít nejvýše ${limit} znaků.`,
    );
    this.name = "MeetingLabelTooLongError";
  }
}

function normalizeReviewedText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim();
}

function reviewedParagraphs(value: string): string[] {
  return normalizeReviewedText(value)
    .split(/\n[ \t]*\n/u)
    .map((paragraph) => paragraph.replace(/\n/gu, " ").trim())
    .filter((paragraph) => paragraph !== "");
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/[`*_[\]<>~]/gu, "\\$&")
    .replace(/&(?=#?[A-Za-z0-9]+;)/gu, "\\&")
    .replace(/^([#>+=-])/u, "\\$1")
    .replace(/^(\d{1,9})([.)])/u, "$1\\$2");
}

function canonicalMeetingEntries(input: {
  readonly segments?: readonly { readonly label: string; readonly text: string }[];
  readonly text?: string;
}): MeetingCanonicalEntry[] {
  if ((input.segments === undefined) === (input.text === undefined)) {
    throw new NoteValidationError(
      "Přepis musí mít právě jednu formu: segments, nebo text.",
    );
  }

  const blocks =
    input.segments ??
    [{ label: "", text: input.text ?? "" }];
  const entries: MeetingCanonicalEntry[] = [];

  for (const block of blocks) {
    const label = normalizeReviewedText(block.label).replace(
      /\s*\n\s*/gu,
      " ",
    );
    const labelGraphemes = countGraphemes(label);

    if (labelGraphemes > MEETING_SAVE_LABEL_MAX_GRAPHEMES) {
      throw new MeetingLabelTooLongError(MEETING_SAVE_LABEL_MAX_GRAPHEMES);
    }

    for (const paragraph of reviewedParagraphs(block.text)) {
      const plain = label === "" ? paragraph : `${label}: ${paragraph}`;
      const escapedParagraph = escapeMarkdownText(paragraph);

      entries.push({
        plain,
        markdown:
          label === ""
            ? escapedParagraph
            : `**${escapeMarkdownText(label)}:** ${escapedParagraph}`,
      });
    }
  }

  if (entries.length === 0) {
    throw new MeetingTranscriptEmptyError();
  }

  return entries;
}

export interface MeetingSavePlan {
  readonly parts: readonly MeetingNotePart[];
  readonly inputHash: string;
  readonly totalGraphemes: number;
}

export function planMeetingSave(
  input: Pick<SaveMeetingInput, "title" | "segments" | "text">,
  limits: NoteGraphemeLimits = DEFAULT_NOTE_GRAPHEME_LIMITS,
): MeetingSavePlan {
  const baseTitle = normalizeReviewedText(input.title).replace(
    /\s*\n\s*/gu,
    " ",
  );

  if (baseTitle === "") {
    throw new MeetingTitleEmptyError();
  }

  const baseTitleLimit = Math.min(
    limits.title,
    MEETING_SAVE_TITLE_MAX_GRAPHEMES,
  );

  if (countGraphemes(baseTitle) > baseTitleLimit) {
    throw new MeetingTitleTooLongError(
      baseTitleLimit,
      `Název zápisu může mít nejvýše ${baseTitleLimit} znaků. Číslování částí se přidává automaticky.`,
    );
  }

  const entries = canonicalMeetingEntries(input);
  const counts = entries.map((entry) => countGraphemes(entry.plain));
  const totalGraphemes =
    counts.reduce((total, count) => total + count, 0) +
    Math.max(0, entries.length - 1) * 2;

  const groups: MeetingCanonicalEntry[][] = [];
  let current: MeetingCanonicalEntry[] = [];
  let currentGraphemes = 0;

  for (const [index, entry] of entries.entries()) {
    const count = counts[index]!;

    if (count > limits.content) {
      throw new MeetingTranscriptTooLongError({
        limit: limits.content,
        totalGraphemes: count,
        maxParts: MEETING_SAVE_MAX_PARTS,
        requiredParts: 1,
        reason: "single_paragraph",
      });
    }

    if (current.length > 0 && currentGraphemes + count + 2 > limits.content) {
      groups.push(current);
      current = [];
      currentGraphemes = 0;
    }

    currentGraphemes += current.length === 0 ? count : count + 2;
    current.push(entry);
  }

  if (current.length > 0) {
    groups.push(current);
  }

  if (groups.length > MEETING_SAVE_MAX_PARTS) {
    throw new MeetingTranscriptTooLongError({
      limit: limits.content,
      totalGraphemes,
      maxParts: MEETING_SAVE_MAX_PARTS,
      requiredParts: groups.length,
      reason: "too_many_parts",
    });
  }

  const parts = groups.map((group, index) => {
    const title =
      groups.length === 1
        ? baseTitle
        : `${baseTitle} – část ${index + 1}/${groups.length}`;

    if (countGraphemes(title) > limits.title) {
      throw new MeetingTitleTooLongError(limits.title);
    }

    const contentMd = group.map((entry) => entry.markdown).join("\n\n");
    const prepared = prepareNoteContent(title, contentMd, limits);

    return {
      title,
      contentMd,
      contentPlain: prepared.contentPlain,
    } satisfies MeetingNotePart;
  });

  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        title: baseTitle,
        blocks: entries.map((entry) => entry.plain),
      }),
    )
    .digest("hex");

  return { parts, inputHash, totalGraphemes };
}

export function buildMeetingNoteParts(
  input: Pick<SaveMeetingInput, "title" | "segments" | "text">,
  limits: NoteGraphemeLimits = DEFAULT_NOTE_GRAPHEME_LIMITS,
): MeetingNotePart[] {
  return [...planMeetingSave(input, limits).parts];
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
        await refreshNoteChunks(tx, note);

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
        await refreshNoteChunks(tx, updated, {
          reuseReadyEmbeddingsFromVersion: contentChanged
            ? undefined
            : current.version,
        });

        return toDetail(updated, tags);
      });

      if (contentChanged) {
        await purgeNoteTtsCacheBestEffort(options.ttsCache, id);
      }

      return result;
    },

    async updateNoteVoiceContent(id, input) {
      assertNoteId(id);
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
        contentChanged = current.contentMd !== input.contentMd;
        prepareNoteContent(current.title, input.baselineContentMd, limits);
        const prepared = prepareNoteContent(
          current.title,
          input.contentMd,
          limits,
        );
        const updated = await repository.updateNoteCas(tx, {
          id,
          expectedVersion: input.expectedVersion,
          title: current.title,
          contentMd: input.contentMd,
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
          beforeSnapshot: {
            title: current.title,
            contentMd: input.baselineContentMd,
            category: current.category,
            tags,
          },
          afterSnapshot: toSnapshot(updated, tags),
        });
        await refreshNoteSearch(tx, id);
        await refreshNoteChunks(tx, updated, {
          reuseReadyEmbeddingsFromVersion: contentChanged
            ? undefined
            : current.version,
        });

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
        await refreshNoteChunks(tx, updated, {
          reuseReadyEmbeddingsFromVersion: current.version,
        });

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
        await refreshNoteChunks(tx, updated, {
          reuseReadyEmbeddingsFromVersion: current.version,
        });

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
        await refreshNoteChunks(tx, updated);

        return toDetail(updated, tags);
      });
    },
    async saveMeeting(input) {
      const plan = planMeetingSave(input, limits);

      return db.transaction(async (tx) => {
        const inserted = await tx
          .insert(meetingSaves)
          .values({
            requestId: input.requestId,
            inputHash: plan.inputHash,
            noteIds: [],
          })
          .onConflictDoNothing()
          .returning();

        if (inserted.length === 0) {
          const existing = await tx
            .select()
            .from(meetingSaves)
            .where(eq(meetingSaves.requestId, input.requestId))
            .limit(1);
          const row = existing[0];

          if (!row) {
            throw new NoteServiceError(
              503,
              "meeting_save_unavailable",
              "Uložení zápisu se nepodařilo ověřit. Zkuste to znovu.",
            );
          }

          if (row.inputHash !== plan.inputHash) {
            throw new MeetingSaveConflictError();
          }

          return {
            requestId: input.requestId,
            noteIds: row.noteIds,
            count: row.noteIds.length,
            duplicate: true,
          } satisfies SaveMeetingResult;
        }

        const noteIds: string[] = [];

        for (const part of plan.parts) {
          const note = await repository.insertNote(tx, {
            title: part.title,
            contentMd: part.contentMd,
            contentPlain: part.contentPlain,
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
          await refreshNoteChunks(tx, note);
          noteIds.push(note.id);
          await options.meetingSaveAfterNoteInsert?.(noteIds.length);
        }

        await tx
          .update(meetingSaves)
          .set({ noteIds })
          .where(eq(meetingSaves.requestId, input.requestId));

        return {
          requestId: input.requestId,
          noteIds,
          count: noteIds.length,
          duplicate: false,
        } satisfies SaveMeetingResult;
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
