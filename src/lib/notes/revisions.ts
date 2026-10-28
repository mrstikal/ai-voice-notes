import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";

import type { NoteSnapshot } from "../db/schema.ts";
import { getDb, type AppDatabase } from "../db/client.ts";
import { noteRevisions } from "../db/schema.ts";
import { loadConfig } from "../config.ts";
import { jsonError } from "../security/http.ts";
import {
  getTtsCache,
  purgeNoteTtsCacheBestEffort,
  type TtsCache,
} from "../tts/cache.ts";
import { DEFAULT_NOTE_GRAPHEME_LIMITS, TITLE_MAX_GRAPHEMES, type NoteGraphemeLimits } from "./limits.ts";
import * as repository from "./repository.ts";
import {
  NoteConflictError,
  NoteNotFoundError,
  NoteServiceError,
  assertNoteId,
  getNoteService,
  prepareNoteContent,
  toNoteErrorResponse,
  type NoteDetailDto,
  type NoteService,
} from "./service.ts";
import { refreshNoteSearch } from "../search/fts.ts";
import { refreshNoteChunks } from "../search/index-state.ts";

export type RevisionReason =
  | "initial"
  | "manual"
  | "voice"
  | "ai"
  | "undo"
  | "restore"
  | "metadata";

export const revisionRestoreInputSchema = z
  .object({
    mode: z.enum(["undo", "restore", "restore_before"]),
    expectedVersion: z.number().int().positive().max(2_147_483_647),
  })
  .strict();

export type RevisionRestoreInput = z.infer<
  typeof revisionRestoreInputSchema
>;

export interface RevisionDiff {
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
  readonly removed: string;
  readonly inserted: string;
  readonly suffix: string;
}

export interface RevisionDto {
  readonly id: string;
  readonly noteVersion: number;
  readonly reason: RevisionReason;
  readonly createdAt: Date;
  readonly beforeSnapshot: NoteSnapshot;
  readonly afterSnapshot: NoteSnapshot;
  readonly diff: RevisionDiff;
}

export interface RevisionHistoryDto {
  readonly currentVersion: number;
  readonly currentSnapshot: NoteSnapshot;
  readonly revisions: readonly RevisionDto[];
  readonly undoRevisionId: string | null;
  readonly canUndo: boolean;
}

export class RevisionServiceError extends Error {
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
    this.name = "RevisionServiceError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class RevisionNotFoundError extends RevisionServiceError {
  constructor() {
    super(404, "revision_not_found", "Verze poznámky nebyla nalezena.");
    this.name = "RevisionNotFoundError";
  }
}

export class RevisionConflictError extends RevisionServiceError {
  constructor(message: string) {
    super(409, "revision_conflict", message);
    this.name = "RevisionConflictError";
  }
}

export class RevisionNoChangeError extends RevisionServiceError {
  constructor() {
    super(
      409,
      "revision_no_change",
      "Vybraný snapshot je stejný jako aktuální poznámka.",
    );
    this.name = "RevisionNoChangeError";
  }
}

export interface RevisionServiceOptions {
  readonly db: AppDatabase;
  readonly noteService: NoteService;
  readonly limits?: NoteGraphemeLimits;
  readonly ttsCache?: Pick<TtsCache, "purgeNote"> | null;
}

export interface RevisionService {
  list(noteId: string): Promise<RevisionHistoryDto>;
  restore(
    noteId: string,
    revisionId: string,
    input: RevisionRestoreInput,
  ): Promise<NoteDetailDto>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertRevisionId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new RevisionNotFoundError();
  }
}

function diffText(beforeMd: string, afterMd: string): RevisionDiff {
  const minimum = Math.min(beforeMd.length, afterMd.length);
  let start = 0;

  while (start < minimum && beforeMd[start] === afterMd[start]) {
    start += 1;
  }

  let beforeEnd = beforeMd.length;
  let afterEnd = afterMd.length;

  while (
    beforeEnd > start &&
    afterEnd > start &&
    beforeMd[beforeEnd - 1] === afterMd[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  return {
    start,
    end: beforeEnd,
    prefix: beforeMd.slice(0, start),
    removed: beforeMd.slice(start, beforeEnd),
    inserted: afterMd.slice(start, afterEnd),
    suffix: beforeMd.slice(beforeEnd),
  };
}

function snapshot(
  row: repository.NoteRow,
  tags: readonly string[],
): NoteSnapshot {
  return {
    title: row.title,
    contentMd: row.contentMd,
    category: row.category,
    tags: [...new Set(tags)].sort(),
  };
}

function normalizedSnapshot(snapshot: NoteSnapshot): NoteSnapshot {
  return {
    ...snapshot,
    tags: [...new Set(snapshot.tags)].sort(),
  };
}

function snapshotsEqual(left: NoteSnapshot, right: NoteSnapshot): boolean {
  return (
    left.title === right.title &&
    left.contentMd === right.contentMd &&
    left.category === right.category &&
    left.tags.length === right.tags.length &&
    left.tags.every((tag, index) => tag === right.tags[index])
  );
}

function toRevisionDto(
  row: typeof noteRevisions.$inferSelect,
): RevisionDto {
  return {
    id: row.id,
    noteVersion: row.noteVersion,
    reason: row.reason as RevisionReason,
    createdAt: row.createdAt,
    beforeSnapshot: row.beforeSnapshot,
    afterSnapshot: row.afterSnapshot,
    diff: diffText(row.beforeSnapshot.contentMd, row.afterSnapshot.contentMd),
  };
}

function toNoteDetail(
  row: repository.NoteRow,
  tags: string[],
): NoteDetailDto {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    tags,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    contentMd: row.contentMd,
    contentPlain: row.contentPlain,
  };
}

export function createRevisionService(
  options: RevisionServiceOptions,
): RevisionService {
  const db = options.db;
  const limits = options.limits ?? DEFAULT_NOTE_GRAPHEME_LIMITS;

  return {
    async list(noteId) {
      assertNoteId(noteId);
      const note = await options.noteService.getNote(noteId);
      const tags = note.tags;
      const currentSnapshot = snapshot(
        {
          title: note.title,
          contentMd: note.contentMd,
          category: note.category,
          searchVector: null,
          version: note.version,
          contentPlain: note.contentPlain,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
          deletedAt: note.deletedAt,
          id: note.id,
          seedKey: null,
        },
        tags,
      );

      const rows = await db
        .select()
        .from(noteRevisions)
        .where(eq(noteRevisions.noteId, noteId))
        .orderBy(desc(noteRevisions.noteVersion));
      const latestUndoable = rows.find(
        (row) =>
          row.reason !== "initial" &&
          !snapshotsEqual(
            normalizedSnapshot(row.beforeSnapshot),
            normalizedSnapshot(row.afterSnapshot),
          ),
      );
      const canUndo =
        latestUndoable !== undefined &&
        latestUndoable.noteVersion === note.version;

      return {
        currentVersion: note.version,
        currentSnapshot,
        revisions: rows.map(toRevisionDto),
        undoRevisionId: canUndo ? latestUndoable.id : null,
        canUndo,
      };
    },

    async restore(noteId, revisionId, input) {
      assertNoteId(noteId);
      assertRevisionId(revisionId);

      let contentChanged = false;
      const result = await db.transaction(async (tx) => {
        const current = await repository.findNoteByIdForUpdate(tx, noteId);

        if (!current || current.deletedAt) {
          throw new NoteNotFoundError();
        }

        if (current.version !== input.expectedVersion) {
          throw new NoteConflictError(current.version);
        }

        const revisionRows = await tx
          .select()
          .from(noteRevisions)
          .where(
            and(
              eq(noteRevisions.id, revisionId),
              eq(noteRevisions.noteId, noteId),
            ),
          )
          .limit(1);
        const revision = revisionRows[0];

        if (!revision) {
          throw new RevisionNotFoundError();
        }

        const tags = await repository.getNoteTags(tx, noteId);
        const before = snapshot(current, tags);
        let target: NoteSnapshot;

        if (input.mode === "undo") {
          const latestRows = await tx
            .select()
            .from(noteRevisions)
            .where(
              and(
                eq(noteRevisions.noteId, noteId),
                ne(noteRevisions.reason, "initial"),
              ),
            )
            .orderBy(desc(noteRevisions.noteVersion))
            .limit(1);
          const latest = latestRows[0];

          if (!latest || latest.id !== revision.id) {
            throw new RevisionConflictError(
              "Vrátit lze pouze poslední pojmenovanou změnu.",
            );
          }

          if (current.version !== revision.noteVersion) {
            throw new NoteConflictError(current.version);
          }

          target = revision.beforeSnapshot;
        } else if (input.mode === "restore_before") {
          if (revision.reason !== "ai") {
            throw new RevisionConflictError(
              "Obnovit původní přepis lze pouze z AI revize.",
            );
          }

          if (revision.beforeSnapshot.contentMd.trim() === "") {
            throw new RevisionConflictError(
              "Původní přepis před zvolenou revizí je prázdný.",
            );
          }

          target = revision.beforeSnapshot;
        } else {
          target = revision.afterSnapshot;
        }

        const normalizedTarget: NoteSnapshot = {
          title: target.title,
          contentMd: target.contentMd,
          category: target.category,
          tags: [...new Set(target.tags)].sort(),
        };

        if (snapshotsEqual(before, normalizedTarget)) {
          throw new RevisionNoChangeError();
        }

        const prepared = prepareNoteContent(
          normalizedTarget.title,
          normalizedTarget.contentMd,
          limits,
        );
        const updated = await repository.updateNoteSnapshotCas(tx, {
          id: noteId,
          expectedVersion: current.version,
          title: normalizedTarget.title,
          contentMd: normalizedTarget.contentMd,
          contentPlain: prepared.contentPlain,
          category: normalizedTarget.category,
        });

        if (!updated) {
          throw new NoteConflictError(current.version);
        }

        await repository.replaceNoteTags(
          tx,
          noteId,
          normalizedTarget.tags,
        );
        contentChanged = updated.contentMd !== current.contentMd;
        const after = snapshot(updated, normalizedTarget.tags);

        await repository.insertRevision(tx, {
          noteId,
          noteVersion: updated.version,
          reason: input.mode === "undo" ? "undo" : "restore",
          beforeSnapshot: before,
          afterSnapshot: after,
        });
        await refreshNoteSearch(tx, noteId);
        await refreshNoteChunks(tx, updated);

        return toNoteDetail(updated, normalizedTarget.tags);
      });

      if (contentChanged) {
        await purgeNoteTtsCacheBestEffort(options.ttsCache, noteId);
      }

      return result;
    },
  };
}

export function getRevisionService(): RevisionService {
  const config = loadConfig();

  return createRevisionService({
    db: getDb(),
    noteService: getNoteService(),
    limits: {
      title: TITLE_MAX_GRAPHEMES,
      content: config.noteMaxCharacters,
    },
    ttsCache: getTtsCache(),
  });
}

export function toRevisionErrorResponse(error: unknown): Response {
  if (error instanceof NoteServiceError) {
    return toNoteErrorResponse(error);
  }

  if (error instanceof RevisionServiceError) {
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
    "Požadavek na historii poznámky se nepodařilo zpracovat.",
  );
}
