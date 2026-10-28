import { getDb } from "@/lib/db/client";
import {
  InvalidPageError,
  parsePageParam,
} from "@/lib/notes/service";
import {
  SearchQueryError,
  emptySearchResult,
  normalizeSearchQuery,
  searchNotesFullText,
} from "@/lib/search/fts";
import {
  createGuardedReadHandler,
  jsonError,
  jsonOk,
} from "@/lib/security/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createGuardedReadHandler({
  handler: async (request) => {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") ?? "fulltext";

    if (mode !== "fulltext" && mode !== "") {
      return jsonError(
        400,
        "search_mode_unsupported",
        "V této fázi je dostupné pouze fulltextové hledání.",
      );
    }

    try {
      const page = parsePageParam(url.searchParams.get("page"));
      const query = normalizeSearchQuery(
        url.searchParams.get("q") ?? "",
      );

      if (query === "") {
        return jsonOk(emptySearchResult(query, page));
      }

      return jsonOk(
        await searchNotesFullText(getDb(), { page, query }),
      );
    } catch (error) {
      if (error instanceof SearchQueryError) {
        return jsonError(error.status, error.code, error.message);
      }

      if (error instanceof InvalidPageError) {
        return jsonError(400, "invalid_page", error.message);
      }

      throw error;
    }
  },
});
