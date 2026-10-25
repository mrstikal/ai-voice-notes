import type { ExtractTablesWithRelations } from "drizzle-orm";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";

import {
  noteRevisions,
  noteTags,
  notes,
  type NoteSnapshot,
} from "../db/schema.ts";
import type * as schema from "../db/schema.ts";

export type NotesExecutor = PgDatabase<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export type NoteRow = typeof notes.$inferSelect;

export async function findNoteById(
  db: NotesExecutor,
  id: string,
): Promise<NoteRow | undefined> {
  const rows = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
  return rows[0];
}

export async function findNoteByIdForUpdate(
  db: NotesExecutor,
  id: string,
): Promise<NoteRow | undefined> {
  const rows = await db
    .select()
    .from(notes)
    .where(eq(notes.id, id))
    .limit(1)
    .for("update");

  return rows[0];
}

export async function listActiveNotesPage(
  db: NotesExecutor,
  options: { limit: number; offset: number },
): Promise<NoteRow[]> {
  return db
    .select()
    .from(notes)
    .where(isNull(notes.deletedAt))
    .orderBy(desc(notes.createdAt), desc(notes.id))
    .limit(options.limit)
    .offset(options.offset);
}

export async function insertNote(
  db: NotesExecutor,
  values: {
    title: string;
    contentMd: string;
    contentPlain: string;
  },
): Promise<NoteRow> {
  const rows = await db.insert(notes).values(values).returning();
  const row = rows[0];

  if (!row) {
    throw new Error("Poznámku se nepodařilo vložit.");
  }

  return row;
}

export async function updateNoteCas(
  db: NotesExecutor,
  input: {
    id: string;
    expectedVersion: number;
    title: string;
    contentMd: string;
    contentPlain: string;
  },
): Promise<NoteRow | undefined> {
  const rows = await db
    .update(notes)
    .set({
      title: input.title,
      contentMd: input.contentMd,
      contentPlain: input.contentPlain,
      version: sql`${notes.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(notes.id, input.id),
        eq(notes.version, input.expectedVersion),
        isNull(notes.deletedAt),
      ),
    )
    .returning();

  return rows[0];
}

export async function softDeleteNoteCas(
  db: NotesExecutor,
  id: string,
  expectedVersion: number,
): Promise<NoteRow | undefined> {
  const rows = await db
    .update(notes)
    .set({
      version: sql`${notes.version} + 1`,
      updatedAt: sql`now()`,
      deletedAt: sql`now()`,
    })
    .where(
      and(
        eq(notes.id, id),
        eq(notes.version, expectedVersion),
        isNull(notes.deletedAt),
      ),
    )
    .returning();

  return rows[0];
}

export async function restoreNoteCas(
  db: NotesExecutor,
  id: string,
  expectedVersion: number,
): Promise<NoteRow | undefined> {
  const rows = await db
    .update(notes)
    .set({
      version: sql`${notes.version} + 1`,
      updatedAt: sql`now()`,
      deletedAt: null,
    })
    .where(
      and(
        eq(notes.id, id),
        eq(notes.version, expectedVersion),
        isNotNull(notes.deletedAt),
      ),
    )
    .returning();

  return rows[0];
}

export async function insertRevision(
  db: NotesExecutor,
  values: {
    noteId: string;
    noteVersion: number;
    reason: string;
    beforeSnapshot: NoteSnapshot;
    afterSnapshot: NoteSnapshot;
  },
): Promise<void> {
  await db.insert(noteRevisions).values(values);
}

export async function getNoteTags(
  db: NotesExecutor,
  noteId: string,
): Promise<string[]> {
  const rows = await db
    .select({ tag: noteTags.tag })
    .from(noteTags)
    .where(eq(noteTags.noteId, noteId))
    .orderBy(asc(noteTags.tag));

  return rows.map((row) => row.tag);
}
