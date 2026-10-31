import { and, eq, sql } from "drizzle-orm";

import { noteChunks } from "../db/schema.ts";
import type { NotesExecutor } from "../notes/repository.ts";
import {
  PENDING_CHUNK_MODEL,
  chunkNoteMarkdown,
} from "./chunking.ts";

export type IndexStatus = "pending" | "ready" | "error" | "no_content";

export const INDEX_STATUS_LABELS: Record<IndexStatus, string> = {
  pending: "Čeká",
  ready: "Připraven",
  error: "Chyba",
  no_content: "Bez textu",
};

export interface RefreshNoteChunksOptions {
  /**
   * Metadata and title edits keep the body text unchanged, so ready embeddings
   * from the previous version stay valid for chunks with identical text.
   */
  readonly reuseReadyEmbeddingsFromVersion?: number;
}

export async function refreshNoteChunks(
  db: NotesExecutor,
  note: { readonly id: string; readonly contentMd: string; readonly version: number },
  options: RefreshNoteChunksOptions = {},
): Promise<void> {
  const chunks = chunkNoteMarkdown(note.contentMd);

  await db
    .delete(noteChunks)
    .where(
      and(
        eq(noteChunks.noteId, note.id),
        eq(noteChunks.noteVersion, note.version),
      ),
    );

  if (chunks.length === 0) {
    return;
  }

  await db.insert(noteChunks).values(
    chunks.map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      model: PENDING_CHUNK_MODEL,
      noteId: note.id,
      noteVersion: note.version,
      status: "pending" as const,
      text: chunk.text,
    })),
  );

  const reuseFrom = options.reuseReadyEmbeddingsFromVersion;

  if (reuseFrom !== undefined && reuseFrom !== note.version) {
    await db.execute(sql`
      UPDATE note_chunks AS current
      SET status = 'ready', model = previous.model, embedding = previous.embedding
      FROM note_chunks AS previous
      WHERE current.note_id = ${note.id}
        AND current.note_version = ${note.version}
        AND current.status = 'pending'
        AND previous.note_id = ${note.id}
        AND previous.note_version = ${reuseFrom}
        AND previous.status = 'ready'
        AND previous.embedding IS NOT NULL
        AND previous.chunk_index = current.chunk_index
        AND previous.text = current.text
    `);
  }
}

export async function getNoteIndexStatus(
  db: NotesExecutor,
  noteId: string,
): Promise<IndexStatus> {
  const result = await db.execute(sql`
    SELECT
      n.content_plain,
      n.version,
      count(c.id) FILTER (WHERE c.note_version = n.version) AS current_count,
      count(c.id) FILTER (WHERE c.note_version = n.version AND c.status = 'ready') AS ready_count,
      count(c.id) FILTER (WHERE c.note_version = n.version AND c.status = 'error') AS error_count
    FROM notes AS n
    LEFT JOIN note_chunks AS c ON c.note_id = n.id
    WHERE n.id = ${noteId}
    GROUP BY n.id
  `);
  const row = result.rows[0] as
    | {
        content_plain: string;
        current_count: number | string;
        error_count: number | string;
        ready_count: number | string;
      }
    | undefined;

  if (!row) {
    return "pending";
  }

  if (row.content_plain.trim() === "") {
    return "no_content";
  }

  const current = Number(row.current_count);

  if (current === 0) {
    return "pending";
  }

  if (Number(row.error_count) > 0) {
    return "error";
  }

  return Number(row.ready_count) === current ? "ready" : "pending";
}

export async function getIndexStatuses(
  db: NotesExecutor,
  noteIds: readonly string[],
): Promise<ReadonlyMap<string, IndexStatus>> {
  const entries = await Promise.all(
    noteIds.map(async (noteId) => [noteId, await getNoteIndexStatus(db, noteId)] as const),
  );

  return new Map(entries);
}
