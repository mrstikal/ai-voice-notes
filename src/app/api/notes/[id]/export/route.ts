import {
  createGuardedReadHandler,
  jsonError,
} from "@/lib/security/http";
import {
  InvalidNoteIdError,
  NoteNotFoundError,
  assertNoteId,
  getNoteService,
  toNoteErrorResponse,
} from "@/lib/notes/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExportRouteContext = {
  params: Promise<{ id: string }>;
};

const MARKDOWN_MEDIA_TYPE = "text/markdown; charset=utf-8";
const FALLBACK_FILENAME = "Poznamka";
const DEFAULT_FILENAME = "Poznámka";
const FILENAME_RESERVED_PATTERN = /[<>:"/\\|?*]/g;
const FILENAME_CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const ASCII_ATTR_CHAR_PATTERN = /[A-Za-z0-9!#$&+\-.^_`|~]/;

async function readNoteId(
  context: ExportRouteContext | undefined,
): Promise<string> {
  if (!context) {
    throw new InvalidNoteIdError();
  }

  const { id } = await context.params;
  assertNoteId(id);
  return id;
}

function sanitizeFilenameBase(title: string, fallback: string): string {
  const cleaned = title
    .normalize("NFC")
    .replace(FILENAME_CONTROL_PATTERN, "")
    .replace(FILENAME_RESERVED_PATTERN, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s-]+$/g, "");

  return cleaned === "" ? fallback : cleaned;
}

function asciiFallbackFilename(title: string): string {
  const ascii = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(FILENAME_CONTROL_PATTERN, "")
    .replace(FILENAME_RESERVED_PATTERN, "-")
    .replace(/[^A-Za-z0-9._ -]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "");

  return `${ascii === "" ? FALLBACK_FILENAME : ascii}.md`;
}

function percentEncodeFilename(filename: string): string {
  const bytes = new TextEncoder().encode(filename);
  let encoded = "";

  for (const byte of bytes) {
    const character = String.fromCharCode(byte);

    if (ASCII_ATTR_CHAR_PATTERN.test(character)) {
      encoded += character;
    } else {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }

  return encoded;
}

function contentDisposition(title: string): string {
  const asciiFilename = asciiFallbackFilename(title);
  const unicodeFilename = `${sanitizeFilenameBase(title, DEFAULT_FILENAME)}.md`;

  return [
    "attachment",
    `filename="${asciiFilename}"`,
    `filename*=UTF-8''${percentEncodeFilename(unicodeFilename)}`,
  ].join("; ");
}

function markdownResponse(contentMd: string, title: string): Response {
  return new Response(new TextEncoder().encode(contentMd), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-disposition": contentDisposition(title),
      "content-type": MARKDOWN_MEDIA_TYPE,
      "x-content-type-options": "nosniff",
    },
  });
}

export const GET = createGuardedReadHandler<ExportRouteContext>({
  handler: async (request, routeContext) => {
    try {
      const format = new URL(request.url).searchParams.get("format");

      if (format !== "md") {
        return jsonError(
          400,
          "invalid_format",
          "Podporovaný formát exportu je pouze md.",
        );
      }

      const note = await getNoteService().getNote(
        await readNoteId(routeContext),
      );

      if (note.deletedAt !== null) {
        throw new NoteNotFoundError();
      }

      return markdownResponse(note.contentMd, note.title);
    } catch (error) {
      return toNoteErrorResponse(error);
    }
  },
});
