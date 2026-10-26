import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as exportNote } from "@/app/api/notes/[id]/export/route";
import {
  NoteNotFoundError,
  type NoteDetailDto,
} from "@/lib/notes/service";

const service = vi.hoisted(() => ({
  getNote: vi.fn(),
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

function noteDetail(overrides: Partial<NoteDetailDto> = {}): NoteDetailDto {
  return {
    id: NOTE_ID,
    title: "Poznámka pro export",
    contentMd: "# Nadpis\n\nText",
    contentPlain: "Nadpis Text",
    category: null,
    tags: [],
    version: 1,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

function request(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string | null>;
  } = {},
): Request {
  const headers = new Headers({ host: "127.0.0.1:3000" });

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
  });
}

function context(id = NOTE_ID) {
  return { params: Promise.resolve({ id }) };
}

function exportUrl(id = NOTE_ID, format = "md"): string {
  return `/api/notes/${id}/export?format=${encodeURIComponent(format)}`;
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

function dispositionParts(response: Response): {
  readonly ascii: string;
  readonly unicode: string;
} {
  const disposition = response.headers.get("content-disposition") ?? "";
  const [kind, asciiPart, unicodePart] = disposition.split("; ");
  const ascii = /^filename="([^"]*)"$/.exec(asciiPart ?? "")?.[1];
  const encoded = /^filename\*=UTF-8''(.+)$/.exec(unicodePart ?? "")?.[1];

  expect(kind).toBe("attachment");
  expect(ascii).toBeDefined();
  expect(encoded).toBeDefined();

  return {
    ascii: ascii ?? "",
    unicode: decodeURIComponent(encoded ?? ""),
  };
}

describe("Markdown export API", () => {
  beforeAll(() => {
    vi.stubEnv("APP_ORIGIN", APP_ORIGIN);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the exact saved content_md bytes without rewriting", async () => {
    const contentMd = [
      "# Česká poznámka",
      "",
      "Text s **důrazem**, *kurzívou*, 😀 a [odkazem](javascript:alert(1)).",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "```ts",
      "const hodnota = 1;",
      "```",
      "",
    ].join("\r\n");
    service.getNote.mockResolvedValue(noteDetail({ contentMd }));

    const response = await exportNote(request(exportUrl()), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(service.getNote).toHaveBeenCalledWith(NOTE_ID);

    const actual = Buffer.from(await response.arrayBuffer());
    expect(actual.equals(Buffer.from(contentMd, "utf8"))).toBe(true);

    const parts = dispositionParts(response);
    expect(parts.ascii).toBe("Poznamka-pro-export.md");
    expect(parts.unicode).toBe("Poznámka pro export.md");
  });

  it("uses a safe ASCII fallback and percent-encoded Czech filename", async () => {
    service.getNote.mockResolvedValue(noteDetail());

    const response = await exportNote(request(exportUrl()), context());
    const parts = dispositionParts(response);

    expect(parts.ascii).toBe("Poznamka-pro-export.md");
    expect(parts.unicode).toBe("Poznámka pro export.md");
    expect(response.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''Pozn%C3%A1mka%20pro%20export.md",
    );
  });

  it("keeps header-breaking and path characters out of the download headers", async () => {
    service.getNote.mockResolvedValue(
      noteDetail({
        title: `..\\/Zpráva\r\nSet-Cookie: klic=1 <script>|?*"`,
      }),
    );

    const response = await exportNote(request(exportUrl()), context());

    expect(response.status).toBe(200);

    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).not.toContain("Set-Cookie:");
    expect(response.headers.get("set-cookie")).toBeNull();

    const parts = dispositionParts(response);
    expect(parts.ascii).toMatch(/^[A-Za-z0-9._-]+\.md$/);
    expect(parts.ascii).not.toContain("..");
    expect(parts.unicode).toMatch(/\.md$/);
    expect(parts.unicode).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/);
  });

  it("falls back to Czech and ASCII defaults for an empty title", async () => {
    service.getNote.mockResolvedValue(noteDetail({ title: "" }));

    const response = await exportNote(request(exportUrl()), context());
    const parts = dispositionParts(response);

    expect(parts.ascii).toBe("Poznamka.md");
    expect(parts.unicode).toBe("Poznámka.md");
  });

  it("rejects missing or unsupported formats before loading the note", async () => {
    for (const path of [
      `/api/notes/${NOTE_ID}/export`,
      exportUrl(NOTE_ID, "docx"),
      exportUrl(NOTE_ID, ""),
    ]) {
      const response = await exportNote(request(path), context());
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("invalid_format");
    }

    expect(service.getNote).not.toHaveBeenCalled();
  });

  it("rejects invalid UUIDs and missing or deleted notes", async () => {
    const invalid = await exportNote(
      request(exportUrl("not-a-uuid")),
      context("not-a-uuid"),
    );
    expect(invalid.status).toBe(400);
    expect(await errorCode(invalid)).toBe("invalid_id");

    service.getNote.mockRejectedValue(new NoteNotFoundError());
    const missing = await exportNote(request(exportUrl()), context());
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe("note_not_found");

    service.getNote.mockResolvedValue(
      noteDetail({ deletedAt: new Date("2026-01-02T00:00:00.000Z") }),
    );
    const deleted = await exportNote(request(exportUrl()), context());
    expect(deleted.status).toBe(404);
    expect(await errorCode(deleted)).toBe("note_not_found");
  });

  it("rejects non-read methods and invalid Host without loading the note", async () => {
    const post = await exportNote(
      request(exportUrl(), { method: "POST" }),
      context(),
    );
    expect(post.status).toBe(405);
    expect(await errorCode(post)).toBe("method_not_allowed");

    const wrongHost = await exportNote(
      request(exportUrl(), { headers: { host: "evil.example" } }),
      context(),
    );
    expect(wrongHost.status).toBe(403);
    expect(await errorCode(wrongHost)).toBe("invalid_host");

    expect(service.getNote).not.toHaveBeenCalled();
  });
});
