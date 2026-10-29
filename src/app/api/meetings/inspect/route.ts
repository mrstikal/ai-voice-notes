import { unlink } from "node:fs/promises";

import { loadConfig } from "@/lib/config";
import {
  MeetingUploadError,
  receiveMeetingAudioToTemp,
} from "@/lib/meetings/audio";
import {
  MEETING_AUDIO_MAX_BYTES,
  checkLocalHost,
  checkMutationOrigin,
  jsonError,
  jsonOk,
} from "@/lib/security/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function uploadErrorResponse(error: unknown): Response {
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

  const contentType =
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();

  if (contentType !== "application/octet-stream") {
    return jsonError(
      415,
      "invalid_content_type",
      "Nahrávka musí mít Content-Type application/octet-stream.",
    );
  }

  let received: Awaited<ReturnType<typeof receiveMeetingAudioToTemp>> | null =
    null;

  try {
    received = await receiveMeetingAudioToTemp(request, {
      maxBytes: MEETING_AUDIO_MAX_BYTES,
    });

    return jsonOk({
      bytes: received.bytes,
      inspection: "unverified",
      message: "Typ a délka dosud neověřeny",
    });
  } catch (error) {
    return uploadErrorResponse(error);
  } finally {
    if (received !== null) {
      await unlink(received.path).catch(() => undefined);
    }
  }
}
