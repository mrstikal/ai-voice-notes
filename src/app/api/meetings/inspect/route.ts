import { unlink } from "node:fs/promises";

import { loadConfig } from "@/lib/config";
import {
  MeetingMediaError,
  MeetingUploadError,
  assertFfprobeAvailable,
  inspectMeetingAudio,
  receiveMeetingAudioToTemp,
} from "@/lib/meetings/audio";
import {
  MEETING_AUDIO_MAX_BYTES,
  checkLocalHost,
  checkMutationOrigin,
  createRateLimiter,
  jsonError,
  jsonOk,
} from "@/lib/security/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const MEETING_INSPECT_RATE_LIMIT = {
  limit: 10,
  windowMs: 60_000,
  key: "meeting-inspect",
} as const;

const inspectLimiter = createRateLimiter(MEETING_INSPECT_RATE_LIMIT);

function uploadErrorResponse(error: unknown): Response {
  if (error instanceof MeetingMediaError) {
    return jsonError(
      error.status,
      error.code,
      error.message,
      undefined,
      error.details,
    );
  }

  if (error instanceof MeetingUploadError) {
    return jsonError(error.status, error.code, error.message);
  }

  return jsonError(
    500,
    "meeting_inspect_failed",
    "Nahrávku se nepodařilo zpracovat.",
  );
}

export async function POST(request: Request): Promise<Response> {
  let config;

  try {
    config = loadConfig();
  } catch {
    return jsonError(
      500,
      "invalid_config",
      "Konfigurace aplikace není platná.",
    );
  }

  const hostError = checkLocalHost(
    request,
    config.appOrigin,
    config.allowForwardedLoopback,
  );

  if (hostError) {
    return hostError;
  }

  const originError = checkMutationOrigin(
    request,
    config.appOrigin,
    config.allowForwardedLoopback,
  );

  if (originError) {
    return originError;
  }

  const decision = inspectLimiter.check(MEETING_INSPECT_RATE_LIMIT.key);

  if (!decision.allowed) {
    return jsonError(
      429,
      "rate_limited",
      "Příliš mnoho požadavků na kontrolu nahrávky. Zkuste to znovu později.",
      { "Retry-After": String(decision.retryAfterSeconds) },
    );
  }

  const contentType =
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();

  if (contentType !== "application/octet-stream") {
    return jsonError(
      415,
      "invalid_content_type",
      "Nahrávka musí mít Content-Type application/octet-stream.",
    );
  }

  try {
    await assertFfprobeAvailable();
  } catch (error) {
    return uploadErrorResponse(error);
  }

  let received: Awaited<ReturnType<typeof receiveMeetingAudioToTemp>> | null =
    null;

  try {
    received = await receiveMeetingAudioToTemp(request, {
      maxBytes: MEETING_AUDIO_MAX_BYTES,
    });
    const inspected = await inspectMeetingAudio(received.path, {
      maxDurationSeconds: config.meetingMaxMinutes * 60,
      maxBytes: MEETING_AUDIO_MAX_BYTES,
    });

    return jsonOk({
      bytes: inspected.sizeBytes,
      format: inspected.format,
      codec: inspected.codec,
      durationSeconds: inspected.durationSeconds,
      inspection: "validated",
      message: "Typ a délka ověřeny",
    });
  } catch (error) {
    return uploadErrorResponse(error);
  } finally {
    if (received !== null) {
      await unlink(received.path).catch(() => undefined);
    }
  }
}
