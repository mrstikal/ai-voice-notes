import { createHash, randomBytes } from "node:crypto";

import { and, eq, lte } from "drizzle-orm";
import { z } from "zod";

import {
  llmOperationSchema,
  type LlmOperation,
} from "../ai/schemas.ts";
import { getDb, type AppDatabase } from "../db/client.ts";
import { editProposals } from "../db/schema.ts";
import { jsonError } from "../security/http.ts";
import {
  NoteServiceError,
  assertNoteId,
  getNoteService,
  toNoteErrorResponse,
  type NoteService,
} from "./service.ts";
import {
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
  constructor() {
    super(
      409,
      "proposal_no_match",
      "Cíl úpravy se v poznámce nepodařilo jednoznačně najít.",
    );
    this.name = "EditProposalNoMatchError";
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
}

export interface EditProposalService {
  create(
    noteId: string,
    input: CreateEditProposalInput,
  ): Promise<CreatedEditProposalDto>;
  get(noteId: string, proposalId: string): Promise<EditProposalDto>;
  reject(noteId: string, proposalId: string): Promise<EditProposalDto>;
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
      return new EditProposalNoMatchError();
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

export function createEditProposalService(
  options: EditProposalServiceOptions,
): EditProposalService {
  const db = options.db;
  const now = options.now ?? (() => new Date());
  const nonceFactory =
    options.nonceFactory ?? (() => randomBytes(32).toString("base64url"));
  const expiryMs = options.expiryMs ?? PROPOSAL_EXPIRY_MS;

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

      return toDto(refreshed[0]);
    },
  };
}

export function getEditProposalService(): EditProposalService {
  return createEditProposalService({
    db: getDb(),
    noteService: getNoteService(),
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
