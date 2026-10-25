import type { NoteDetail, NoteSummary } from "./client.ts";
import type { NoteDetailDto, NoteSummaryDto } from "./service.ts";

export function toClientSummary(note: NoteSummaryDto): NoteSummary {
  return {
    id: note.id,
    title: note.title,
    category: note.category,
    version: note.version,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
    deletedAt: note.deletedAt ? note.deletedAt.toISOString() : null,
  };
}

export function toClientDetail(note: NoteDetailDto): NoteDetail {
  return {
    ...toClientSummary(note),
    contentMd: note.contentMd,
    contentPlain: note.contentPlain,
    tags: note.tags,
  };
}
