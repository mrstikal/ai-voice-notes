import { sql } from "drizzle-orm";

import type { NotesExecutor } from "../notes/repository.ts";

const SEARCH_VECTOR_EXPRESSION = sql`
  CASE
    WHEN notes.deleted_at IS NULL THEN
      setweight(to_tsvector('simple', unaccent(coalesce(notes.title, ''))), 'A') ||
      setweight(to_tsvector('simple', unaccent(coalesce(notes.content_plain, ''))), 'B') ||
      setweight(to_tsvector('simple', unaccent(coalesce((
        SELECT string_agg(note_tags.tag, ' ' ORDER BY note_tags.tag)
        FROM note_tags
        WHERE note_tags.note_id = notes.id
      ), ''))), 'C')
    ELSE NULL
  END
`;

export async function refreshNoteSearch(
  db: NotesExecutor,
  noteId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE notes
    SET search_vector = ${SEARCH_VECTOR_EXPRESSION}
    WHERE id = ${noteId}
  `);
}
