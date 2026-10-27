import type { NoteDetail } from "./client";
import { NoteApiError } from "./client";

export type RevisionReason =
  | "initial"
  | "manual"
  | "voice"
  | "ai"
  | "undo"
  | "restore"
  | "metadata";

export interface RevisionSnapshot {
  readonly title: string;
  readonly contentMd: string;
  readonly category: string | null;
  readonly tags: readonly string[];
}

export interface RevisionDiff {
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
  readonly removed: string;
  readonly inserted: string;
  readonly suffix: string;
}

export interface NoteRevision {
  readonly id: string;
  readonly noteVersion: number;
  readonly reason: RevisionReason;
  readonly createdAt: string;
  readonly beforeSnapshot: RevisionSnapshot;
  readonly afterSnapshot: RevisionSnapshot;
  readonly diff: RevisionDiff;
}

export interface RevisionHistory {
  readonly currentVersion: number;
  readonly currentSnapshot: RevisionSnapshot;
  readonly revisions: readonly NoteRevision[];
  readonly undoRevisionId: string | null;
  readonly canUndo: boolean;
}

export interface RestoreRevisionRequest {
  readonly mode: "undo" | "restore";
  readonly expectedVersion: number;
}

interface ApiErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly latestVersion?: number;
  };
}

async function readError(response: Response): Promise<NoteApiError> {
  let body: ApiErrorBody | null = null;

  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = null;
  }

  return new NoteApiError(
    response.status,
    body?.error?.code ?? "request_failed",
    body?.error?.message ??
      "Požadavek na historii poznámky se nepodařilo dokončit.",
    body?.error?.latestVersion,
  );
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json" },
  });

  if (!response.ok) {
    throw await readError(response);
  }

  return (await response.json()) as T;
}

export async function fetchRevisions(
  noteId: string,
): Promise<RevisionHistory> {
  return requestJson<RevisionHistory>(
    `/api/notes/${noteId}/revisions`,
    { method: "GET" },
  );
}

export async function restoreRevision(
  noteId: string,
  revisionId: string,
  input: RestoreRevisionRequest,
): Promise<NoteDetail> {
  return requestJson<NoteDetail>(
    `/api/notes/${noteId}/revisions/${revisionId}/restore`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function computeRevisionDiff(
  beforeMd: string,
  afterMd: string,
): RevisionDiff {
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

export function snapshotsEqual(
  left: RevisionSnapshot,
  right: RevisionSnapshot,
): boolean {
  return (
    left.title === right.title &&
    left.contentMd === right.contentMd &&
    left.category === right.category &&
    left.tags.length === right.tags.length &&
    left.tags.every((tag, index) => tag === right.tags[index])
  );
}

export function changedSnapshotFields(
  current: RevisionSnapshot,
  target: RevisionSnapshot,
): string[] {
  const fields: string[] = [];

  if (current.title !== target.title) {
    fields.push(`Titulek: „${current.title}“ → „${target.title}“`);
  }

  if (current.category !== target.category) {
    fields.push(
      `Kategorie: ${current.category ?? "—"} → ${target.category ?? "—"}`,
    );
  }

  if (
    current.tags.length !== target.tags.length ||
    current.tags.some((tag, index) => tag !== target.tags[index])
  ) {
    fields.push(
      `Štítky: ${current.tags.join(", ") || "—"} → ${target.tags.join(", ") || "—"}`,
    );
  }

  return fields;
}
