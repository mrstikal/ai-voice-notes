import { describe, expect, it, vi } from "vitest";

import { countGraphemes } from "../../src/lib/notes/limits";
import {
  MEETING_SAVE_MAX_BYTES,
  NOTE_EDIT_MAX_BYTES,
  TOKEN_TOOL_MAX_BYTES,
  checkLocalHost,
  createGuardedJsonRoute,
  createGuardedReadHandler,
  createRateLimiter,
  jsonOk,
  type GuardedJsonRouteContext,
} from "../../src/lib/security/http";
import {
  noteMutationPayloadSchema,
  tokenRequestSchema,
  type NoteMutationPayload,
} from "../../src/lib/security/schemas";

const APP_ORIGIN = "http://127.0.0.1:3000";
const REQUEST_URL = "http://127.0.0.1:3000/api/test";
const BASE_HEADERS = {
  host: "127.0.0.1:3000",
  origin: APP_ORIGIN,
  "content-type": "application/json",
};

function jsonRequest(
  body: unknown,
  headerOverrides: Record<string, string | null> = {},
  method = "POST",
): Request {
  const headers = new Headers(BASE_HEADERS);

  for (const [name, value] of Object.entries(headerOverrides)) {
    if (value === null) {
      headers.delete(name);
    } else {
      headers.set(name, value);
    }
  }

  return new Request(REQUEST_URL, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

function chunkedRequest(totalBytes: number, chunkSize = 64 * 1024): Request {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }

      const size = Math.min(chunkSize, totalBytes - sent);
      controller.enqueue(new Uint8Array(size));
      sent += size;
    },
  });

  return new Request(REQUEST_URL, {
    method: "POST",
    headers: BASE_HEADERS,
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function createNoteRoute(
  handler: (
    context: GuardedJsonRouteContext<NoteMutationPayload, undefined>,
  ) => Response | Promise<Response>,
  maxBytes = NOTE_EDIT_MAX_BYTES,
) {
  return createGuardedJsonRoute({
    appOrigin: APP_ORIGIN,
    maxBytes,
    schema: noteMutationPayloadSchema,
    handler,
  });
}

async function readError(response: Response): Promise<{
  error: { code: string; message: string };
}> {
  return (await response.json()) as {
    error: { code: string; message: string };
  };
}

describe("local HTTP guard", () => {
  it("accepts a request with the exact Host, Origin, JSON content type, and valid shape", async () => {
    const handler = vi.fn(
      async ({
        data,
      }: GuardedJsonRouteContext<NoteMutationPayload, undefined>) =>
        jsonOk({
          title: data.title,
          graphemes: countGraphemes(data.contentMd),
        }),
    );
    const route = createNoteRoute(handler);

    const response = await route(
      jsonRequest(
        { title: "Testovací poznámka", contentMd: "Ahoj" },
        { "content-type": "application/json; charset=utf-8" },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      title: "Testovací poznámka",
      graphemes: 4,
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects a wrong or missing Host without calling the handler", async () => {
    const handler = vi.fn(async () => jsonOk({ ok: true }));
    const route = createNoteRoute(handler);

    const wrongHost = await route(
      jsonRequest({ title: "Test", contentMd: "x" }, { host: "evil.example" }),
    );
    expect(wrongHost.status).toBe(403);
    expect((await readError(wrongHost)).error.code).toBe("invalid_host");

    const missingHost = await route(
      jsonRequest({ title: "Test", contentMd: "x" }, { host: null }),
    );
    expect(missingHost.status).toBe(403);
    expect((await readError(missingHost)).error.code).toBe("invalid_host");

    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a wrong or missing Origin without calling the handler", async () => {
    const handler = vi.fn(async () => jsonOk({ ok: true }));
    const route = createNoteRoute(handler);

    const wrongOrigin = await route(
      jsonRequest(
        { title: "Test", contentMd: "x" },
        { origin: "http://evil.example" },
      ),
    );
    expect(wrongOrigin.status).toBe(403);
    const wrongOriginBody = await readError(wrongOrigin);
    expect(wrongOriginBody.error.code).toBe("invalid_origin");
    expect(JSON.stringify(wrongOriginBody)).not.toContain("evil.example");

    const missingOrigin = await route(
      jsonRequest({ title: "Test", contentMd: "x" }, { origin: null }),
    );
    expect(missingOrigin.status).toBe(403);
    expect((await readError(missingOrigin)).error.code).toBe("invalid_origin");

    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects invalid or missing JSON content types without calling the handler", async () => {
    const handler = vi.fn(async () => jsonOk({ ok: true }));
    const route = createNoteRoute(handler);

    for (const contentType of ["text/plain", "application/json-patch+json", null]) {
      const response = await route(
        jsonRequest(
          { title: "Test", contentMd: "x" },
          { "content-type": contentType },
        ),
      );
      expect(response.status).toBe(415);
      expect((await readError(response)).error.code).toBe("invalid_content_type");
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON, invalid UTF-8, and invalid shapes", async () => {
    const handler = vi.fn(async () => jsonOk({ ok: true }));
    const route = createNoteRoute(handler);

    const invalidJson = await route(
      new Request(REQUEST_URL, {
        method: "POST",
        headers: BASE_HEADERS,
        body: "{",
      }),
    );
    expect(invalidJson.status).toBe(400);
    expect((await readError(invalidJson)).error.code).toBe("invalid_json");

    const invalidUtf8 = await route(
      new Request(REQUEST_URL, {
        method: "POST",
        headers: BASE_HEADERS,
        body: new Uint8Array([0xff]),
      }),
    );
    expect(invalidUtf8.status).toBe(400);
    expect((await readError(invalidUtf8)).error.code).toBe("invalid_utf8");

    const invalidShape = await route(jsonRequest({ title: "Test" }));
    expect(invalidShape.status).toBe(400);
    expect((await readError(invalidShape)).error.code).toBe("invalid_shape");

    expect(handler).not.toHaveBeenCalled();
  });

  it.each<[string, number]>([
    ["1 MiB note edit", NOTE_EDIT_MAX_BYTES],
    ["16 KiB token/tool", TOKEN_TOOL_MAX_BYTES],
    ["3 MiB meeting save", MEETING_SAVE_MAX_BYTES],
  ])(
    "rejects a chunked body over the %s ceiling without calling the handler",
    async (_label, maxBytes) => {
      const handler = vi.fn(async () => jsonOk({ ok: true }));
      const route = createNoteRoute(handler, maxBytes);
      const request = chunkedRequest(maxBytes + 1);

      expect(request.headers.get("content-length")).toBeNull();

      const response = await route(request);
      expect(response.status).toBe(413);
      expect((await readError(response)).error.code).toBe("payload_too_large");
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("rejects a declared Content-Length over the ceiling without reading the body", async () => {
    const handler = vi.fn(async () => jsonOk({ ok: true }));
    const route = createNoteRoute(handler);

    const response = await route(
      jsonRequest(
        { title: "Test", contentMd: "x" },
        { "content-length": String(NOTE_EDIT_MAX_BYTES + 1) },
      ),
    );

    expect(response.status).toBe(413);
    expect((await readError(response)).error.code).toBe("payload_too_large");
    expect(handler).not.toHaveBeenCalled();
  });

  it("enforces the byte ceiling independently of the grapheme count", async () => {
    const handler = vi.fn(async () => jsonOk({ ok: true }));
    const route = createNoteRoute(handler);
    const combiningGrapheme = `a${"\u0301".repeat(100)}`;
    const content = combiningGrapheme.repeat(10_000);

    expect(countGraphemes(content)).toBeLessThanOrEqual(20_000);

    const response = await route(
      jsonRequest({ title: "Test", contentMd: content }),
    );

    expect(response.status).toBe(413);
    expect((await readError(response)).error.code).toBe("payload_too_large");
    expect(handler).not.toHaveBeenCalled();
  });

  it.each<[string, string]>([
    ["emoji", "😀".repeat(20_000)],
    ["Czech", "Příliš žluťoučký kůň ".repeat(1_000).slice(0, 20_000)],
  ])(
    "accepts a 20,000-grapheme %s note below 1 MiB",
    async (_label, content) => {
      const handler = vi.fn(
        async ({
          data,
        }: GuardedJsonRouteContext<NoteMutationPayload, undefined>) =>
          jsonOk({ graphemes: countGraphemes(data.contentMd) }),
      );
      const route = createNoteRoute(handler);

      expect(countGraphemes(content)).toBe(20_000);

      const response = await route(
        jsonRequest({ title: "Test", contentMd: content }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ graphemes: 20_000 });
      expect(handler).toHaveBeenCalledTimes(1);
    },
  );

  it("rate limits a costly route before calling the handler", async () => {
    const handler = vi.fn(async () => jsonOk({ ok: true }));
    const route = createGuardedJsonRoute({
      appOrigin: APP_ORIGIN,
      maxBytes: TOKEN_TOOL_MAX_BYTES,
      schema: tokenRequestSchema,
      rateLimit: { limit: 1, windowMs: 60_000 },
      handler,
    });

    const first = await route(jsonRequest({}));
    const second = await route(jsonRequest({}));

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
    expect((await readError(second)).error.code).toBe("rate_limited");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects GET and HEAD on mutation routes without calling the handler", async () => {
    const handler = vi.fn(async () => jsonOk({ ok: true }));
    const route = createNoteRoute(handler);

    for (const method of ["GET", "HEAD"]) {
      const response = await route(
        new Request(REQUEST_URL, {
          method,
          headers: { host: "127.0.0.1:3000", origin: APP_ORIGIN },
        }),
      );
      expect(response.status).toBe(405);
      expect((await readError(response)).error.code).toBe("method_not_allowed");
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback appOrigin supplied explicitly", async () => {
    const handler = vi.fn(async () => jsonOk({ ok: true }));
    const route = createGuardedJsonRoute({
      appOrigin: "http://evil.example:3000",
      maxBytes: NOTE_EDIT_MAX_BYTES,
      schema: noteMutationPayloadSchema,
      handler,
    });

    const response = await route(
      jsonRequest(
        { title: "Test", contentMd: "x" },
        { host: "evil.example:3000", origin: "http://evil.example:3000" },
      ),
    );

    expect(response.status).toBe(500);
    expect((await readError(response)).error.code).toBe("invalid_config");
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback origin in the exported Host check", () => {
    const response = checkLocalHost(
      new Request(REQUEST_URL, {
        headers: { host: "evil.example:3000" },
      }),
      "http://evil.example:3000",
    );

    expect(response?.status).toBe(500);
  });

  it("rejects an empty explicit appOrigin", async () => {
    const handler = vi.fn(async () => jsonOk({ ok: true }));
    const route = createGuardedJsonRoute({
      appOrigin: "",
      maxBytes: NOTE_EDIT_MAX_BYTES,
      schema: noteMutationPayloadSchema,
      handler,
    });

    const response = await route(
      jsonRequest({ title: "Test", contentMd: "x" }),
    );

    expect(response.status).toBe(500);
    expect((await readError(response)).error.code).toBe("invalid_config");
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects an empty origin in the exported Host check", () => {
    const response = checkLocalHost(
      new Request(REQUEST_URL, {
        headers: { host: "127.0.0.1:3000" },
      }),
      "",
    );

    expect(response?.status).toBe(500);
  });

  it("rejects an invalid maxBytes at route construction", () => {
    expect(() =>
      createGuardedJsonRoute({
        appOrigin: APP_ORIGIN,
        maxBytes: 0,
        schema: noteMutationPayloadSchema,
        handler: vi.fn(async () => jsonOk({ ok: true })),
      }),
    ).toThrow(RangeError);
  });

  it("applies the full configured-origin rules to an explicit appOrigin", async () => {
    for (const appOrigin of [
      "https://127.0.0.1:3000",
      "http://user:password@127.0.0.1:3000",
      "http://127.0.0.1:3000/api",
    ]) {
      const handler = vi.fn(async () => jsonOk({ ok: true }));
      const route = createGuardedJsonRoute({
        appOrigin,
        maxBytes: NOTE_EDIT_MAX_BYTES,
        schema: noteMutationPayloadSchema,
        handler,
      });

      const response = await route(
        jsonRequest(
          { title: "Test", contentMd: "x" },
          { host: new URL(appOrigin).host, origin: appOrigin },
        ),
      );

      expect(response.status).toBe(500);
      expect((await readError(response)).error.code).toBe("invalid_config");
      expect(handler).not.toHaveBeenCalled();
    }
  });
});

describe("local read guard", () => {
  it("guards GET/HEAD by Host and rejects mutations", async () => {
    const handler = vi.fn(async () => jsonOk({ ok: true }));
    const route = createGuardedReadHandler({
      appOrigin: APP_ORIGIN,
      handler,
    });

    const get = await route(
      new Request(REQUEST_URL, {
        method: "GET",
        headers: { host: "127.0.0.1:3000" },
      }),
    );
    expect(get.status).toBe(200);

    const head = await route(
      new Request(REQUEST_URL, {
        method: "HEAD",
        headers: { host: "127.0.0.1:3000" },
      }),
    );
    expect(head.status).toBe(200);

    const wrongHost = await route(
      new Request(REQUEST_URL, {
        method: "GET",
        headers: { host: "evil.example" },
      }),
    );
    expect(wrongHost.status).toBe(403);
    expect((await readError(wrongHost)).error.code).toBe("invalid_host");

    const post = await route(
      new Request(REQUEST_URL, {
        method: "POST",
        headers: { host: "127.0.0.1:3000" },
        body: "{}",
      }),
    );
    expect(post.status).toBe(405);
    expect((await readError(post)).error.code).toBe("method_not_allowed");

    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe("configured origin resolution", () => {
  it("uses APP_ORIGIN when no explicit appOrigin is provided", async () => {
    vi.stubEnv("APP_ORIGIN", APP_ORIGIN);

    try {
      const handler = vi.fn(async () => jsonOk({ ok: true }));
      const route = createGuardedJsonRoute({
        maxBytes: NOTE_EDIT_MAX_BYTES,
        schema: noteMutationPayloadSchema,
        handler,
      });

      const response = await route(
        jsonRequest({ title: "Test", contentMd: "x" }),
      );

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns Czech invalid_config when APP_ORIGIN is invalid", async () => {
    vi.stubEnv("APP_ORIGIN", "http://evil.example:3000");

    try {
      const handler = vi.fn(async () => jsonOk({ ok: true }));
      const route = createGuardedJsonRoute({
        maxBytes: NOTE_EDIT_MAX_BYTES,
        schema: noteMutationPayloadSchema,
        handler,
      });

      const response = await route(
        jsonRequest(
          { title: "Test", contentMd: "x" },
          { host: "evil.example:3000", origin: "http://evil.example:3000" },
        ),
      );

      expect(response.status).toBe(500);
      expect((await readError(response)).error.code).toBe("invalid_config");
      expect(handler).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("resolves APP_ORIGIN independently of unrelated configuration", async () => {
    vi.stubEnv("APP_ORIGIN", APP_ORIGIN);
    vi.stubEnv("DATABASE_URL", "not-a-postgres-url");
    vi.stubEnv("NOTE_MAX_CHARACTERS", "not-a-number");

    try {
      const handler = vi.fn(async () => jsonOk({ ok: true }));
      const route = createGuardedJsonRoute({
        maxBytes: NOTE_EDIT_MAX_BYTES,
        schema: noteMutationPayloadSchema,
        handler,
      });

      const response = await route(
        jsonRequest({ title: "Test", contentMd: "x" }),
      );

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses APP_ORIGIN for the read handler too", async () => {
    vi.stubEnv("APP_ORIGIN", APP_ORIGIN);

    try {
      const handler = vi.fn(async () => jsonOk({ ok: true }));
      const route = createGuardedReadHandler({ handler });

      const response = await route(
        new Request(REQUEST_URL, {
          method: "GET",
          headers: { host: "127.0.0.1:3000" },
        }),
      );

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("rate limiter", () => {
  it("resets windows deterministically and supports explicit reset", () => {
    let now = 0;
    const limiter = createRateLimiter({
      limit: 2,
      windowMs: 1_000,
      now: () => now,
    });

    expect(limiter.check("local").allowed).toBe(true);
    expect(limiter.check("local").allowed).toBe(true);
    expect(limiter.check("local")).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 1,
    });

    now = 1_000;
    expect(limiter.check("local").allowed).toBe(true);

    limiter.reset("local");
    expect(limiter.check("local").allowed).toBe(true);
  });
});
