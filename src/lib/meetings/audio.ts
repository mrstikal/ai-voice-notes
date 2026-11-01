import { execFile } from "node:child_process";
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
import { promisify } from "node:util";

import { MEETING_AUDIO_MAX_BYTES } from "../security/http.ts";

const execFileAsync = promisify(execFile);

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

export const MEETING_DEFAULT_MAX_DURATION_SECONDS = 15 * 60;
export const FFPROBE_TIMEOUT_MS = 5_000;
export const FFPROBE_VERSION_TIMEOUT_MS = 3_000;
export const FFPROBE_MAX_OUTPUT_BYTES = 1024 * 1024;
export const FFPROBE_PACKET_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MEETING_ALLOWED_FORMATS = ["mp3", "wav", "webm"] as const;

export type MeetingMediaFormat = (typeof MEETING_ALLOWED_FORMATS)[number];

export interface MeetingMediaInspection {
  readonly format: MeetingMediaFormat;
  readonly codec: string;
  readonly durationSeconds: number;
  readonly sizeBytes: number;
}

export class MeetingMediaError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MeetingMediaError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let ffprobeBinary = "ffprobe";

export function getFfprobeBinary(): string {
  return ffprobeBinary;
}

export function setFfprobeBinaryForTests(binary: string | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("FFprobe override lze nastavit pouze v NODE_ENV=test.");
  }

  ffprobeBinary = binary ?? "ffprobe";
}

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

interface FfprobeFormat {
  readonly format_name?: unknown;
  readonly duration?: unknown;
}

interface FfprobeStream {
  readonly codec_type?: unknown;
  readonly codec_name?: unknown;
  readonly duration?: unknown;
}

interface FfprobeJson {
  readonly format?: FfprobeFormat;
  readonly streams?: readonly FfprobeStream[];
}

function ffprobeFailure(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code;
  const killed = (error as { readonly killed?: boolean }).killed === true;

  if (code === "ENOENT") {
    throw new MeetingMediaError(
      503,
      "ffprobe_missing",
      "Chybí ffprobe: nainstalujte FFmpeg.",
    );
  }

  if (killed) {
    throw new MeetingMediaError(
      504,
      "ffprobe_timeout",
      "Kontrola média vypršela. Zkuste to znovu.",
    );
  }

  throw new MeetingMediaError(
    422,
    "invalid_media",
    "Soubor není platné podporované audio (MP3, WAV nebo WebM-Opus).",
  );
}

export async function assertFfprobeAvailable(
  binary: string = getFfprobeBinary(),
): Promise<void> {
  try {
    await execFileAsync(binary, ["-version"], {
      timeout: FFPROBE_VERSION_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const killed = (error as { readonly killed?: boolean }).killed === true;

    if (code === "ENOENT") {
      throw new MeetingMediaError(
        503,
        "ffprobe_missing",
        "Chybí ffprobe: nainstalujte FFmpeg.",
      );
    }

    if (killed) {
      throw new MeetingMediaError(
        503,
        "ffprobe_unavailable",
        "FFprobe neodpovídá. Zkontrolujte instalaci FFmpeg.",
      );
    }

    throw new MeetingMediaError(
      503,
      "ffprobe_unavailable",
      "FFprobe není dostupný. Zkontrolujte instalaci FFmpeg.",
    );
  }
}

function ebmlVintLength(firstByte: number): number | null {
  if (firstByte === 0) {
    return null;
  }

  let mask = 0x80;
  let length = 1;

  while ((firstByte & mask) === 0) {
    mask >>= 1;
    length += 1;
  }

  return length <= 8 ? length : null;
}

function readEbmlVint(
  buffer: Buffer,
  offset: number,
  keepMarker: boolean,
): { readonly value: number; readonly length: number } | null {
  const first = buffer[offset];

  if (first === undefined) {
    return null;
  }

  const length = ebmlVintLength(first);

  if (length === null || offset + length > buffer.length) {
    return null;
  }

  let value = keepMarker ? first : first & ((1 << (8 - length)) - 1);

  for (let index = 1; index < length; index += 1) {
    value = value * 256 + buffer[offset + index]!;
  }

  return { length, value };
}

function readEbmlDocType(header: Buffer): string | null {
  if (
    header.length < 4 ||
    header[0] !== 0x1a ||
    header[1] !== 0x45 ||
    header[2] !== 0xdf ||
    header[3] !== 0xa3
  ) {
    return null;
  }

  const headerSize = readEbmlVint(header, 4, false);

  if (headerSize === null) {
    return null;
  }

  let offset = 4 + headerSize.length;
  const headerEnd = Math.min(header.length, offset + headerSize.value);

  while (offset < headerEnd) {
    const elementId = readEbmlVint(header, offset, true);

    if (elementId === null) {
      return null;
    }

    offset += elementId.length;
    const elementSize = readEbmlVint(header, offset, false);

    if (elementSize === null) {
      return null;
    }

    offset += elementSize.length;
    const dataEnd = offset + elementSize.value;

    if (dataEnd > headerEnd || dataEnd > header.length) {
      return null;
    }

    if (elementId.value === 0x4282) {
      return header
        .subarray(offset, dataEnd)
        .toString("ascii")
        .replace(/\0+$/u, "");
    }

    offset = dataEnd;
  }

  return null;
}

async function readMagicFormat(
  filePath: string,
): Promise<MeetingMediaFormat | null> {
  let handle: Awaited<ReturnType<typeof open>>;

  try {
    handle = await open(filePath, "r");
  } catch {
    throw new MeetingMediaError(
      400,
      "upload_missing",
      "Dočasný soubor nahrávky nebyl nalezen.",
    );
  }

  try {
    const buffer = Buffer.alloc(1_024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead);

    if (
      header.length >= 12 &&
      (header.subarray(0, 4).toString("ascii") === "RIFF" ||
        header.subarray(0, 4).toString("ascii") === "RF64") &&
      header.subarray(8, 12).toString("ascii") === "WAVE"
    ) {
      return "wav";
    }

    if (
      header.length >= 4 &&
      header[0] === 0x1a &&
      header[1] === 0x45 &&
      header[2] === 0xdf &&
      header[3] === 0xa3
    ) {
      // An EBML Void element may contain arbitrary text such as "webm".
      // Only the actual DocType identifies a WebM container.
      return readEbmlDocType(header) === "webm" ? "webm" : null;
    }

    if (
      header.length >= 3 &&
      header.subarray(0, 3).toString("ascii") === "ID3"
    ) {
      return "mp3";
    }

    if (
      header.length >= 2 &&
      header[0] === 0xff &&
      (header[1]! & 0xe0) === 0xe0
    ) {
      return "mp3";
    }

    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function reportedDuration(parsed: FfprobeJson): number | null {
  const formatDuration =
    typeof parsed.format?.duration === "string" ||
    typeof parsed.format?.duration === "number"
      ? Number(parsed.format.duration)
      : Number.NaN;

  if (Number.isFinite(formatDuration) && formatDuration > 0) {
    return formatDuration;
  }

  const audio = parsed.streams?.find(
    (stream) => stream.codec_type === "audio",
  );
  const audioDuration =
    typeof audio?.duration === "string" || typeof audio?.duration === "number"
      ? Number(audio.duration)
      : Number.NaN;

  return Number.isFinite(audioDuration) && audioDuration > 0
    ? audioDuration
    : null;
}

async function probePacketDuration(
  filePath: string,
  ffprobePath: string,
  timeoutMs: number,
): Promise<number | null> {
  let stdout: string;

  try {
    const result = await execFileAsync(
      ffprobePath,
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "packet=pts_time,duration_time",
        "-of",
        "csv=p=0",
        filePath,
      ],
      {
        timeout: timeoutMs,
        maxBuffer: FFPROBE_PACKET_MAX_OUTPUT_BYTES,
        encoding: "utf8",
      },
    );

    stdout = result.stdout;
  } catch {
    return null;
  }

  let duration = 0;

  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim() === "") {
      continue;
    }

    const [ptsRaw, packetDurationRaw] = line.split(",");
    const pts = Number(ptsRaw);
    const packetDuration = Number(packetDurationRaw);

    if (!Number.isFinite(pts) || pts < 0) {
      continue;
    }

    const end =
      pts +
      (Number.isFinite(packetDuration) && packetDuration > 0
        ? packetDuration
        : 0);

    if (end > duration) {
      duration = end;
    }
  }

  return duration > 0 ? duration : null;
}

function validateFfprobeOutput(
  parsed: FfprobeJson,
  format: MeetingMediaFormat,
  maxDurationSeconds: number,
  fallbackDuration: number | null,
): { readonly codec: string; readonly durationSeconds: number } {
  const formatName =
    typeof parsed.format?.format_name === "string"
      ? parsed.format.format_name.toLowerCase()
      : "";
  const audioStream = parsed.streams?.find(
    (stream) => stream.codec_type === "audio",
  );
  const codec =
    typeof audioStream?.codec_name === "string"
      ? audioStream.codec_name.toLowerCase()
      : "";

  if (audioStream === undefined || codec === "") {
    throw new MeetingMediaError(
      422,
      "invalid_media",
      "Soubor neobsahuje podporovanou zvukovou stopu.",
    );
  }

  const formatMatches =
    format === "wav"
      ? (formatName.includes("wav") || formatName.includes("rf64")) &&
        codec.startsWith("pcm_")
      : format === "mp3"
        ? formatName.includes("mp3") &&
          (codec === "mp3" || codec === "mp3float")
        : formatName.includes("webm") && codec === "opus";

  if (!formatMatches) {
    throw new MeetingMediaError(
      422,
      "invalid_media",
      "Soubor neodpovídá povolenému formátu MP3, WAV nebo WebM-Opus.",
      { format, codec },
    );
  }

  const durationSeconds = reportedDuration(parsed) ?? fallbackDuration;

  if (durationSeconds === null) {
    throw new MeetingMediaError(
      422,
      "media_duration_unknown",
      "Délku nahrávky se nepodařilo zjistit. Nahrávka byla odmítnuta.",
    );
  }

  if (durationSeconds > maxDurationSeconds + 1e-6) {
    throw new MeetingMediaError(
      422,
      "audio_too_long",
      `Nahrávka je delší než ${Math.round(maxDurationSeconds / 60)} minut.`,
      { durationSeconds, maxDurationSeconds },
    );
  }

  return { codec, durationSeconds };
}

export async function inspectMeetingAudio(
  filePath: string,
  options: {
    readonly ffprobePath?: string;
    readonly maxDurationSeconds?: number;
    readonly maxBytes?: number;
    readonly timeoutMs?: number;
  } = {},
): Promise<MeetingMediaInspection> {
  const maxDurationSeconds =
    options.maxDurationSeconds ?? MEETING_DEFAULT_MAX_DURATION_SECONDS;
  const maxBytes = options.maxBytes ?? MEETING_AUDIO_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? FFPROBE_TIMEOUT_MS;
  const ffprobePath = options.ffprobePath ?? getFfprobeBinary();

  let info;

  try {
    info = await lstat(filePath);
  } catch {
    throw new MeetingMediaError(
      400,
      "upload_missing",
      "Dočasný soubor nahrávky nebyl nalezen.",
    );
  }

  if (!info.isFile() || info.size <= 0) {
    throw new MeetingMediaError(
      422,
      "invalid_media",
      "Nahrávka je prázdná nebo není soubor.",
    );
  }

  if (info.size > maxBytes) {
    throw new MeetingMediaError(
      413,
      "payload_too_large",
      `Nahrávka překračuje povolený limit ${maxBytes} bajtů.`,
    );
  }

  const format = await readMagicFormat(filePath);

  if (format === null) {
    throw new MeetingMediaError(
      422,
      "invalid_media",
      "Soubor není podporované audio (MP3, WAV nebo WebM-Opus).",
    );
  }

  await assertFfprobeAvailable(ffprobePath);

  let stdout: string;

  try {
    const result = await execFileAsync(
      ffprobePath,
      [
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        filePath,
      ],
      {
        timeout: timeoutMs,
        maxBuffer: FFPROBE_MAX_OUTPUT_BYTES,
        encoding: "utf8",
      },
    );

    stdout = result.stdout;
  } catch (error) {
    ffprobeFailure(error);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new MeetingMediaError(
      422,
      "ffprobe_invalid_output",
      "FFprobe nevrátil čitelná metadata média.",
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as FfprobeJson).streams)
  ) {
    throw new MeetingMediaError(
      422,
      "ffprobe_invalid_output",
      "FFprobe nevrátil očekávaná metadata média.",
    );
  }

  const parsedJson = parsed as FfprobeJson;
  const fallbackDuration =
    reportedDuration(parsedJson) === null
      ? await probePacketDuration(filePath, ffprobePath, timeoutMs)
      : null;
  const validated = validateFfprobeOutput(
    parsedJson,
    format,
    maxDurationSeconds,
    fallbackDuration,
  );

  return {
    format,
    codec: validated.codec,
    durationSeconds: validated.durationSeconds,
    sizeBytes: info.size,
  };
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

  try {
    await chmod(directory, 0o700);
  } catch {
    throw new MeetingUploadError(
      500,
      "upload_directory_permissions",
      "Nepodařilo se zajistit privátní oprávnění složky pro nahrávku. Nahrávka nebyla přijata.",
    );
  }

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
