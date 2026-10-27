import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { TTS_RESPONSE_FORMAT } from "./provider.ts";

export const TTS_CACHE_MAX_BYTES = 200 * 1024 * 1024;
export const TTS_CACHE_VERSION = 1;

const CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_SETTINGS = JSON.stringify({
  version: TTS_CACHE_VERSION,
  responseFormat: TTS_RESPONSE_FORMAT,
});

export class TtsCacheError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "TtsCacheError";
    this.status = status;
    this.code = code;
  }
}

export interface TtsCacheEntry {
  readonly key: string;
  readonly model: string;
  readonly voice: string;
  readonly bytes: number;
  readonly noteIds: readonly string[];
  readonly createdAt: string;
  readonly lastAccessedAt: string;
}

export interface TtsCacheStats {
  readonly entries: number;
  readonly bytes: number;
  readonly maxBytes: number;
}

export interface TtsCachePutOptions {
  readonly model: string;
  readonly voice: string;
  readonly noteId: string;
}

export interface TtsCacheOptions {
  readonly directory?: string;
  readonly maxBytes?: number;
  readonly now?: () => Date;
}

export interface TtsCache {
  get(key: string, noteId?: string): Promise<Uint8Array | null>;
  has(key: string): Promise<boolean>;
  put(
    key: string,
    bytes: Uint8Array,
    options: TtsCachePutOptions,
  ): Promise<void>;
  purgeNote(noteId: string): Promise<number>;
  purgeVoice(voice: string): Promise<number>;
  purgeModel(model: string): Promise<number>;
  clear(): Promise<number>;
  stats(): Promise<TtsCacheStats>;
}

interface CacheManifest {
  readonly version: typeof TTS_CACHE_VERSION;
  readonly entries: readonly TtsCacheEntry[];
}

export interface TtsCacheKeyOptions {
  readonly text: string;
  readonly model: string;
  readonly voice: string;
  readonly settings?: string;
}

export function ttsCacheKey(options: TtsCacheKeyOptions): string {
  const settings = options.settings ?? DEFAULT_SETTINGS;
  const settingsHash = createHash("sha256")
    .update(settings)
    .digest("hex");

  return createHash("sha256")
    .update(options.text)
    .update("\0")
    .update(options.model)
    .update("\0")
    .update(options.voice)
    .update("\0")
    .update(settingsHash)
    .digest("hex");
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isEntry(value: unknown): value is TtsCacheEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const entry = value as Record<string, unknown>;

  return (
    typeof entry.key === "string" &&
    CACHE_KEY_PATTERN.test(entry.key) &&
    typeof entry.model === "string" &&
    entry.model.length > 0 &&
    typeof entry.voice === "string" &&
    entry.voice.length > 0 &&
    Number.isSafeInteger(entry.bytes) &&
    (entry.bytes as number) >= 0 &&
    Array.isArray(entry.noteIds) &&
    entry.noteIds.every((noteId) => typeof noteId === "string") &&
    typeof entry.createdAt === "string" &&
    typeof entry.lastAccessedAt === "string"
  );
}

function assertKey(key: string): void {
  if (!CACHE_KEY_PATTERN.test(key)) {
    throw new TtsCacheError(
      400,
      "tts_invalid_cache_key",
      "Neplatný klíč cache čtení nahlas.",
    );
  }
}

function sortForPrune(
  left: TtsCacheEntry,
  right: TtsCacheEntry,
): number {
  return (
    left.lastAccessedAt.localeCompare(right.lastAccessedAt) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.key.localeCompare(right.key)
  );
}

export function createTtsCache(options: TtsCacheOptions = {}): TtsCache {
  const directory =
    options.directory ?? path.join(process.cwd(), ".data", "tts");
  const maxBytes = options.maxBytes ?? TTS_CACHE_MAX_BYTES;
  const now = options.now ?? (() => new Date());
  const manifestPath = path.join(directory, "manifest.json");
  let queue: Promise<void> = Promise.resolve();

  function withLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.then(operation, operation);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function entryPath(key: string): string {
    assertKey(key);
    return path.join(directory, `${key}.mp3`);
  }

  async function readManifest(): Promise<TtsCacheEntry[]> {
    let raw: string;

    try {
      raw = await readFile(manifestPath, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return [];
      }

      throw new TtsCacheError(
        500,
        "tts_cache_read_failed",
        "Manifest cache čtení nahlas se nepodařilo přečíst.",
      );
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== TTS_CACHE_VERSION ||
      !Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      return [];
    }

    return (parsed as CacheManifest).entries.filter(isEntry);
  }

  async function writeManifest(
    entries: readonly TtsCacheEntry[],
  ): Promise<void> {
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
    const manifest: CacheManifest = {
      version: TTS_CACHE_VERSION,
      entries,
    };

    try {
      await writeFile(temporaryPath, JSON.stringify(manifest), "utf8");
      await rename(temporaryPath, manifestPath);
    } catch {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new TtsCacheError(
        500,
        "tts_cache_write_failed",
        "Manifest cache čtení nahlas se nepodařilo zapsat.",
      );
    }
  }

  async function writeAudioFile(
    filePath: string,
    bytes: Uint8Array,
  ): Promise<void> {
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

    try {
      await writeFile(temporaryPath, bytes);
      await rename(temporaryPath, filePath);
    } catch {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new TtsCacheError(
        500,
        "tts_cache_write_failed",
        "Audio se nepodařilo uložit do cache čtení nahlas.",
      );
    }
  }

  async function fileExists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async function prune(entries: TtsCacheEntry[]): Promise<void> {
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);

    if (total <= maxBytes) {
      return;
    }

    const ordered = [...entries].sort(sortForPrune);

    for (const entry of ordered) {
      if (total <= maxBytes) {
        break;
      }

      try {
        await rm(entryPath(entry.key), { force: true });
      } catch {
        throw new TtsCacheError(
          500,
          "tts_cache_prune_failed",
          "Cache čtení nahlas se nepodařilo zmenšit.",
        );
      }

      total -= entry.bytes;
      const index = entries.findIndex((item) => item.key === entry.key);

      if (index >= 0) {
        entries.splice(index, 1);
      }
    }
  }

  async function get(
    key: string,
    noteId?: string,
  ): Promise<Uint8Array | null> {
    assertKey(key);
    const entries = await readManifest();
    const index = entries.findIndex((entry) => entry.key === key);

    if (index < 0) {
      return null;
    }

    let data: Buffer;

    try {
      data = await readFile(entryPath(key));
    } catch (error) {
      if (isEnoent(error)) {
        entries.splice(index, 1);
        await writeManifest(entries);
        return null;
      }

      throw new TtsCacheError(
        500,
        "tts_cache_read_failed",
        "Audio z cache čtení nahlas se nepodařilo přečíst.",
      );
    }

    const entry = entries[index]!;
    const noteIds =
      noteId !== undefined && !entry.noteIds.includes(noteId)
        ? [...entry.noteIds, noteId]
        : entry.noteIds;

    entries[index] = {
      ...entry,
      noteIds,
      lastAccessedAt: now().toISOString(),
    };
    await writeManifest(entries);

    return new Uint8Array(data);
  }

  async function has(key: string): Promise<boolean> {
    assertKey(key);
    const entries = await readManifest();
    const entry = entries.find((item) => item.key === key);

    if (!entry) {
      return false;
    }

    return fileExists(entryPath(key));
  }

  async function put(
    key: string,
    bytes: Uint8Array,
    putOptions: TtsCachePutOptions,
  ): Promise<void> {
    assertKey(key);

    if (bytes.byteLength === 0) {
      throw new TtsCacheError(
        400,
        "tts_empty_audio",
        "Prázdné audio nelze uložit do cache čtení nahlas.",
      );
    }

    if (
      putOptions.model.trim() === "" ||
      putOptions.voice.trim() === "" ||
      putOptions.noteId.trim() === ""
    ) {
      throw new TtsCacheError(
        400,
        "tts_invalid_cache_owner",
        "Cache čtení nahlas nemá platného vlastníka.",
      );
    }

    const entries = await readManifest();
    const index = entries.findIndex((entry) => entry.key === key);
    const timestamp = now().toISOString();

    if (index >= 0) {
      const entry = entries[index]!;
      const noteIds = entry.noteIds.includes(putOptions.noteId)
        ? entry.noteIds
        : [...entry.noteIds, putOptions.noteId];

      entries[index] = {
        ...entry,
        noteIds,
        lastAccessedAt: timestamp,
      };

      if (!(await fileExists(entryPath(key)))) {
        await writeAudioFile(entryPath(key), bytes);
      }
    } else {
      await writeAudioFile(entryPath(key), bytes);
      entries.push({
        key,
        model: putOptions.model,
        voice: putOptions.voice,
        bytes: bytes.byteLength,
        noteIds: [putOptions.noteId],
        createdAt: timestamp,
        lastAccessedAt: timestamp,
      });
    }

    await prune(entries);
    await writeManifest(entries);
  }

  async function purgeNote(noteId: string): Promise<number> {
    const entries = await readManifest();
    const next: TtsCacheEntry[] = [];
    let removed = 0;
    let changed = false;

    for (const entry of entries) {
      if (!entry.noteIds.includes(noteId)) {
        next.push(entry);
        continue;
      }

      const noteIds = entry.noteIds.filter((id) => id !== noteId);

      if (noteIds.length > 0) {
        next.push({ ...entry, noteIds });
        changed = true;
        continue;
      }

      try {
        await rm(entryPath(entry.key), { force: true });
      } catch {
        throw new TtsCacheError(
          500,
          "tts_cache_purge_failed",
          "Položku cache čtení nahlas se nepodařilo odstranit.",
        );
      }

      removed += 1;
    }

    if (removed > 0 || changed) {
      await writeManifest(next);
    }

    return removed;
  }

  async function purgeVoice(voice: string): Promise<number> {
    const entries = await readManifest();
    const next: TtsCacheEntry[] = [];
    let removed = 0;

    for (const entry of entries) {
      if (entry.voice !== voice) {
        next.push(entry);
        continue;
      }

      try {
        await rm(entryPath(entry.key), { force: true });
      } catch {
        throw new TtsCacheError(
          500,
          "tts_cache_purge_failed",
          "Položku cache čtení nahlas se nepodařilo odstranit.",
        );
      }

      removed += 1;
    }

    if (removed > 0) {
      await writeManifest(next);
    }

    return removed;
  }

  async function purgeModel(model: string): Promise<number> {
    const entries = await readManifest();
    const next: TtsCacheEntry[] = [];
    let removed = 0;

    for (const entry of entries) {
      if (entry.model !== model) {
        next.push(entry);
        continue;
      }

      try {
        await rm(entryPath(entry.key), { force: true });
      } catch {
        throw new TtsCacheError(
          500,
          "tts_cache_purge_failed",
          "Položku cache čtení nahlas se nepodařilo odstranit.",
        );
      }

      removed += 1;
    }

    if (removed > 0) {
      await writeManifest(next);
    }

    return removed;
  }

  async function clear(): Promise<number> {
    const entries = await readManifest();

    for (const entry of entries) {
      try {
        await rm(entryPath(entry.key), { force: true });
      } catch {
        throw new TtsCacheError(
          500,
          "tts_cache_clear_failed",
          "Cache čtení nahlas se nepodařilo vymazat.",
        );
      }
    }

    await writeManifest([]);
    return entries.length;
  }

  async function stats(): Promise<TtsCacheStats> {
    const entries = await readManifest();

    return {
      entries: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      maxBytes,
    };
  }

  return {
    get: (key, noteId) => withLock(() => get(key, noteId)),
    has: (key) => withLock(() => has(key)),
    put: (key, bytes, putOptions) =>
      withLock(() => put(key, bytes, putOptions)),
    purgeNote: (noteId) => withLock(() => purgeNote(noteId)),
    purgeVoice: (voice) => withLock(() => purgeVoice(voice)),
    purgeModel: (model) => withLock(() => purgeModel(model)),
    clear: () => withLock(() => clear()),
    stats: () => withLock(() => stats()),
  };
}

let defaultCache: TtsCache | null = null;

export function getTtsCache(): TtsCache {
  defaultCache ??= createTtsCache();
  return defaultCache;
}

export async function purgeNoteTtsCacheBestEffort(
  cache: Pick<TtsCache, "purgeNote"> | null | undefined,
  noteId: string,
): Promise<void> {
  if (!cache) {
    return;
  }

  try {
    await cache.purgeNote(noteId);
  } catch {
    return;
  }
}
