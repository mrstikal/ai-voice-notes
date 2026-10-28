import { z } from "zod";

import { formatUsdAmount } from "../ai/usage-format.ts";
import { TTS_SCOPES, type TtsScope } from "./scopes.ts";

export interface TtsSelectionPayload {
  readonly scope: TtsScope;
  readonly start?: number;
  readonly end?: number;
  readonly paragraphIndex?: number;
  readonly listIndex?: number;
  readonly paragraphCount?: number;
}

export interface TtsManifestSection {
  readonly index: number;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly cacheKey: string;
  readonly cached: boolean;
}

export interface TtsManifest {
  readonly noteId: string;
  readonly noteVersion: number;
  readonly sourceHash: string;
  readonly voice: string;
  readonly model: string;
  readonly selection: TtsSelectionPayload;
  readonly cacheHit: boolean;
  readonly estimatedMaxCostUsd: string;
  readonly sections: readonly TtsManifestSection[];
}

const manifestSectionSchema = z
  .object({
    index: z.number().int().nonnegative(),
    text: z.string(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    cacheKey: z.string().min(1),
    cached: z.boolean(),
  })
  .strict();

const selectionSchema = z
  .object({
    scope: z.enum(TTS_SCOPES),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
    paragraphIndex: z.number().int().nonnegative().optional(),
    listIndex: z.number().int().nonnegative().optional(),
    paragraphCount: z.number().int().min(1).max(5).optional(),
  })
  .strict();

export const ttsManifestSchema = z
  .object({
    noteId: z.string().uuid(),
    noteVersion: z.number().int().positive(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    voice: z.string().min(1),
    model: z.string().min(1),
    selection: selectionSchema,
    cacheHit: z.boolean(),
    estimatedMaxCostUsd: z
      .string()
      .regex(/^\d+(?:\.\d{1,6})?$/u),
    sections: z.array(manifestSectionSchema).min(1),
  })
  .strict();

const ttsErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().optional(),
        message: z.string().optional(),
      })
      .loose(),
  })
  .loose();

export function buildManifestBody(
  noteId: string,
  voice: string,
  selection: TtsSelectionPayload,
): Record<string, unknown> {
  return {
    noteId,
    voice,
    scope: selection.scope,
    ...(selection.start === undefined ? {} : { start: selection.start }),
    ...(selection.end === undefined ? {} : { end: selection.end }),
    ...(selection.paragraphIndex === undefined
      ? {}
      : { paragraphIndex: selection.paragraphIndex }),
    ...(selection.listIndex === undefined
      ? {}
      : { listIndex: selection.listIndex }),
    ...(selection.paragraphCount === undefined
      ? {}
      : { paragraphCount: selection.paragraphCount }),
  };
}

export function buildSectionBody(
  manifest: TtsManifest,
  sectionIndex: number,
): Record<string, unknown> {
  return {
    ...buildManifestBody(manifest.noteId, manifest.voice, manifest.selection),
    sectionIndex,
    expectedSourceHash: manifest.sourceHash,
  };
}

export function formatTtsEstimatedCost(value: string): string {
  return formatUsdAmount(value);
}

export function formatTtsSectionText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export async function readTtsErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const parsed = ttsErrorSchema.safeParse(await response.json());

    if (parsed.success && parsed.data.error.message?.trim()) {
      return parsed.data.error.message;
    }
  } catch {
    return fallback;
  }

  return fallback;
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException
      ? error.name === "AbortError"
      : typeof error === "object" &&
        error !== null &&
        "name" in error &&
        (error as { name?: unknown }).name === "AbortError"
  );
}

export async function purgeTtsVoiceCacheBestEffort(
  fetchImpl: typeof fetch,
  voice: string,
): Promise<void> {
  try {
    await fetchImpl("/api/tts/cache", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "purge", voice }),
    });
  } catch {
    // Voice switching must keep working when the cache purge is unavailable.
  }
}
