import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { UsageService } from "../../src/lib/ai/usage";
import type { NoteDetailDto } from "../../src/lib/notes/service";
import {
  createReadAloudRouteHandler,
  DEFAULT_READ_ALOUD_RATE_LIMIT,
} from "../../src/app/api/tts/route";
import { createTtsCacheRouteHandlers } from "../../src/app/api/tts/cache/route";
import {
  TTS_CACHE_MAX_BYTES,
  createTtsCache,
  purgeNoteTtsCacheBestEffort,
  ttsCacheKey,
} from "../../src/lib/tts/cache";
import {
  TTS_MODEL_ID,
  type TtsService,
  type TtsVoice,
} from "../../src/lib/tts/provider";

const APP_ORIGIN = "http://127.0.0.1:3000";
const REQUEST_URL = `${APP_ORIGIN}/api/tts`;
const NOTE_ID = "33333333-3333-4333-8333-333333333333";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(
    path.join(os.tmpdir(), "ai-voice-notes-tts-cache-"),
  );
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

beforeAll(() => {
  vi.stubEnv("APP_ORIGIN", APP_ORIGIN);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

function bytes(length = 10): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index + 1);
}

function mp3Bytes(): Uint8Array {
  return new Uint8Array([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
}

function cacheKey(text: string, voice = "sarah"): string {
  return ttsCacheKey({ text, model: TTS_MODEL_ID, voice });
}

function note(contentMd: string): NoteDetailDto {
  return {
    id: NOTE_ID,
    title: "Testovací poznámka",
    category: null,
    version: 7,
    createdAt: new Date("2026-10-27T10:00:00Z"),
    updatedAt: new Date("2026-10-27T10:00:00Z"),
    deletedAt: null,
    contentMd,
    contentPlain: contentMd,
    tags: [],
  };
}

function request(options: {
  method?: string;
  body?: unknown;
} = {}): Request {
  const headers = new Headers({ host: "127.0.0.1:3000" });

  if (options.body !== undefined) {
    headers.set("origin", APP_ORIGIN);
    headers.set("content-type", "application/json");
  }

  return new Request(REQUEST_URL, {
    method: options.method ?? "POST",
    headers,
    body:
      options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function fakeUsage(remainingUsd = "2.000000"): UsageService {
  return {
    reserve: vi.fn(),
    settle: vi.fn(),
    markUnknown: vi.fn(),
    getSummary: vi.fn().mockResolvedValue({
      budgetUsd: "2.000000",
      committedUsd: "0.000000",
      reservedUsd: "0.000000",
      reportedUsd: "0.000000",
      remainingUsd,
      activeCount: 0,
      unknownCount: 0,
      operations: [],
    }),
    resetUsage: vi.fn(),
  };
}

function fakeTts() {
  const synthesize = vi.fn<TtsService["synthesize"]>(
    async ({ voice }) => ({
      audio: mp3Bytes(),
      contentType: "audio/mpeg",
      model: TTS_MODEL_ID,
      voice: voice as TtsVoice,
      byteLength: mp3Bytes().byteLength,
      generationId: "gen-test",
    }),
  );

  return { synthesize };
}

describe("P19 server cache", () => {
  it("uses a deterministic text+model+voice+settings key", () => {
    expect(cacheKey("Ahoj")).toBe(cacheKey("Ahoj"));
    expect(cacheKey("Ahoj")).not.toBe(cacheKey("Ahoj!"));
    expect(cacheKey("Ahoj", "george")).not.toBe(cacheKey("Ahoj", "sarah"));
    expect(
      ttsCacheKey({
        text: "Ahoj",
        model: TTS_MODEL_ID,
        voice: "sarah",
        settings: "different",
      }),
    ).not.toBe(cacheKey("Ahoj"));
  });

  it("stores, reads, and tracks note ownership", async () => {
    const cache = createTtsCache({ directory });
    const key = cacheKey("Ahoj");

    await cache.put(key, bytes(), {
      model: TTS_MODEL_ID,
      voice: "sarah",
      noteId: "note-a",
    });

    expect(await cache.has(key)).toBe(true);
    expect(await cache.get(key, "note-a")).toEqual(bytes());
    expect(await cache.get(key, "note-b")).toEqual(bytes());
    expect(await cache.stats()).toEqual({
      entries: 1,
      bytes: 10,
      maxBytes: TTS_CACHE_MAX_BYTES,
    });

    expect(await cache.purgeNote("note-a")).toBe(0);
    expect(await cache.has(key)).toBe(true);
    expect(await cache.purgeNote("note-b")).toBe(1);
    expect(await cache.has(key)).toBe(false);
    expect(await cache.stats()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it("purges only the affected voice or model", async () => {
    const cache = createTtsCache({ directory });

    await cache.put(cacheKey("Sarah", "sarah"), bytes(), {
      model: TTS_MODEL_ID,
      voice: "sarah",
      noteId: "note-a",
    });
    await cache.put(cacheKey("George", "george"), bytes(), {
      model: TTS_MODEL_ID,
      voice: "george",
      noteId: "note-a",
    });

    expect(await cache.purgeVoice("sarah")).toBe(1);
    expect(await cache.has(cacheKey("Sarah", "sarah"))).toBe(false);
    expect(await cache.has(cacheKey("George", "george"))).toBe(true);
    expect(await cache.purgeModel(TTS_MODEL_ID)).toBe(1);
    expect(await cache.has(cacheKey("George", "george"))).toBe(false);
  });

  it("removes a missing file from the manifest instead of returning stale bytes", async () => {
    const cache = createTtsCache({ directory });
    const key = cacheKey("Ahoj");

    await cache.put(key, bytes(), {
      model: TTS_MODEL_ID,
      voice: "sarah",
      noteId: "note-a",
    });
    await rm(path.join(directory, `${key}.mp3`));

    expect(await cache.get(key)).toBeNull();
    expect(await cache.stats()).toMatchObject({ entries: 0 });
  });

  it("prunes by LRU and never deletes unrelated files", async () => {
    let tick = 0;
    const cache = createTtsCache({
      directory,
      maxBytes: 30,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    });
    const unrelated = path.join(directory, "unrelated.bin");
    await writeFile(unrelated, "keep me");

    const keyA = cacheKey("A");
    const keyB = cacheKey("B");
    const keyC = cacheKey("C");
    const keyD = cacheKey("D");

    await cache.put(keyA, bytes(), {
      model: TTS_MODEL_ID,
      voice: "sarah",
      noteId: "note-a",
    });
    await cache.put(keyB, bytes(), {
      model: TTS_MODEL_ID,
      voice: "sarah",
      noteId: "note-a",
    });
    await cache.get(keyA);
    await cache.put(keyC, bytes(), {
      model: TTS_MODEL_ID,
      voice: "sarah",
      noteId: "note-a",
    });
    await cache.put(keyD, bytes(), {
      model: TTS_MODEL_ID,
      voice: "sarah",
      noteId: "note-a",
    });

    expect(await cache.has(keyA)).toBe(true);
    expect(await cache.has(keyB)).toBe(false);
    expect(await cache.has(keyC)).toBe(true);
    expect(await cache.has(keyD)).toBe(true);
    expect((await cache.stats()).bytes).toBeLessThanOrEqual(30);
    await expect(stat(unrelated)).resolves.toBeTruthy();

    expect(await cache.clear()).toBe(3);
    await expect(stat(unrelated)).resolves.toBeTruthy();
    expect(await cache.stats()).toMatchObject({ entries: 0, bytes: 0 });
    expect(TTS_CACHE_MAX_BYTES).toBe(200 * 1024 * 1024);
  });

  it("keeps purge failures best-effort", async () => {
    await expect(
      purgeNoteTtsCacheBestEffort(
        {
          purgeNote: vi.fn().mockRejectedValue(new Error("disk failure")),
        },
        NOTE_ID,
      ),
    ).resolves.toBeUndefined();
    await expect(
      purgeNoteTtsCacheBestEffort(null, NOTE_ID),
    ).resolves.toBeUndefined();
  });

  it("exposes manual cache stats and clear through the cache route", async () => {
    const cache = createTtsCache({ directory });
    const key = cacheKey("Ahoj");
    await cache.put(key, bytes(), {
      model: TTS_MODEL_ID,
      voice: "sarah",
      noteId: NOTE_ID,
    });
    const handlers = createTtsCacheRouteHandlers({ cache });
    const statsResponse = await handlers.GET(request({ method: "GET" }));
    const statsBody = (await statsResponse.json()) as Record<string, unknown>;

    expect(statsResponse.status).toBe(200);
    expect(statsBody).toMatchObject({ entries: 1, bytes: 10 });

    const clearResponse = await handlers.POST(
      request({ body: { action: "clear" } }),
    );
    const clearBody = (await clearResponse.json()) as Record<string, unknown>;

    expect(clearResponse.status).toBe(200);
    expect(clearBody).toMatchObject({
      affected: 1,
      entries: 0,
      bytes: 0,
    });
  });
});

describe("P19 read-aloud route", () => {
  function route(options: {
    contentMd?: string;
    remainingUsd?: string;
  } = {}) {
    const cache = createTtsCache({ directory });
    const usage = fakeUsage(options.remainingUsd);
    const tts = fakeTts();
    const getNote = vi.fn(async () =>
      note(options.contentMd ?? "První odstavec.\n\nDruhý odstavec."),
    );
    const handler = createReadAloudRouteHandler({
      noteServiceFactory: () => ({ getNote }),
      ttsServiceFactory: () => tts,
      usageFactory: () => usage,
      cache,
      rateLimit: {
        ...DEFAULT_READ_ALOUD_RATE_LIMIT,
        limit: 100,
        key: "tts-cache-test",
        now: () => 1_000,
      },
    });

    return { handler, cache, usage, tts, getNote };
  }

  const selection = {
    noteId: NOTE_ID,
    scope: "full" as const,
    voice: "sarah",
  };

  it("returns a manifest without calling the provider, then serves a cache hit without a second call", async () => {
    const { handler, tts, cache } = route();
    const manifestResponse = await handler(
      request({ body: selection }),
    );
    const manifest = (await manifestResponse.json()) as {
      noteVersion: number;
      sourceHash: string;
      cacheHit: boolean;
      estimatedMaxCostUsd: string;
      sections: Array<{
        text: string;
        cached: boolean;
        cacheKey: string;
      }>;
    };

    expect(manifestResponse.status).toBe(200);
    expect(manifest.noteVersion).toBe(7);
    expect(manifest.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest.cacheHit).toBe(false);
    expect(manifest.estimatedMaxCostUsd).toBe("0.140000");
    expect(manifest.sections).toHaveLength(1);
    expect(manifest.sections[0]?.text).toBe(
      "První odstavec.\n\nDruhý odstavec.",
    );
    expect(manifest.sections[0]?.cached).toBe(false);
    expect(tts.synthesize).not.toHaveBeenCalled();

    const sectionBody = {
      ...selection,
      sectionIndex: 0,
      expectedSourceHash: manifest.sourceHash,
    };
    const missResponse = await handler(request({ body: sectionBody }));
    expect(missResponse.status).toBe(200);
    expect(missResponse.headers.get("content-type")).toBe("audio/mpeg");
    expect(missResponse.headers.get("x-tts-cache")).toBe("miss");
    expect(missResponse.headers.get("x-tts-note-version")).toBe("7");
    expect(new Uint8Array(await missResponse.arrayBuffer())).toEqual(
      mp3Bytes(),
    );
    expect(tts.synthesize).toHaveBeenCalledTimes(1);
    expect((await cache.stats()).entries).toBe(1);

    const hitResponse = await handler(request({ body: sectionBody }));
    expect(hitResponse.status).toBe(200);
    expect(hitResponse.headers.get("x-tts-cache")).toBe("hit");
    expect(tts.synthesize).toHaveBeenCalledTimes(1);

    const cachedManifestResponse = await handler(
      request({ body: selection }),
    );
    const cachedManifest = (await cachedManifestResponse.json()) as {
      cacheHit: boolean;
      estimatedMaxCostUsd: string;
      sections: Array<{ cached: boolean }>;
    };

    expect(cachedManifest.cacheHit).toBe(true);
    expect(cachedManifest.estimatedMaxCostUsd).toBe("0.000000");
    expect(cachedManifest.sections[0]?.cached).toBe(true);
  });

  it("rejects a stale source hash before any provider call", async () => {
    const { handler, tts } = route();
    const manifestResponse = await handler(request({ body: selection }));
    const manifest = (await manifestResponse.json()) as {
      sourceHash: string;
    };
    const response = await handler(
      request({
        body: {
          ...selection,
          sectionIndex: 0,
          expectedSourceHash: "0".repeat(64),
        },
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "tts_stale_source" },
    });
    expect(manifest.sourceHash).not.toBe("0".repeat(64));
    expect(tts.synthesize).not.toHaveBeenCalled();
  });

  it("preflights the whole missing chunk set before synthesizing", async () => {
    const { handler, tts } = route({
      contentMd: "a".repeat(4_000),
      remainingUsd: "0.100000",
    });
    const response = await handler(request({ body: selection }));

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "budget_exceeded" },
    });
    expect(tts.synthesize).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range section without a provider call", async () => {
    const { handler, tts } = route();
    const manifestResponse = await handler(request({ body: selection }));
    const manifest = (await manifestResponse.json()) as {
      sourceHash: string;
    };
    const response = await handler(
      request({
        body: {
          ...selection,
          sectionIndex: 5,
          expectedSourceHash: manifest.sourceHash,
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "tts_invalid_section" },
    });
    expect(tts.synthesize).not.toHaveBeenCalled();
  });

  it("requires the manifest source hash for section requests", async () => {
    const { handler, tts } = route();
    const response = await handler(
      request({ body: { ...selection, sectionIndex: 0 } }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_shape" },
    });
    expect(tts.synthesize).not.toHaveBeenCalled();
  });

  it("keeps direct P18 text requests working without touching the note or cache", async () => {
    const { handler, tts, getNote, cache } = route();
    const response = await handler(
      request({ body: { text: "Ahoj", voice: "sarah" } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(tts.synthesize).toHaveBeenCalledWith({
      text: "Ahoj",
      voice: "sarah",
    });
    expect(getNote).not.toHaveBeenCalled();
    expect((await cache.stats()).entries).toBe(0);
  });
});
