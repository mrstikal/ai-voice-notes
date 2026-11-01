import { and, eq, inArray, sql } from "drizzle-orm";

import type { AppDatabase } from "../db/client.ts";
import { noteChunks, notes } from "../db/schema.ts";
import { readEnvInt } from "../env-limits.ts";
import { refreshNoteChunks } from "./index-state.ts";
import {
  EMBEDDING_BATCH_MAX_TEXTS,
  EMBEDDING_DIMENSIONS,
  EmbeddingError,
  estimateEmbeddingMaxCostUsd,
  type EmbeddingService,
} from "./embeddings.ts";

export const REINDEX_MAX_NOTES = readEnvInt("REINDEX_MAX_NOTES", 3);
export const REINDEX_MAX_CHUNKS = EMBEDDING_BATCH_MAX_TEXTS;
export const REINDEX_PREPARE_MAX_NOTES = readEnvInt(
  "REINDEX_PREPARE_MAX_NOTES",
  10,
);
export const REINDEX_CANDIDATE_SCAN_LIMIT = readEnvInt(
  "REINDEX_CANDIDATE_SCAN_LIMIT",
  200,
);

export class ReindexError extends Error {
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
    this.name = "ReindexError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ReindexChunk {
  readonly chunkId: string;
  readonly noteId: string;
  readonly noteVersion: number;
  readonly chunkIndex: number;
  readonly text: string;
}

export interface ReindexNoteBatch {
  readonly noteId: string;
  readonly noteVersion: number;
  readonly chunks: readonly ReindexChunk[];
}

export interface ReindexBatch {
  readonly preparedNotes: number;
  readonly candidateNotes: number;
  readonly candidateChunks: number;
  readonly totalCandidateChunks: number;
  readonly notes: readonly ReindexNoteBatch[];
  readonly chunks: readonly ReindexChunk[];
}

export interface ReindexEstimateOutcome {
  readonly status: "estimate";
  readonly model: string;
  readonly preparedNotes: number;
  readonly candidateNotes: number;
  readonly candidateChunks: number;
  readonly remainingChunks: number;
  readonly estimatedMaxCostUsd: number;
}

export interface ReindexSkippedOutcome {
  readonly status: "skipped";
  readonly model: string;
  readonly reason: "ready" | "no_content";
  readonly preparedNotes: number;
  readonly candidateNotes: 0;
  readonly candidateChunks: 0;
  readonly remainingChunks: 0;
  readonly estimatedMaxCostUsd: 0;
}

export interface ReindexCompletedOutcome {
  readonly status: "completed";
  readonly model: string;
  readonly preparedNotes: number;
  readonly candidateNotes: number;
  readonly candidateChunks: number;
  readonly readyChunks: number;
  readonly discardedChunks: number;
  readonly staleChunks: number;
  readonly staleNotes: number;
  readonly remainingChunks: number;
  readonly estimatedMaxCostUsd: number;
  readonly promptTokens: number | null;
}

export type ReindexOutcome =
  | ReindexEstimateOutcome
  | ReindexSkippedOutcome
  | ReindexCompletedOutcome;

export interface ApplyReindexResult {
  readonly readyChunks: number;
  readonly discardedChunks: number;
  readonly staleChunks: number;
  readonly staleNotes: number;
}

interface NoteRow {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly version: number;
  readonly content_md: string;
  readonly deleted_at: Date | null;
}

interface ChunkRow {
  readonly [key: string]: unknown;
  readonly chunk_id: string;
  readonly note_id: string;
  readonly note_version: number;
  readonly chunk_index: number;
  readonly text: string;
}

let reindexInFlight = false;

export function resetReindexInFlightForTests(): void {
  reindexInFlight = false;
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

function groupChunks(
  rows: readonly ChunkRow[],
): { readonly notes: readonly ReindexNoteBatch[]; readonly chunks: readonly ReindexChunk[] } {
  const groups = new Map<
    string,
    { noteVersion: number; chunks: ReindexChunk[] }
  >();

  for (const row of rows) {
    const chunk: ReindexChunk = {
      chunkId: row.chunk_id,
      noteId: row.note_id,
      noteVersion: row.note_version,
      chunkIndex: row.chunk_index,
      text: row.text,
    };
    const existing = groups.get(row.note_id);

    if (existing) {
      existing.chunks.push(chunk);
    } else {
      groups.set(row.note_id, {
        noteVersion: row.note_version,
        chunks: [chunk],
      });
    }
  }

  const notes: ReindexNoteBatch[] = [];
  const chunks: ReindexChunk[] = [];

  for (const [noteId, group] of groups) {
    notes.push({
      noteId,
      noteVersion: group.noteVersion,
      chunks: group.chunks,
    });
    chunks.push(...group.chunks);
  }

  return { notes, chunks };
}

async function prepareMissingChunks(
  db: AppDatabase,
  limit: number,
): Promise<number> {
  const missing = await db.transaction(async (tx) => {
    const candidates = await tx.execute<{
      readonly id: string;
      readonly version: number;
      readonly content_md: string;
    }>(sql`
      SELECT n.id, n.version, n.content_md
      FROM notes AS n
      WHERE n.deleted_at IS NULL
        AND btrim(n.content_plain) <> ''
        AND NOT EXISTS (
          SELECT 1
          FROM note_chunks AS c
          WHERE c.note_id = n.id AND c.note_version = n.version
        )
      ORDER BY n.id
      LIMIT ${limit}
    `);
    let prepared = 0;

    for (const candidate of candidates.rows) {
      const locked = await tx.execute<NoteRow>(sql`
        SELECT id, version, content_md, deleted_at
        FROM notes
        WHERE id = ${candidate.id}
        FOR UPDATE
      `);
      const note = locked.rows[0];

      if (
        !note ||
        note.deleted_at !== null ||
        note.version !== candidate.version ||
        note.content_md.trim() === ""
      ) {
        continue;
      }

      const existing = await tx.execute<{ readonly exists: number }>(sql`
        SELECT 1 AS exists
        FROM note_chunks
        WHERE note_id = ${note.id} AND note_version = ${note.version}
        LIMIT 1
      `);

      if (existing.rows.length > 0) {
        continue;
      }

      await refreshNoteChunks(tx, {
        id: note.id,
        contentMd: note.content_md,
        version: note.version,
      });
      prepared += 1;
    }

    return prepared;
  });

  return missing;
}

async function countIndexableNotes(db: AppDatabase): Promise<number> {
  const result = await db.execute<{ readonly count: number | string }>(sql`
    SELECT count(*)::int AS count
    FROM notes
    WHERE deleted_at IS NULL AND btrim(content_plain) <> ''
  `);

  return Number(result.rows[0]?.count ?? 0);
}

async function countCandidates(
  db: AppDatabase,
  modelId: string,
): Promise<{ readonly chunks: number; readonly notes: number }> {
  const result = await db.execute<{
    readonly chunks: number | string;
    readonly notes: number | string;
  }>(sql`
    SELECT
      count(*)::int AS chunks,
      count(DISTINCT c.note_id)::int AS notes
    FROM note_chunks AS c
    JOIN notes AS n ON n.id = c.note_id
    WHERE n.deleted_at IS NULL
      AND c.note_version = n.version
      AND btrim(n.content_plain) <> ''
      AND (c.status <> 'ready' OR c.model <> ${modelId})
  `);
  const row = result.rows[0];

  return {
    chunks: Number(row?.chunks ?? 0),
    notes: Number(row?.notes ?? 0),
  };
}

export async function selectReindexBatch(
  db: AppDatabase,
  modelId: string,
  preparedNotes: number,
): Promise<ReindexBatch> {
  const result = await db.execute<ChunkRow>(sql`
    SELECT
      c.id AS chunk_id,
      c.note_id,
      c.note_version,
      c.chunk_index,
      c.text
    FROM note_chunks AS c
    JOIN notes AS n ON n.id = c.note_id
    WHERE n.deleted_at IS NULL
      AND c.note_version = n.version
      AND btrim(n.content_plain) <> ''
      AND (c.status <> 'ready' OR c.model <> ${modelId})
    ORDER BY n.id, c.chunk_index
    LIMIT ${REINDEX_CANDIDATE_SCAN_LIMIT}
  `);

  const selectedRows: ChunkRow[] = [];
  const noteIds = new Set<string>();

  for (const row of result.rows) {
    if (selectedRows.length >= REINDEX_MAX_CHUNKS) {
      break;
    }

    if (!noteIds.has(row.note_id)) {
      if (noteIds.size >= REINDEX_MAX_NOTES) {
        break;
      }

      noteIds.add(row.note_id);
    }

    selectedRows.push(row);
  }

  const grouped = groupChunks(selectedRows);
  const total = await countCandidates(db, modelId);

  return {
    preparedNotes,
    candidateNotes: grouped.notes.length,
    candidateChunks: grouped.chunks.length,
    totalCandidateChunks: total.chunks,
    notes: grouped.notes,
    chunks: grouped.chunks,
  };
}

export async function prepareReindexBatch(
  db: AppDatabase,
  modelId: string,
): Promise<ReindexBatch> {
  const preparedNotes = await prepareMissingChunks(
    db,
    REINDEX_PREPARE_MAX_NOTES,
  );

  return selectReindexBatch(db, modelId, preparedNotes);
}

export async function markReindexChunksError(
  db: AppDatabase,
  chunkIds: readonly string[],
): Promise<void> {
  if (chunkIds.length === 0) {
    return;
  }

  await db
    .update(noteChunks)
    .set({ status: "error" })
    .where(inArray(noteChunks.id, [...chunkIds]));
}

export async function applyReindexEmbeddings(
  db: AppDatabase,
  batch: ReindexBatch,
  vectors: readonly (readonly number[])[],
  modelId: string,
): Promise<ApplyReindexResult> {
  if (vectors.length !== batch.chunks.length) {
    throw new EmbeddingError(
      502,
      "embedding_invalid_provider_response",
      "Počet vektorů neodpovídá počtu textů. Indexování bylo zablokováno.",
      {
        expectedCount: batch.chunks.length,
        returnedCount: vectors.length,
      },
    );
  }

  if (batch.notes.length === 0) {
    return {
      readyChunks: 0,
      discardedChunks: 0,
      staleChunks: 0,
      staleNotes: 0,
    };
  }

  const noteIds = [...new Set(batch.notes.map((note) => note.noteId))].sort();

  return db.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(notes)
      .where(inArray(notes.id, noteIds))
      .orderBy(notes.id)
      .for("update");
    const current = new Map(locked.map((row) => [row.id, row]));
    let readyChunks = 0;
    let discardedChunks = 0;
    let staleChunks = 0;
    let staleNotes = 0;
    let vectorOffset = 0;

    for (const note of batch.notes) {
      const noteRow = current.get(note.noteId);
      const noteStale =
        !noteRow ||
        noteRow.deletedAt !== null ||
        noteRow.version !== note.noteVersion;
      const noteVectorOffset = vectorOffset;

      vectorOffset += note.chunks.length;

      if (noteStale) {
        staleNotes += 1;
        staleChunks += note.chunks.length;
        await tx
          .update(noteChunks)
          .set({ status: "error" })
          .where(
            inArray(
              noteChunks.id,
              note.chunks.map((chunk) => chunk.chunkId),
            ),
          );
        continue;
      }

      for (const [index, chunk] of note.chunks.entries()) {
        const vector = vectors[noteVectorOffset + index];

        if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
          throw new EmbeddingError(
            502,
            "embedding_dimension_mismatch",
            "Vektor neodpovídá dimenzi indexu. Indexování bylo zablokováno.",
          );
        }

        const updated = await tx
          .update(noteChunks)
          .set({
            status: "ready",
            model: modelId,
            embedding: sql`${vectorLiteral(vector)}::vector`,
          })
          .where(
            and(
              eq(noteChunks.id, chunk.chunkId),
              eq(noteChunks.noteId, note.noteId),
              eq(noteChunks.noteVersion, note.noteVersion),
              eq(noteChunks.text, chunk.text),
            ),
          )
          .returning({ id: noteChunks.id });

        if (updated.length === 0) {
          discardedChunks += 1;
        } else {
          readyChunks += 1;
        }
      }
    }

    return {
      readyChunks,
      discardedChunks,
      staleChunks,
      staleNotes,
    };
  });
}

export interface RunReindexOptions {
  readonly db: AppDatabase;
  readonly embedder: EmbeddingService;
  readonly modelId: string;
  readonly confirmCost: boolean;
  readonly approvedMaxCostUsd?: number;
}

export async function runReindex(
  options: RunReindexOptions,
): Promise<ReindexOutcome> {
  if (!options.confirmCost) {
    const batch = await prepareReindexBatch(options.db, options.modelId);

    if (batch.candidateChunks === 0) {
      return {
        status: "skipped",
        model: options.modelId,
        reason:
          (await countIndexableNotes(options.db)) === 0
            ? "no_content"
            : "ready",
        preparedNotes: batch.preparedNotes,
        candidateNotes: 0,
        candidateChunks: 0,
        remainingChunks: 0,
        estimatedMaxCostUsd: 0,
      };
    }

    return {
      status: "estimate",
      model: options.modelId,
      preparedNotes: batch.preparedNotes,
      candidateNotes: batch.candidateNotes,
      candidateChunks: batch.candidateChunks,
      remainingChunks: Math.max(
        0,
        batch.totalCandidateChunks - batch.candidateChunks,
      ),
      estimatedMaxCostUsd: estimateEmbeddingMaxCostUsd(
        batch.chunks.map((chunk) => chunk.text),
      ),
    };
  }

  if (reindexInFlight) {
    throw new ReindexError(
      409,
      "reindex_in_progress",
      "Indexování už probíhá. Počkejte na dokončení.",
    );
  }

  reindexInFlight = true;

  try {
    const batch = await prepareReindexBatch(options.db, options.modelId);

    if (batch.candidateChunks === 0) {
      return {
        status: "skipped",
        model: options.modelId,
        reason:
          (await countIndexableNotes(options.db)) === 0
            ? "no_content"
            : "ready",
        preparedNotes: batch.preparedNotes,
        candidateNotes: 0,
        candidateChunks: 0,
        remainingChunks: 0,
        estimatedMaxCostUsd: 0,
      };
    }

    const estimatedMaxCostUsd = estimateEmbeddingMaxCostUsd(
      batch.chunks.map((chunk) => chunk.text),
    );
    const approved = options.approvedMaxCostUsd;

    if (
      approved === undefined ||
      !Number.isFinite(approved) ||
      approved < 0
    ) {
      throw new ReindexError(
        400,
        "reindex_cost_not_approved",
        "Reindexace vyžaduje potvrzení odhadované ceny.",
      );
    }

    if (estimatedMaxCostUsd > approved + 1e-9) {
      throw new ReindexError(
        409,
        "reindex_cost_changed",
        "Rozsah indexace se mezitím změnil. Zjistěte nový odhad a potvrďte jej.",
        { approvedMaxCostUsd: approved, estimatedMaxCostUsd },
      );
    }

    let result;

    try {
      result = await options.embedder.embed(
        batch.chunks.map((chunk) => chunk.text),
      );
    } catch (error) {
      try {
        await markReindexChunksError(
          options.db,
          batch.chunks.map((chunk) => chunk.chunkId),
        );
      } catch {
        throw new ReindexError(
          500,
          "reindex_error_state_failed",
          "Embedding se nepodařilo vytvořit a chunky se ani nepodařilo označit jako chybné. Zkontrolujte databázi a zkuste to znovu.",
          { chunkCount: batch.chunks.length, errorStatePersisted: false },
        );
      }

      throw error;
    }

    let applied;

    try {
      applied = await applyReindexEmbeddings(
        options.db,
        batch,
        result.vectors,
        options.modelId,
      );
    } catch (error) {
      try {
        await markReindexChunksError(
          options.db,
          batch.chunks.map((chunk) => chunk.chunkId),
        );
      } catch {
        throw new ReindexError(
          500,
          "reindex_apply_failed",
          "Vektory se nepodařilo uložit a ani označit chunky jako chybné. Zkontrolujte databázi a zkuste to znovu.",
          { chunkCount: batch.chunks.length, errorStatePersisted: false },
        );
      }

      throw error;
    }

    const remaining = await countCandidates(options.db, options.modelId);

    return {
      status: "completed",
      model: options.modelId,
      preparedNotes: batch.preparedNotes,
      candidateNotes: batch.candidateNotes,
      candidateChunks: batch.candidateChunks,
      readyChunks: applied.readyChunks,
      discardedChunks: applied.discardedChunks,
      staleChunks: applied.staleChunks,
      staleNotes: applied.staleNotes,
      remainingChunks: remaining.chunks,
      estimatedMaxCostUsd,
      promptTokens: result.promptTokens,
    };
  } finally {
    reindexInFlight = false;
  }
}

export interface ReindexStatusSummary {
  readonly notes: {
    readonly total: number;
    readonly ready: number;
    readonly pending: number;
    readonly error: number;
    readonly noContent: number;
  };
  readonly chunks: {
    readonly current: number;
    readonly ready: number;
    readonly pending: number;
    readonly error: number;
  };
}

export async function getReindexStatus(
  db: AppDatabase,
  modelId: string,
): Promise<ReindexStatusSummary> {
  const notes = await db.execute<{
    readonly total: number | string;
    readonly ready: number | string;
    readonly pending: number | string;
    readonly error: number | string;
    readonly no_content: number | string;
  }>(sql`
    WITH current AS (
      SELECT
        n.id,
        (n.content_plain IS NULL OR btrim(n.content_plain) = '') AS no_content,
        count(c.id) FILTER (WHERE c.note_version = n.version) AS current_count,
        count(c.id) FILTER (
          WHERE c.note_version = n.version
            AND c.status = 'ready'
            AND c.model = ${modelId}
        ) AS ready_count,
        count(c.id) FILTER (
          WHERE c.note_version = n.version AND c.status = 'error'
        ) AS error_count
      FROM notes AS n
      LEFT JOIN note_chunks AS c ON c.note_id = n.id
      WHERE n.deleted_at IS NULL
      GROUP BY n.id
    )
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE no_content)::int AS no_content,
      count(*) FILTER (
        WHERE NOT no_content
          AND error_count = 0
          AND (current_count = 0 OR ready_count < current_count)
      )::int AS pending,
      count(*) FILTER (
        WHERE NOT no_content AND current_count > 0 AND error_count > 0
      )::int AS error,
      count(*) FILTER (
        WHERE NOT no_content
          AND current_count > 0
          AND error_count = 0
          AND ready_count = current_count
      )::int AS ready
    FROM current
  `);
  const chunks = await db.execute<{
    readonly current: number | string;
    readonly ready: number | string;
    readonly pending: number | string;
    readonly error: number | string;
  }>(sql`
    SELECT
      count(*)::int AS current,
      count(*) FILTER (WHERE c.status = 'ready' AND c.model = ${modelId})::int AS ready,
      count(*) FILTER (WHERE c.status = 'pending')::int AS pending,
      count(*) FILTER (WHERE c.status = 'error')::int AS error
    FROM note_chunks AS c
    JOIN notes AS n ON n.id = c.note_id
    WHERE n.deleted_at IS NULL
      AND c.note_version = n.version
  `);
  const noteRow = notes.rows[0];
  const chunkRow = chunks.rows[0];

  return {
    notes: {
      total: Number(noteRow?.total ?? 0),
      ready: Number(noteRow?.ready ?? 0),
      pending: Number(noteRow?.pending ?? 0),
      error: Number(noteRow?.error ?? 0),
      noContent: Number(noteRow?.no_content ?? 0),
    },
    chunks: {
      current: Number(chunkRow?.current ?? 0),
      ready: Number(chunkRow?.ready ?? 0),
      pending: Number(chunkRow?.pending ?? 0),
      error: Number(chunkRow?.error ?? 0),
    },
  };
}
