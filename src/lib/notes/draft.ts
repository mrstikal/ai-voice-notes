import { publicEnvInt } from "../env-limits.ts";

export const DRAFT_AUTOSAVE_DEBOUNCE_MS = publicEnvInt(
  process.env.NEXT_PUBLIC_DRAFT_AUTOSAVE_DEBOUNCE_MS,
  "NEXT_PUBLIC_DRAFT_AUTOSAVE_DEBOUNCE_MS",
  800,
);

export const DRAFT_STORAGE_PREFIX = "note-draft:";

export interface StoredNoteDraft {
  readonly noteId: string;
  readonly baseVersion: number;
  readonly contentMd: string;
  readonly savedAt: string;
}

export type DraftSaveOutcome =
  | {
      readonly status: "saved";
      readonly version: number;
      readonly contentMd: string;
      readonly updatedAt: string;
    }
  | {
      readonly status: "conflict";
      readonly latestVersion: number;
      readonly message: string;
    }
  | { readonly status: "failed"; readonly message: string };

export type DraftAutosaveStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | {
      readonly kind: "saved";
      readonly version: number;
      readonly contentMd: string;
      readonly updatedAt: string;
    }
  | { readonly kind: "conflict"; readonly latestVersion: number; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

export interface DraftAutosaveOptions {
  readonly getContent: () => string | null;
  readonly save: (contentMd: string) => Promise<DraftSaveOutcome>;
  readonly onStatus: (status: DraftAutosaveStatus) => void;
  readonly debounceMs?: number;
}

export function draftStorageKey(noteId: string, baseVersion: number): string {
  return `${DRAFT_STORAGE_PREFIX}${noteId}:${baseVersion}`;
}

function defaultStorage(): Storage | null {
  try {
    if (typeof window === "undefined") {
      return null;
    }

    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function parseStoredDraft(raw: string, noteId: string): StoredNoteDraft | null {
  let parsed: Partial<StoredNoteDraft>;

  try {
    parsed = JSON.parse(raw) as Partial<StoredNoteDraft>;
  } catch {
    return null;
  }

  if (
    parsed.noteId !== noteId ||
    typeof parsed.contentMd !== "string" ||
    typeof parsed.baseVersion !== "number" ||
    !Number.isFinite(parsed.baseVersion)
  ) {
    return null;
  }

  return {
    noteId: parsed.noteId,
    baseVersion: parsed.baseVersion,
    contentMd: parsed.contentMd,
    savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "",
  };
}

export function readStoredDrafts(
  noteId: string,
  storage: Storage | null = defaultStorage(),
): StoredNoteDraft[] {
  if (!storage) {
    return [];
  }

  const prefix = `${DRAFT_STORAGE_PREFIX}${noteId}:`;
  const drafts: StoredNoteDraft[] = [];

  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);

      if (!key || !key.startsWith(prefix)) {
        continue;
      }

      const raw = storage.getItem(key);

      if (!raw) {
        continue;
      }

      const draft = parseStoredDraft(raw, noteId);

      if (draft) {
        drafts.push(draft);
      }
    }
  } catch {
    return drafts;
  }

  return drafts;
}

export function readStoredDraft(
  noteId: string,
  storage: Storage | null = defaultStorage(),
): StoredNoteDraft | null {
  const drafts = readStoredDrafts(noteId, storage);

  if (drafts.length === 0) {
    return null;
  }

  return (
    [...drafts].sort((left, right) =>
      right.savedAt.localeCompare(left.savedAt),
    )[0] ?? null
  );
}

export function writeStoredDraft(
  draft: StoredNoteDraft,
  storage: Storage | null = defaultStorage(),
): void {
  if (!storage) {
    return;
  }

  try {
    // Store the new recovery copy first. If the quota-sensitive write fails,
    // the previous draft must remain available instead of being deleted.
    storage.setItem(
      draftStorageKey(draft.noteId, draft.baseVersion),
      JSON.stringify(draft),
    );

    for (const existing of readStoredDrafts(draft.noteId, storage)) {
      if (existing.baseVersion !== draft.baseVersion) {
        storage.removeItem(
          draftStorageKey(existing.noteId, existing.baseVersion),
        );
      }
    }
  } catch {
    return;
  }
}

export function clearStoredDrafts(
  noteId: string,
  storage: Storage | null = defaultStorage(),
): void {
  if (!storage) {
    return;
  }

  try {
    for (const existing of readStoredDrafts(noteId, storage)) {
      storage.removeItem(draftStorageKey(existing.noteId, existing.baseVersion));
    }
  } catch {
    return;
  }
}

export function syncStoredDraft(params: {
  readonly noteId: string;
  readonly acknowledgedContentMd: string;
  readonly currentContentMd: string | null;
  readonly baseVersion: number;
  readonly storage?: Storage | null;
}): void {
  const storage =
    params.storage === undefined ? defaultStorage() : params.storage;

  if (params.currentContentMd === null) {
    // A visual serialization failure must not be treated as "matches saved".
    // Keep the stored recovery copy rather than clearing it.
    return;
  }

  if (params.currentContentMd !== params.acknowledgedContentMd) {
    writeStoredDraft(
      {
        noteId: params.noteId,
        baseVersion: params.baseVersion,
        contentMd: params.currentContentMd,
        savedAt: new Date().toISOString(),
      },
      storage,
    );
    return;
  }

  clearStoredDrafts(params.noteId, storage);
}

export class DraftAutosaveController {
  private readonly options: DraftAutosaveOptions;

  private readonly debounceMs: number;

  private timer: ReturnType<typeof setTimeout> | null = null;

  private running = false;

  private rerunRequested = false;

  private paused = false;

  private disposed = false;

  private idleResolvers: Array<() => void> = [];

  constructor(options: DraftAutosaveOptions) {
    this.options = options;
    this.debounceMs = options.debounceMs ?? DRAFT_AUTOSAVE_DEBOUNCE_MS;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isRunning(): boolean {
    return this.running;
  }

  notifyChange(): void {
    if (this.disposed || this.paused) {
      return;
    }

    this.schedule();
  }

  cancelPending(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  pause(): void {
    this.paused = true;
    this.cancelPending();
  }

  resume(): void {
    if (this.disposed) {
      return;
    }

    this.paused = false;
  }

  async waitForIdle(): Promise<void> {
    if (!this.running) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPending();
    this.resolveIdle();
  }

  private resolveIdle(): void {
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];

    for (const resolve of resolvers) {
      resolve();
    }
  }

  private schedule(): void {
    if (this.disposed || this.paused) {
      return;
    }

    this.cancelPending();

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, this.debounceMs);
  }

  private async run(): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (this.running) {
      this.rerunRequested = true;
      return;
    }

    const content = this.options.getContent();

    if (content === null) {
      return;
    }

    this.running = true;
    this.options.onStatus({ kind: "saving" });

    let outcome: DraftSaveOutcome;

    try {
      outcome = await this.options.save(content);
    } catch (error) {
      outcome = {
        status: "failed",
        message:
          error instanceof Error
            ? error.message
            : "Poznámku se nepodařilo uložit.",
      };
    }

    this.running = false;

    if (this.disposed) {
      this.resolveIdle();
      return;
    }

    if (outcome.status === "saved") {
      this.options.onStatus({
        kind: "saved",
        version: outcome.version,
        contentMd: outcome.contentMd,
        updatedAt: outcome.updatedAt,
      });
    } else if (outcome.status === "conflict") {
      this.pause();
      this.options.onStatus({
        kind: "conflict",
        latestVersion: outcome.latestVersion,
        message: outcome.message,
      });
    } else {
      this.options.onStatus({ kind: "failed", message: outcome.message });
    }

    if (this.rerunRequested) {
      this.rerunRequested = false;
      this.schedule();
    }

    this.resolveIdle();
  }
}
