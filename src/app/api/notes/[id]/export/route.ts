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
import { UnsupportedMarkdownError } from "@/lib/notes/markdown";
import {
  DocxExportTooLargeError,
  DocxListDepthError,
  renderNoteDocx,
} from "@/lib/notes/export-docx";
import { buildDownloadContentDisposition } from "@/lib/notes/export-filename";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExportRouteContext = {
  params: Promise<{ id: string }>;
};

const MARKDOWN_MEDIA_TYPE = "text/markdown; charset=utf-8";
const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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

function markdownResponse(contentMd: string, title: string): Response {
  return new Response(new TextEncoder().encode(contentMd), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-disposition": buildDownloadContentDisposition(title, "md"),
      "content-type": MARKDOWN_MEDIA_TYPE,
      "x-content-type-options": "nosniff",
    },
  });
}

function docxResponse(buffer: Buffer, title: string): Response {
  return new Response(Uint8Array.from(buffer), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-disposition": buildDownloadContentDisposition(title, "docx"),
      "content-type": DOCX_MEDIA_TYPE,
      "x-content-type-options": "nosniff",
    },
  });
}

function exportErrorResponse(error: unknown): Response {
  if (error instanceof UnsupportedMarkdownError) {
    return jsonError(
      422,
      "unsupported_markdown",
      error.message,
      undefined,
      { reasons: error.reasons },
    );
  }

  if (error instanceof DocxListDepthError) {
    return jsonError(422, "docx_list_too_deep", error.message);
  }

  if (error instanceof DocxExportTooLargeError) {
    return jsonError(422, "docx_too_large", error.message);
  }

  return toNoteErrorResponse(error);
}

export const GET = createGuardedReadHandler<ExportRouteContext>({
  handler: async (request, routeContext) => {
    try {
      const format = new URL(request.url).searchParams.get("format");

      if (format !== "md" && format !== "docx") {
        return jsonError(
          400,
          "invalid_format",
          "Podporované formáty exportu jsou md a docx.",
        );
      }

      const note = await getNoteService().getNote(
        await readNoteId(routeContext),
      );

      if (note.deletedAt !== null) {
        throw new NoteNotFoundError();
      }

      if (format === "md") {
        return markdownResponse(note.contentMd, note.title);
      }

      return docxResponse(
        await renderNoteDocx(note.title, note.contentMd),
        note.title,
      );
    } catch (error) {
      return exportErrorResponse(error);
    }
  },
});
