import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as listNotes, POST as createNote } from "@/app/api/notes/route";
import {
  DELETE as deleteNote,
  GET as getNote,
  PATCH as updateNote,
} from "@/app/api/notes/[id]/route";
import { POST as restoreNote } from "@/app/api/notes/[id]/restore/route";
import {
  NoteConflictError,
  NoteNotFoundError,
  NoteTooLargeError,
  NoteValidationError,
  type NoteDetailDto,
} from "@/lib/notes/service";

const service = vi.hoisted(() => ({
  listActiveNotes: vi.fn(),
  getNote: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
  restoreNote: vi.fn(),
}));

vi.mock("@/lib/notes/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notes/service")>();
  return {
    ...actual,
    getNoteService: () => service,
  };
});

const APP_ORIGIN = "http://127.0.0.1:3000";
const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID_2 = "22222222-2222-4222-8222-222222222222";

function noteDetail(overrides: Partial<NoteDetailDto> = {}): NoteDetailDto {
  return {
    id: NOTE_ID,
    title: "Česká poznámka",
    contentMd: "**Ahoj**",
    contentPlain: "Ahoj",
    category: null,
    tags: [],
    version: 1,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

function noteSummary(overrides: Partial<NoteDetailDto> = {}) {
  const detail = noteDetail(overrides);
  return {
    id: detail.id,
    title: detail.title,
    category: detail.category,
    version: detail.version,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    deletedAt: detail.deletedAt,
  };
}

function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string | null>;
  } = {},
): Request {
  const headers = new Headers({
    host: "127.0.0.1:3000",
    origin: APP_ORIGIN,
  });

  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) {
      headers.delete(name);
    } else {
      headers.set(name, value);
    }
  }

  return new Request(`${APP_ORIGIN}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function context(id = NOTE_ID) {
  return { params: Promise.resolve({ id }) };
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

describe("notes API", () => {
  beforeAll(() => {
    vi.stubEnv("APP_ORIGIN", APP_ORIGIN);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("lists active notes page 1 by default and page 2 when requested", async () => {
    service.listActiveNotes.mockResolvedValue({
      items: [noteSummary()],
      page: 1,
      pageSize: 10,
      hasNext: false,
    });

    const first = await listNotes(request("/api/notes"));
    expect(first.status).toBe(200);
    expect(service.listActiveNotes).toHaveBeenCalledWith(1);
    expect(await first.json()).toMatchObject({
      page: 1,
      pageSize: 10,
      hasNext: false,
      items: [{ id: NOTE_ID, title: "Česká poznámka" }],
    });

    service.listActiveNotes.mockResolvedValue({
      items: [noteSummary({ id: NOTE_ID_2, title: "Druhá" })],
      page: 2,
      pageSize: 10,
      hasNext: false,
    });

    const second = await listNotes(request("/api/notes?page=2"));
    expect(second.status).toBe(200);
    expect(service.listActiveNotes).toHaveBeenCalledWith(2);
    expect(await second.json()).toMatchObject({ page: 2 });
  });

  it("rejects invalid page numbers before calling the service", async () => {
    for (const page of ["0", "-1", "1.5", "abc", "", "1e2", "0x10", "+2", "2.0"]) {
      const response = await listNotes(
        request(`/api/notes?page=${encodeURIComponent(page)}`),
      );
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("invalid_page");
    }

    expect(service.listActiveNotes).not.toHaveBeenCalled();
  });

  it("guards list reads by Host", async () => {
    const response = await listNotes(
      request("/api/notes", { headers: { host: "evil.example" } }),
    );

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("invalid_host");
    expect(service.listActiveNotes).not.toHaveBeenCalled();
  });

  it("creates a Czech note and returns 201", async () => {
    service.createNote.mockResolvedValue(
      noteDetail({ title: "Česká poznámka", contentMd: "**Ahoj**" }),
    );

    const response = await createNote(
      request("/api/notes", {
        method: "POST",
        body: { title: "Česká poznámka", contentMd: "**Ahoj**" },
      }),
    );

    expect(response.status).toBe(201);
    expect(service.createNote).toHaveBeenCalledWith({
      title: "Česká poznámka",
      contentMd: "**Ahoj**",
    });
    expect(await response.json()).toMatchObject({
      title: "Česká poznámka",
      contentPlain: "Ahoj",
    });
  });

  it("rejects client-supplied derived or protected fields", async () => {
    for (const extra of [
      { content_plain: "podvržené" },
      { contentPlain: "podvržené" },
      { seed_key: "seed" },
      { createdAt: "2020-01-01T00:00:00.000Z" },
      { revisionReason: "manual" },
    ]) {
      const response = await createNote(
        request("/api/notes", {
          method: "POST",
          body: { title: "Test", contentMd: "Text", ...extra },
        }),
      );

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("invalid_shape");
    }

    expect(service.createNote).not.toHaveBeenCalled();
  });

  it("rejects missing Origin and wrong content type before calling the service", async () => {
    const missingOrigin = await createNote(
      request("/api/notes", {
        method: "POST",
        body: { title: "Test", contentMd: "Text" },
        headers: { origin: null },
      }),
    );
    expect(missingOrigin.status).toBe(403);
    expect(await errorCode(missingOrigin)).toBe("invalid_origin");

    const wrongContentType = await createNote(
      request("/api/notes", {
        method: "POST",
        body: { title: "Test", contentMd: "Text" },
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(wrongContentType.status).toBe(415);
    expect(await errorCode(wrongContentType)).toBe("invalid_content_type");

    expect(service.createNote).not.toHaveBeenCalled();
  });

  it("rejects a body over the 1 MiB ceiling before calling the service", async () => {
    const response = await createNote(
      request("/api/notes", {
        method: "POST",
        body: { title: "Velká", contentMd: "a".repeat(1_048_576) },
      }),
    );

    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe("payload_too_large");
    expect(service.createNote).not.toHaveBeenCalled();
  });

  it("maps note limit and size errors to Czech API responses", async () => {
    service.createNote.mockRejectedValue(
      new NoteValidationError("Poznámka může mít nejvýše 20000 viditelných znaků."),
    );
    const tooManyGraphemes = await createNote(
      request("/api/notes", {
        method: "POST",
        body: { title: "Dlouhá", contentMd: "😀".repeat(20_001) },
      }),
    );
    expect(tooManyGraphemes.status).toBe(400);
    expect(await errorCode(tooManyGraphemes)).toBe("invalid_note");

    service.createNote.mockRejectedValue(new NoteTooLargeError());
    const tooLarge = await createNote(
      request("/api/notes", {
        method: "POST",
        body: { title: "Velká", contentMd: "Text" },
      }),
    );
    expect(tooLarge.status).toBe(413);
    expect(await errorCode(tooLarge)).toBe("payload_too_large");
  });

  it("accepts a 20,000-grapheme emoji note below 1 MiB", async () => {
    const contentMd = "😀".repeat(20_000);
    service.createNote.mockResolvedValue(noteDetail({ contentMd }));

    const response = await createNote(
      request("/api/notes", {
        method: "POST",
        body: { title: "Emoji", contentMd },
      }),
    );

    expect(response.status).toBe(201);
    expect(service.createNote).toHaveBeenCalledWith({
      title: "Emoji",
      contentMd,
    });
  });

  it("reads one note by UUID and rejects invalid or missing IDs", async () => {
    service.getNote.mockResolvedValue(noteDetail());

    const found = await getNote(
      request(`/api/notes/${NOTE_ID}`),
      context(),
    );
    expect(found.status).toBe(200);
    expect(service.getNote).toHaveBeenCalledWith(NOTE_ID);

    const invalid = await getNote(
      request("/api/notes/not-a-uuid"),
      context("not-a-uuid"),
    );
    expect(invalid.status).toBe(400);
    expect(await errorCode(invalid)).toBe("invalid_id");

    service.getNote.mockRejectedValue(new NoteNotFoundError());
    const missing = await getNote(
      request(`/api/notes/${NOTE_ID}`),
      context(),
    );
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe("note_not_found");
  });

  it("updates with expectedVersion and maps stale versions to 409", async () => {
    service.updateNote.mockResolvedValue(noteDetail({ version: 2, title: "Nový" }));

    const response = await updateNote(
      request(`/api/notes/${NOTE_ID}`, {
        method: "PATCH",
        body: { title: "Nový", contentMd: "**Nový**", expectedVersion: 1 },
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(service.updateNote).toHaveBeenCalledWith(NOTE_ID, {
      title: "Nový",
      contentMd: "**Nový**",
      expectedVersion: 1,
    });

    service.updateNote.mockRejectedValue(new NoteConflictError(2));
    const stale = await updateNote(
      request(`/api/notes/${NOTE_ID}`, {
        method: "PATCH",
        body: { title: "Stale", contentMd: "Stale", expectedVersion: 1 },
      }),
      context(),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "version_conflict", latestVersion: 2 },
    });
  });

  it("passes an explicit draft flag to the service", async () => {
    service.updateNote.mockResolvedValue(noteDetail({ version: 2, title: "Draft" }));

    const response = await updateNote(
      request(`/api/notes/${NOTE_ID}`, {
        method: "PATCH",
        body: {
          title: "Draft",
          contentMd: "Draft",
          expectedVersion: 1,
          draft: true,
        },
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(service.updateNote).toHaveBeenCalledWith(NOTE_ID, {
      title: "Draft",
      contentMd: "Draft",
      expectedVersion: 1,
      draft: true,
    });
  });

  it("rejects PATCH without expectedVersion and invalid UUIDs before calling the service", async () => {
    const missingVersion = await updateNote(
      request(`/api/notes/${NOTE_ID}`, {
        method: "PATCH",
        body: { title: "Nový", contentMd: "Nový" },
      }),
      context(),
    );
    expect(missingVersion.status).toBe(400);
    expect(await errorCode(missingVersion)).toBe("invalid_shape");

    const invalidId = await updateNote(
      request("/api/notes/not-a-uuid", {
        method: "PATCH",
        body: { title: "Nový", contentMd: "Nový", expectedVersion: 1 },
      }),
      context("not-a-uuid"),
    );
    expect(invalidId.status).toBe(400);
    expect(await errorCode(invalidId)).toBe("invalid_id");

    expect(service.updateNote).not.toHaveBeenCalled();
  });

  it("soft-deletes with expectedVersion and returns the deleted note", async () => {
    service.deleteNote.mockResolvedValue(
      noteDetail({ version: 2, deletedAt: new Date("2026-01-02T00:00:00.000Z") }),
    );

    const response = await deleteNote(
      request(`/api/notes/${NOTE_ID}`, {
        method: "DELETE",
        body: { expectedVersion: 1 },
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(service.deleteNote).toHaveBeenCalledWith(NOTE_ID, 1);
    expect(await response.json()).toMatchObject({
      version: 2,
      deletedAt: "2026-01-02T00:00:00.000Z",
    });

    service.deleteNote.mockRejectedValue(new NoteConflictError(2));
    const stale = await deleteNote(
      request(`/api/notes/${NOTE_ID}`, {
        method: "DELETE",
        body: { expectedVersion: 1 },
      }),
      context(),
    );
    expect(stale.status).toBe(409);
  });

  it("restores a trashed note and maps missing/stale errors", async () => {
    service.restoreNote.mockResolvedValue(noteDetail({ version: 3 }));

    const response = await restoreNote(
      request(`/api/notes/${NOTE_ID}/restore`, {
        method: "POST",
        body: { expectedVersion: 2 },
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(service.restoreNote).toHaveBeenCalledWith(NOTE_ID, 2);

    service.restoreNote.mockRejectedValue(new NoteNotFoundError());
    const missing = await restoreNote(
      request(`/api/notes/${NOTE_ID}/restore`, {
        method: "POST",
        body: { expectedVersion: 2 },
      }),
      context(),
    );
    expect(missing.status).toBe(404);

    service.restoreNote.mockRejectedValue(new NoteConflictError(2));
    const stale = await restoreNote(
      request(`/api/notes/${NOTE_ID}/restore`, {
        method: "POST",
        body: { expectedVersion: 1 },
      }),
      context(),
    );
    expect(stale.status).toBe(409);
  });

  it("rejects invalid restore UUIDs and missing expectedVersion", async () => {
    const invalidId = await restoreNote(
      request("/api/notes/not-a-uuid/restore", {
        method: "POST",
        body: { expectedVersion: 1 },
      }),
      context("not-a-uuid"),
    );
    expect(invalidId.status).toBe(400);
    expect(await errorCode(invalidId)).toBe("invalid_id");

    const missingVersion = await restoreNote(
      request(`/api/notes/${NOTE_ID}/restore`, {
        method: "POST",
        body: {},
      }),
      context(),
    );
    expect(missingVersion.status).toBe(400);
    expect(await errorCode(missingVersion)).toBe("invalid_shape");

    expect(service.restoreNote).not.toHaveBeenCalled();
  });
});
