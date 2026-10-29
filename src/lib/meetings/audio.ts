import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { MEETING_AUDIO_MAX_BYTES } from "../security/http.ts";

export const MEETING_TEMP_PREFIX = "meeting-";
export const MEETING_TEMP_SUFFIX = ".bin";
export const MEETING_TEMP_MAX_AGE_MS = 60 * 60 * 1_000;
export const MEETING_TEMP_NAME_PATTERN =
  /^meeting-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$/u;

export const DEFAULT_MEETING_UPLOAD_DIR = path.join(
  process.cwd(),
  ".data",
  "uploads",
);

export class MeetingUploadError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "MeetingUploadError";
    this.status = status;
    this.code = code;
  }
}

export function isMeetingTempFilename(filename: string): boolean {
  return MEETING_TEMP_NAME_PATTERN.test(filename);
}

export async function cleanupExpiredMeetingUploads(
  directory: string = DEFAULT_MEETING_UPLOAD_DIR,
  now: number = Date.now(),
): Promise<void> {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !isMeetingTempFilename(entry.name)) {
      continue;
    }

    const filePath = path.join(directory, entry.name);

    try {
      const info = await lstat(filePath);

      if (now - info.mtimeMs > MEETING_TEMP_MAX_AGE_MS) {
        await unlink(filePath);
      }
    } catch {
      // Another inspect may have cleaned it; ignore.
    }
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;

  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
    );

    if (bytesWritten <= 0) {
      throw new MeetingUploadError(
        500,
        "upload_storage_failed",
        "Nahrávku se nepodařilo uložit do dočasného souboru.",
      );
    }

    offset += bytesWritten;
  }
}

export async function receiveMeetingAudioToTemp(
  request: Request,
  options: {
    readonly directory?: string;
    readonly maxBytes?: number;
  } = {},
): Promise<{ readonly path: string; readonly bytes: number }> {
  const directory = options.directory ?? DEFAULT_MEETING_UPLOAD_DIR;
  const maxBytes = options.maxBytes ?? MEETING_AUDIO_MAX_BYTES;

  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("Limit nahrávky musí být kladné celé číslo.");
  }

  const declaredLength = request.headers.get("content-length");

  if (declaredLength !== null) {
    const length = Number(declaredLength);

    if (!Number.isSafeInteger(length) || length < 0) {
      throw new MeetingUploadError(
        400,
        "invalid_content_length",
        "Neplatná délka nahrávky.",
      );
    }

    if (length > maxBytes) {
      throw new MeetingUploadError(
        413,
        "payload_too_large",
        `Nahrávka překračuje povolený limit ${maxBytes} bajtů.`,
      );
    }
  }

  if (!request.body) {
    throw new MeetingUploadError(
      400,
      "empty_upload",
      "Nahrávka je prázdná.",
    );
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  await cleanupExpiredMeetingUploads(directory);

  const filename = `${MEETING_TEMP_PREFIX}${randomUUID()}${MEETING_TEMP_SUFFIX}`;
  const filePath = path.join(directory, filename);
  let handle: Awaited<ReturnType<typeof open>>;

  try {
    handle = await open(filePath, "wx", 0o600);
  } catch {
    throw new MeetingUploadError(
      500,
      "upload_storage_failed",
      "Dočasný soubor pro nahrávku se nepodařilo vytvořit.",
    );
  }

  let total = 0;
  let succeeded = false;

  try {
    const reader = request.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        if (!value) {
          continue;
        }

        total += value.byteLength;

        if (total > maxBytes) {
          throw new MeetingUploadError(
            413,
            "payload_too_large",
            `Nahrávka překračuje povolený limit ${maxBytes} bajtů.`,
          );
        }

        await writeAll(handle, value);
      }
    } finally {
      reader.releaseLock();
    }

    if (total === 0) {
      throw new MeetingUploadError(
        400,
        "empty_upload",
        "Nahrávka je prázdná.",
      );
    }

    succeeded = true;

    return { path: filePath, bytes: total };
  } catch (error) {
    if (error instanceof MeetingUploadError) {
      throw error;
    }

    throw new MeetingUploadError(
      400,
      "upload_interrupted",
      "Nahrávku se nepodařilo přijmout. Zkuste to znovu.",
    );
  } finally {
    await handle.close().catch(() => undefined);

    if (!succeeded) {
      await unlink(filePath).catch(() => undefined);
    }
  }
}
