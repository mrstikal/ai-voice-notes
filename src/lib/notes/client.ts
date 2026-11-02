export interface NoteSummary {
  readonly id: string;
  readonly title: string;
  readonly category: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface NoteDetail extends NoteSummary {
  readonly contentMd: string;
  readonly contentPlain: string;
  readonly tags: string[];
}

export interface NotePage {
  readonly items: NoteSummary[];
  readonly page: number;
  readonly pageSize: number;
  readonly hasNext: boolean;
}

export class NoteApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly latestVersion: number | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    latestVersion?: number,
  ) {
    super(message);
    this.name = "NoteApiError";
    this.status = status;
    this.code = code;
    this.latestVersion = latestVersion;
  }
}

interface ApiErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly latestVersion?: number;
  };
}

async function readApiError(response: Response): Promise<NoteApiError> {
  let body: ApiErrorBody | null = null;

  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = null;
  }

  return new NoteApiError(
    response.status,
    body?.error?.code ?? "request_failed",
    body?.error?.message ?? "Požadavek se nepodařilo dokončit.",
    body?.error?.latestVersion,
  );
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
    },
  });

  if (!response.ok) {
    throw await readApiError(response);
  }

  return (await response.json()) as T;
}

export async function createNote(input: {
  title: string;
  contentMd: string;
}): Promise<NoteDetail> {
  return requestJson<NoteDetail>("/api/notes", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchNote(id: string): Promise<NoteDetail> {
  return requestJson<NoteDetail>(`/api/notes/${id}`, {
    method: "GET",
  });
}

export async function updateNote(
  id: string,
  input: {
    title: string;
    contentMd: string;
    expectedVersion: number;
    draft?: boolean;
  },
): Promise<NoteDetail> {
  return requestJson<NoteDetail>(`/api/notes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function saveVoiceContent(
  id: string,
  input: {
    baselineContentMd: string;
    contentMd: string;
    expectedVersion: number;
  },
): Promise<NoteDetail> {
  return requestJson<NoteDetail>(`/api/notes/${id}/voice-content`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function updateNoteMetadata(
  id: string,
  input: {
    category: string | null;
    tags: string[];
    expectedVersion: number;
  },
): Promise<NoteDetail> {
  return requestJson<NoteDetail>(`/api/notes/${id}/tags`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function updateVoiceTitle(
  id: string,
  input: {
    title: string;
    expectedVersion: number;
  },
): Promise<NoteDetail> {
  return requestJson<NoteDetail>(`/api/notes/${id}/title`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteNote(
  id: string,
  expectedVersion: number,
): Promise<NoteDetail> {
  return requestJson<NoteDetail>(`/api/notes/${id}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedVersion }),
  });
}

export async function restoreNote(
  id: string,
  expectedVersion: number,
): Promise<NoteDetail> {
  return requestJson<NoteDetail>(`/api/notes/${id}/restore`, {
    method: "POST",
    body: JSON.stringify({ expectedVersion }),
  });
}

export interface EmptyTrashResult {
  readonly purgedCount: number;
}

export async function emptyTrash(): Promise<EmptyTrashResult> {
  return requestJson<EmptyTrashResult>("/api/notes/trash", {
    method: "DELETE",
    body: JSON.stringify({}),
  });
}

const czechDateTimeFormatter = new Intl.DateTimeFormat("cs-CZ", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Prague",
});

export function formatCzechDateTime(value: string): string {
  return czechDateTimeFormatter.format(new Date(value));
}
