import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as searchRoute } from "@/app/api/search/route";

const APP_ORIGIN = "http://127.0.0.1:3000";
const fakeDb = {};

const searchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  getDb: () => fakeDb,
}));

vi.mock("@/lib/search/fts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/search/fts")>();

  return {
    ...actual,
    searchNotesFullText: searchMock,
  };
});

function request(path: string): Request {
  return new Request(`${APP_ORIGIN}/api/search${path}`, {
    headers: {
      host: "127.0.0.1:3000",
      origin: APP_ORIGIN,
    },
  });
}

describe("P34 full-text search API", () => {
  beforeEach(() => {
    searchMock.mockReset();
  });

  it("returns an explanatory empty result without querying all notes", async () => {
    const response = await searchRoute(
      request("?q=%20%20&mode=fulltext&page=1"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      empty: true,
      items: [],
      page: 1,
      pageSize: 10,
      query: "",
      total: 0,
    });
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("passes trimmed query/page to the ranked search and returns its result", async () => {
    searchMock.mockResolvedValue({
      empty: false,
      hasNext: false,
      items: [],
      page: 2,
      pageSize: 10,
      query: "databaze",
      total: 0,
    });

    const response = await searchRoute(
      request("?q=%20databaze%20&mode=fulltext&page=2"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      page: 2,
      query: "databaze",
    });
    expect(searchMock).toHaveBeenCalledWith(fakeDb, {
      page: 2,
      query: "databaze",
    });
  });

  it("rejects semantic mode, overlong queries and invalid pages", async () => {
    const semantic = await searchRoute(request("?q=test&mode=semantic"));
    expect(semantic.status).toBe(400);
    expect(await semantic.json()).toMatchObject({
      error: { code: "search_mode_unsupported" },
    });

    const overlong = await searchRoute(
      request(`?q=${encodeURIComponent("x".repeat(201))}&mode=fulltext`),
    );
    expect(overlong.status).toBe(400);
    expect(await overlong.json()).toMatchObject({
      error: { code: "search_query_too_long" },
    });

    const invalidPage = await searchRoute(
      request("?q=test&mode=fulltext&page=0"),
    );
    expect(invalidPage.status).toBe(400);
    expect(await invalidPage.json()).toMatchObject({
      error: { code: "invalid_page" },
    });
    expect(searchMock).not.toHaveBeenCalled();
  });
});
