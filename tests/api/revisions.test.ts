import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as listRevisions } from "@/app/api/notes/[id]/revisions/route";
import { POST as restoreRevision } from "@/app/api/notes/[id]/revisions/[revisionId]/restore/route";
import type { NoteDetailDto } from "@/lib/notes/service";
import type { RevisionHistoryDto } from "@/lib/notes/revisions";

const service = vi.hoisted(() => ({
  list: vi.fn(),
  restore: vi.fn(),
}));

vi.mock("@/lib/notes/revisions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notes/revisions")>();

  return {
    ...actual,
    getRevisionService: () => service,
  };
});

const APP_ORIGIN = "http://127.0.0.1:3000";
const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const REVISION_ID = "22222222-2222-4222-8222-222222222222";

function history(): RevisionHistoryDto {
  return {
    currentVersion: 2,
    currentSnapshot: {
      title: "Historie",
      contentMd: "Druhá verze.",
      category: null,
      tags: [],
    },
    revisions: [
      {
        id: REVISION_ID,
        noteVersion: 2,
        reason: "manual",
        createdAt: new Date("2026-10-27T10:00:00.000Z"),
        beforeSnapshot: {
          title: "Historie",
          contentMd: "První verze.",
          category: null,
          tags: [],
        },
        afterSnapshot: {
          title: "Historie",
          contentMd: "Druhá verze.",
          category: null,
          tags: [],
        },
        diff: {
          start: 0,
          end: 5,
          prefix: "",
          removed: "První",
          inserted: "Druhá",
          suffix: " verze.",
        },
      },
    ],
    undoRevisionId: REVISION_ID,
    canUndo: true,
  };
}

function note(): NoteDetailDto {
  return {
    id: NOTE_ID,
    title: "Historie",
    contentMd: "První verze.",
    contentPlain: "První verze.",
    category: null,
    tags: [],
    version: 3,
    createdAt: new Date("2026-10-27T10:00:00.000Z"),
    updatedAt: new Date("2026-10-27T10:01:00.000Z"),
    deletedAt: null,
  };
}

function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string | null>;
    contentType?: string;
  } = {},
): Request {
  const headers = new Headers({
    host: "127.0.0.1:3000",
    origin: APP_ORIGIN,
  });

  if (options.body !== undefined) {
    headers.set("content-type", options.contentType ?? "application/json");
  }

  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }

  return new Request(`${APP_ORIGIN}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function context() {
  return {
    params: Promise.resolve({ id: NOTE_ID, revisionId: REVISION_ID }),
  };
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

describe("revisions API", () => {
  beforeAll(() => vi.stubEnv("APP_ORIGIN", APP_ORIGIN));
  afterAll(() => vi.unstubAllEnvs());
  beforeEach(() => vi.resetAllMocks());

  it("lists stored revisions", async () => {
    service.list.mockResolvedValue(history());

    const response = await listRevisions(
      request(`/api/notes/${NOTE_ID}/revisions`),
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      currentVersion: 2,
      canUndo: true,
      revisions: [{ reason: "manual", noteVersion: 2 }],
    });
  });

  it("restores with an explicit mode and expected version", async () => {
    service.restore.mockResolvedValue(note());

    const response = await restoreRevision(
      request(`/api/notes/${NOTE_ID}/revisions/${REVISION_ID}/restore`, {
        method: "POST",
        body: { mode: "restore", expectedVersion: 2 },
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(service.restore).toHaveBeenCalledWith(NOTE_ID, REVISION_ID, {
      mode: "restore",
      expectedVersion: 2,
    });
    expect(await response.json()).toMatchObject({ version: 3 });
  });

  it("maps conflicts and rejects guarded/invalid requests", async () => {
    const { NoteConflictError } = await import("@/lib/notes/service");
    service.restore.mockRejectedValue(new NoteConflictError(4));

    const conflict = await restoreRevision(
      request(`/api/notes/${NOTE_ID}/revisions/${REVISION_ID}/restore`, {
        method: "POST",
        body: { mode: "undo", expectedVersion: 2 },
      }),
      context(),
    );
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe("version_conflict");

    const invalidMode = await restoreRevision(
      request(`/api/notes/${NOTE_ID}/revisions/${REVISION_ID}/restore`, {
        method: "POST",
        body: { mode: "apply", expectedVersion: 2 },
      }),
      context(),
    );
    expect(invalidMode.status).toBe(400);
    expect(await errorCode(invalidMode)).toBe("invalid_shape");

    const wrongOrigin = await restoreRevision(
      request(`/api/notes/${NOTE_ID}/revisions/${REVISION_ID}/restore`, {
        method: "POST",
        body: { mode: "restore", expectedVersion: 2 },
        headers: { origin: "http://evil.example" },
      }),
      context(),
    );
    expect(wrongOrigin.status).toBe(403);
    expect(await errorCode(wrongOrigin)).toBe("invalid_origin");

    expect(service.restore).toHaveBeenCalledTimes(1);

    const { RevisionNotFoundError } = await import("@/lib/notes/revisions");
    service.restore.mockRejectedValueOnce(new RevisionNotFoundError());
    const missing = await restoreRevision(
      request(`/api/notes/${NOTE_ID}/revisions/${REVISION_ID}/restore`, {
        method: "POST",
        body: { mode: "restore", expectedVersion: 2 },
      }),
      context(),
    );
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe("revision_not_found");
  });
});
