import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { and, eq, isNull, lte } from "drizzle-orm";
import { z } from "zod";

import {
  llmOperationSchema,
  type LlmOperation,
} from "../ai/schemas.ts";
import { getDb, type AppDatabase } from "../db/client.ts";
import { editProposals } from "../db/schema.ts";
import { loadConfig } from "../config.ts";
import { jsonError } from "../security/http.ts";
import {
  getTtsCache,
  purgeNoteTtsCacheBestEffort,
  type TtsCache,
} from "../tts/cache.ts";
import * as repository from "./repository.ts";
import {
  NoteServiceError,
  assertNoteId,
  getNoteService,
  prepareNoteContent,
  toNoteErrorResponse,
  type NoteDetailDto,
  type NoteService,
} from "./service.ts";
import { refreshNoteSearch } from "../search/fts.ts";
import {
  DEFAULT_NOTE_GRAPHEME_LIMITS as DEFAULT_PROPOSAL_LIMITS,
  TITLE_MAX_GRAPHEMES,
  type NoteGraphemeLimits,
} from "./limits.ts";
import {
  hashNoteSource,
  resolveOperation,
  type OperationCandidate,
} from "./operations.ts";


export const PROPOSAL_EXPIRY_MS = 5 * 60_000;
export const PROPOSAL_TEXT_MAX_BYTES = 32 * 1024;

const expectedVersionSchema = z
  .number()
  .int()
  .positive()
  .max(2_147_483_647);
const sourceHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const createEditProposalInputSchema = z
  .object({
    operation: llmOperationSchema,
    candidateId: z.string().min(1).max(120).optional(),
    expectedVersion: expectedVersionSchema.optional(),
    expectedSourceHash: sourceHashSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.candidateId !== undefined &&
      (value.expectedVersion === undefined ||
        value.expectedSourceHash === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Výběr kandidáta vyžaduje expectedVersion i expectedSourceHash.",
        path: ["candidateId"],
      });
    }
  });

export type CreateEditProposalInput = z.infer<
  typeof createEditProposalInputSchema
>;

export const confirmEditProposalInputSchema = z
  .object({
    confirmationNonce: z.string().min(16).max(200),
    expectedVersion: expectedVersionSchema,
  })
  .strict();

export type ConfirmEditProposalInput = z.infer<
  typeof confirmEditProposalInputSchema
>;

export type EditProposalStatus =
  | "pending"
  | "rejected"
  | "applied"
  | "expired";

export interface EditProposalDiff {
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
  readonly removed: string;
  readonly inserted: string;
  readonly suffix: string;
}

export interface EditProposalDto {
  readonly id: string;
  readonly noteId: string;
  readonly noteTitle: string;
  readonly expectedVersion: number;
  readonly originalHash: string;
  readonly operation: LlmOperation;
  readonly beforeMd: string;
  readonly afterMd: string;
  readonly selectedCandidate: OperationCandidate | null;
  readonly status: EditProposalStatus;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly diff: EditProposalDiff;
}

export interface ConfirmedEditProposalDto {
  readonly proposal: EditProposalDto;
  readonly note: NoteDetailDto;
}

export interface CreatedEditProposalDto extends EditProposalDto {
  /**
   * Raw, one-use UI confirmation nonce. It is returned only from the
   * same-origin proposal creation response; the database stores only its
   * SHA-256 hash, and GET/reject never expose it. Never pass it to a model.
   */
  readonly confirmationNonce: string;
}

export class EditProposalError extends Error {
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
    this.name = "EditProposalError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class EditProposalNotFoundError extends EditProposalError {
  constructor() {
    super(404, "proposal_not_found", "Návrh úpravy nebyl nalezen.");
    this.name = "EditProposalNotFoundError";
  }
}

export class EditProposalAmbiguousError extends EditProposalError {
  readonly candidates: readonly OperationCandidate[];
  readonly noteVersion: number | null;
  readonly sourceHash: string;

  constructor(
    candidates: readonly OperationCandidate[],
    noteVersion: number | null,
    sourceHash: string,
  ) {
    super(
      409,
      "proposal_ambiguous",
      "Cíl odpovídá více místům. Vyberte konkrétního kandidáta.",
      { candidates, noteVersion, sourceHash },
    );
    this.name = "EditProposalAmbiguousError";
    this.candidates = candidates;
    this.noteVersion = noteVersion;
    this.sourceHash = sourceHash;
  }
}

export class EditProposalStaleError extends EditProposalError {
  constructor(code: "version_mismatch" | "source_mismatch") {
    super(
      409,
      "proposal_stale",
      code === "version_mismatch"
        ? "Poznámka byla mezitím změněna. Vytvořte nový návrh."
        : "Zdrojový hash poznámky už neodpovídá. Vytvořte nový návrh.",
      { reason: code },
    );
    this.name = "EditProposalStaleError";
  }
}

export class EditProposalInvalidError extends EditProposalError {
  constructor(
    reason: string,
    message: string,
    status = 422,
  ) {
    super(status, "proposal_invalid", message, { reason });
    this.name = "EditProposalInvalidError";
  }
}

export class EditProposalNoMatchError extends EditProposalError {
  constructor(
    message = "Cíl úpravy se v poznámce nepodařilo jednoznačně najít.",
  ) {
    super(409, "proposal_no_match", message);
    this.name = "EditProposalNoMatchError";
  }
}

export class EditProposalNonceError extends EditProposalError {
  constructor() {
    super(
      403,
      "proposal_invalid_nonce",
      "Potvrzovací nonce není platný. Návrh nebyl aplikován.",
    );
    this.name = "EditProposalNonceError";
  }
}

export class EditProposalExpiredError extends EditProposalError {
  constructor() {
    super(
      409,
      "proposal_expired",
      "Návrh vypršel. Vytvořte nový návrh.",
    );
    this.name = "EditProposalExpiredError";
  }
}

export class EditProposalAlreadyAppliedError extends EditProposalError {
  constructor() {
    super(
      409,
      "proposal_already_applied",
      "Návrh už byl aplikován. Poznámka se znovu nezmění.",
    );
    this.name = "EditProposalAlreadyAppliedError";
  }
}

export class EditProposalDiffMismatchError extends EditProposalError {
  constructor() {
    super(
      409,
      "proposal_diff_mismatch",
      "Přepočítaný diff neodpovídá uloženému návrhu. Návrh nebyl aplikován.",
    );
    this.name = "EditProposalDiffMismatchError";
  }
}

export class EditProposalNoChangeError extends EditProposalError {
  constructor() {
    super(
      409,
      "proposal_no_change",
      "Návrh neobsahuje žádnou změnu, kterou by šlo aplikovat.",
    );
    this.name = "EditProposalNoChangeError";
  }
}

export class EditProposalConflictError extends EditProposalError {
  constructor(message = "Návrh už nelze změnit.") {
    super(409, "proposal_conflict", message);
    this.name = "EditProposalConflictError";
  }
}

export interface EditProposalServiceOptions {
  readonly db: AppDatabase;
  readonly noteService: NoteService;
  readonly now?: () => Date;
  readonly nonceFactory?: () => string;
  readonly expiryMs?: number;
  readonly limits?: NoteGraphemeLimits;
  readonly ttsCache?: Pick<TtsCache, "purgeNote"> | null;
}

export interface EditProposalService {
  create(
    noteId: string,
    input: CreateEditProposalInput,
  ): Promise<CreatedEditProposalDto>;
  get(noteId: string, proposalId: string): Promise<EditProposalDto>;
  reject(noteId: string, proposalId: string): Promise<EditProposalDto>;
  confirm(
    noteId: string,
    proposalId: string,
    input: ConfirmEditProposalInput,
  ): Promise<ConfirmedEditProposalDto>;
}

const PROPOSAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertProposalId(id: string): void {
  if (!PROPOSAL_UUID_PATTERN.test(id)) {
    throw new EditProposalNotFoundError();
  }
}

export function hashConfirmationNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

function computeProposalDiff(
  beforeMd: string,
  afterMd: string,
): EditProposalDiff {
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

function toDto(row: typeof editProposals.$inferSelect): EditProposalDto {
  return {
    id: row.id,
    noteId: row.noteId,
    noteTitle: row.noteTitle,
    expectedVersion: row.expectedVersion,
    originalHash: row.originalHash,
    operation: row.operation,
    beforeMd: row.beforeMd,
    afterMd: row.afterMd,
    selectedCandidate: row.selectedCandidate ?? null,
    status: row.status as EditProposalStatus,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    diff: computeProposalDiff(row.beforeMd, row.afterMd),
  };
}

async function expirePending(
  db: AppDatabase,
  now: Date,
): Promise<void> {
  await db
    .update(editProposals)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(editProposals.status, "pending"),
        lte(editProposals.expiresAt, now),
      ),
    );
}

function resolveFailureToProposalError(
  result: ReturnType<typeof resolveOperation>,
): EditProposalError {
  switch (result.status) {
    case "ambiguous":
      return new EditProposalAmbiguousError(
        result.candidates,
        result.noteVersion,
        result.sourceHash,
      );
    case "stale":
      return new EditProposalStaleError(result.code);
    case "no_match":
      return new EditProposalNoMatchError(result.message);
    case "invalid":
      return new EditProposalInvalidError(
        result.code,
        result.message,
        result.code === "text_too_large" ||
          result.code === "paragraph_too_large"
          ? 413
          : 422,
      );
    case "resolved":
      throw new Error("Neočekávaný stav resolveru.");
  }
}

function nonceHashMatches(actualHex: string, expectedHex: string): boolean {
  try {
    const actual = Buffer.from(actualHex, "hex");
    const expected = Buffer.from(expectedHex, "hex");

    return (
      actual.length === expected.length &&
      actual.length > 0 &&
      timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}

function toNoteDetail(
  row: repository.NoteRow,
  tags: string[],
): NoteDetailDto {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    contentMd: row.contentMd,
    contentPlain: row.contentPlain,
    tags,
  };
}

export function createEditProposalService(
  options: EditProposalServiceOptions,
): EditProposalService {
  const db = options.db;
  const now = options.now ?? (() => new Date());
  const nonceFactory =
    options.nonceFactory ?? (() => randomBytes(32).toString("base64url"));
  const expiryMs = options.expiryMs ?? PROPOSAL_EXPIRY_MS;
  const limits = options.limits ?? DEFAULT_PROPOSAL_LIMITS;

  return {
    async create(noteId, input) {
      assertNoteId(noteId);
      const createdAt = now();
      await expirePending(db, createdAt);

      const note = await options.noteService.getNote(noteId);
      const resolution = resolveOperation({
        contentMd: note.contentMd,
        operation: input.operation,
        noteVersion: note.version,
        deletedAt: note.deletedAt,
        expectedVersion: input.expectedVersion,
        expectedSourceHash: input.expectedSourceHash,
        candidateId: input.candidateId,
      });

      if (resolution.status !== "resolved") {
        throw resolveFailureToProposalError(resolution);
      }

      const confirmationNonce = nonceFactory();
      const expiresAt = new Date(createdAt.getTime() + expiryMs);

      const rows = await db
        .insert(editProposals)
        .values({
          noteId,
          noteTitle: note.title,
          expectedVersion: note.version,
          originalHash: resolution.sourceHash,
          operation: resolution.operation,
          beforeMd: resolution.beforeMd,
          afterMd: resolution.afterMd,
          selectedCandidate: resolution.candidate,
          status: "pending",
          confirmationNonceHash: hashConfirmationNonce(confirmationNonce),
          expiresAt,
          createdAt,
          updatedAt: createdAt,
        })
        .returning();
      const row = rows[0];

      if (!row) {
        throw new EditProposalError(
          500,
          "proposal_create_failed",
          "Návrh úpravy se nepodařilo uložit.",
        );
      }

      return {
        ...toDto(row),
        confirmationNonce,
      };
    },

    async get(noteId, proposalId) {
      assertNoteId(noteId);
      assertProposalId(proposalId);
      await expirePending(db, now());

      const rows = await db
        .select()
        .from(editProposals)
        .where(
          and(
            eq(editProposals.id, proposalId),
            eq(editProposals.noteId, noteId),
          ),
        )
        .limit(1);
      const row = rows[0];

      if (!row) {
        throw new EditProposalNotFoundError();
      }

      return toDto(row);
    },

    async reject(noteId, proposalId) {
      assertNoteId(noteId);
      assertProposalId(proposalId);
      const changedAt = now();
      await expirePending(db, changedAt);

      const rows = await db
        .select()
        .from(editProposals)
        .where(
          and(
            eq(editProposals.id, proposalId),
            eq(editProposals.noteId, noteId),
          ),
        )
        .limit(1);
      const current = rows[0];

      if (!current) {
        throw new EditProposalNotFoundError();
      }

      if (current.status === "applied") {
        throw new EditProposalConflictError(
          "Aplikovaný návrh už nelze zamítnout.",
        );
      }

      if (current.status === "pending") {
        const updatedRows = await db
          .update(editProposals)
          .set({ status: "rejected", updatedAt: changedAt })
          .where(
            and(
              eq(editProposals.id, proposalId),
              eq(editProposals.status, "pending"),
            ),
          )
          .returning();
        const updated = updatedRows[0];

        if (updated) {
          return toDto(updated);
        }
      }

      const refreshed = await db
        .select()
        .from(editProposals)
        .where(eq(editProposals.id, proposalId))
        .limit(1);

      if (!refreshed[0]) {
        throw new EditProposalNotFoundError();
      }

      if (refreshed[0].status === "applied") {
        throw new EditProposalConflictError(
          "Aplikovaný návrh už nelze zamítnout.",
        );
      }

      return toDto(refreshed[0]);
    },

    async confirm(noteId, proposalId, input) {
      assertNoteId(noteId);
      assertProposalId(proposalId);

      const outcome = await db.transaction(async (tx) => {
        const proposalRows = await tx
          .select()
          .from(editProposals)
          .where(
            and(
              eq(editProposals.id, proposalId),
              eq(editProposals.noteId, noteId),
            ),
          )
          .limit(1)
          .for("update");
        const proposal = proposalRows[0];

        if (!proposal) {
          throw new EditProposalNotFoundError();
        }

        if (
          proposal.status === "applied" ||
          proposal.confirmationNonceUsedAt !== null
        ) {
          throw new EditProposalAlreadyAppliedError();
        }

        if (proposal.status === "expired") {
          throw new EditProposalExpiredError();
        }

        if (proposal.status === "rejected") {
          throw new EditProposalConflictError(
            "Zamítnutý návrh už nelze aplikovat.",
          );
        }

        const changedAt = now();

        if (proposal.expiresAt.getTime() <= changedAt.getTime()) {
          await tx
            .update(editProposals)
            .set({ status: "expired", updatedAt: changedAt })
            .where(
              and(
                eq(editProposals.id, proposalId),
                eq(editProposals.status, "pending"),
              ),
            );

          return { kind: "expired" as const };
        }

        if (input.expectedVersion !== proposal.expectedVersion) {
          throw new EditProposalStaleError("version_mismatch");
        }

        if (
          !nonceHashMatches(
            hashConfirmationNonce(input.confirmationNonce),
            proposal.confirmationNonceHash,
          )
        ) {
          throw new EditProposalNonceError();
        }

        const current = await repository.findNoteByIdForUpdate(tx, noteId);

        if (!current || current.deletedAt) {
          throw new EditProposalConflictError(
            "Poznámka byla mezitím smazána. Návrh nelze aplikovat.",
          );
        }

        if (current.version !== proposal.expectedVersion) {
          throw new EditProposalStaleError("version_mismatch");
        }

        if (hashNoteSource(current.contentMd) !== proposal.originalHash) {
          throw new EditProposalStaleError("source_mismatch");
        }

        const resolution = resolveOperation({
          contentMd: current.contentMd,
          operation: proposal.operation,
          noteVersion: current.version,
          expectedVersion: proposal.expectedVersion,
          expectedSourceHash: proposal.originalHash,
          candidateId: proposal.selectedCandidate?.id,
        });

        if (resolution.status !== "resolved") {
          throw resolveFailureToProposalError(resolution);
        }

        if (
          resolution.beforeMd !== proposal.beforeMd ||
          resolution.afterMd !== proposal.afterMd
        ) {
          throw new EditProposalDiffMismatchError();
        }

        if (!resolution.changed) {
          throw new EditProposalNoChangeError();
        }

        const prepared = prepareNoteContent(
          current.title,
          proposal.afterMd,
          limits,
        );
        const tags = await repository.getNoteTags(tx, noteId);
        const updated = await repository.updateNoteCas(tx, {
          id: noteId,
          expectedVersion: current.version,
          title: current.title,
          contentMd: proposal.afterMd,
          contentPlain: prepared.contentPlain,
        });

        if (!updated) {
          throw new EditProposalConflictError();
        }

        await repository.insertRevision(tx, {
          noteId,
          noteVersion: updated.version,
          reason: "ai",
          beforeSnapshot: {
            title: current.title,
            contentMd: current.contentMd,
            category: current.category,
            tags,
          },
          afterSnapshot: {
            title: updated.title,
            contentMd: updated.contentMd,
            category: updated.category,
            tags,
          },
        });
        await refreshNoteSearch(tx, noteId);

        const updatedProposalRows = await tx
          .update(editProposals)
          .set({
            status: "applied",
            confirmationNonceUsedAt: changedAt,
            updatedAt: changedAt,
          })
          .where(
            and(
              eq(editProposals.id, proposalId),
              eq(editProposals.status, "pending"),
              isNull(editProposals.confirmationNonceUsedAt),
            ),
          )
          .returning();
        const updatedProposal = updatedProposalRows[0];

        if (!updatedProposal) {
          throw new EditProposalConflictError();
        }

        return {
          kind: "applied" as const,
          proposal: updatedProposal,
          note: updated,
          tags,
        };
      });

      if (outcome.kind === "expired") {
        throw new EditProposalExpiredError();
      }

      await purgeNoteTtsCacheBestEffort(options.ttsCache, noteId);

      return {
        proposal: toDto(outcome.proposal),
        note: toNoteDetail(outcome.note, outcome.tags),
      };
    },
  };
}

export function getEditProposalService(): EditProposalService {
  const config = loadConfig();

  return createEditProposalService({
    db: getDb(),
    noteService: getNoteService(),
    limits: {
      title: TITLE_MAX_GRAPHEMES,
      content: config.noteMaxCharacters,
    },
    ttsCache: getTtsCache(),
  });
}

export function toEditProposalErrorResponse(error: unknown): Response {
  if (error instanceof NoteServiceError) {
    return toNoteErrorResponse(error);
  }

  if (error instanceof EditProposalError) {
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
    "Požadavek na návrh úpravy se nepodařilo zpracovat.",
  );
}
