import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as inspectRoute } from "@/app/api/meetings/inspect/route";
import {
  MEETING_AUDIO_MAX_BYTES,
} from "@/lib/security/http";
import {
  DEFAULT_MEETING_UPLOAD_DIR,
  MeetingUploadError,
  MEETING_TEMP_MAX_AGE_MS,
  cleanupExpiredMeetingUploads,
  receiveMeetingAudioToTemp,
} from "@/lib/meetings/audio";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "meeting-upload-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function request(
  body: BodyInit | ReadableStream<Uint8Array> | null,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://127.0.0.1:3000/api/meetings/inspect", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "content-type": "application/octet-stream",
      ...headers,
    },
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

async function meetingFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.startsWith("meeting-"));
  } catch {
    return [];
  }
}

describe("P41 meeting upload", () => {
  it("streams exactly the limit to a private temp file and returns byte count", async () => {
    const received = await receiveMeetingAudioToTemp(
      request(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
      { directory, maxBytes: 8 },
    );

    expect(received.bytes).toBe(8);
    expect(path.dirname(received.path)).toBe(directory);
    expect(path.basename(received.path)).toMatch(
      /^meeting-[0-9a-f-]{36}\.bin$/u,
    );
    expect(await readFile(received.path)).toEqual(
      Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    );

    const info = await stat(received.path);

    expect(info.mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it("rejects one byte over the limit and leaves no temp file", async () => {
    await expect(
      receiveMeetingAudioToTemp(
        request(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])),
        { directory, maxBytes: 8 },
      ),
    ).rejects.toMatchObject({ status: 413, code: "payload_too_large" });

    expect(await meetingFiles(directory)).toEqual([]);
  });

  it("rejects 25 MiB + 1 streamed bytes and leaves no temp file", async () => {
    const chunk = new Uint8Array(1_048_576);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 26; index += 1) {
          controller.enqueue(chunk);
        }

        controller.close();
      },
    });

    await expect(
      receiveMeetingAudioToTemp(request(stream), { directory }),
    ).rejects.toMatchObject({ status: 413, code: "payload_too_large" });

    expect(await meetingFiles(directory)).toEqual([]);
    expect(MEETING_AUDIO_MAX_BYTES).toBe(25 * 1024 * 1024);
  });

  it("rejects an oversized declared Content-Length before writing", async () => {
    await expect(
      receiveMeetingAudioToTemp(
        request(new Uint8Array([1]), {
          "content-length": String(9),
        }),
        { directory, maxBytes: 8 },
      ),
    ).rejects.toMatchObject({ status: 413, code: "payload_too_large" });

    expect(await meetingFiles(directory)).toEqual([]);
  });

  it("rejects an invalid Content-Length and an empty upload", async () => {
    await expect(
      receiveMeetingAudioToTemp(
        request(new Uint8Array([1]), { "content-length": "-1" }),
        { directory, maxBytes: 8 },
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_content_length" });

    await expect(
      receiveMeetingAudioToTemp(request(null), { directory, maxBytes: 8 }),
    ).rejects.toMatchObject({ status: 400, code: "empty_upload" });
  });

  it("unlinks its temp file when the stream is interrupted", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("client disconnected"));
      },
    });

    await expect(
      receiveMeetingAudioToTemp(request(stream), {
        directory,
        maxBytes: 8,
      }),
    ).rejects.toMatchObject({ status: 400, code: "upload_interrupted" });

    expect(await meetingFiles(directory)).toEqual([]);
  });

  it("removes only its own expired temp filenames", async () => {
    const oldName = "meeting-11111111-1111-4111-8111-111111111111.bin";
    const freshName = "meeting-22222222-2222-4222-8222-222222222222.bin";
    const foreignName = "keep-me.bin";

    await writeFile(path.join(directory, oldName), "old");
    await writeFile(path.join(directory, freshName), "fresh");
    await writeFile(path.join(directory, foreignName), "foreign");

    const old = new Date(Date.now() - MEETING_TEMP_MAX_AGE_MS - 60_000);
    await utimes(path.join(directory, oldName), old, old);

    await cleanupExpiredMeetingUploads(directory);

    const names = await readdir(directory);

    expect(names).not.toContain(oldName);
    expect(names).toContain(freshName);
    expect(names).toContain(foreignName);
  });

  it("rejects wrong Origin and wrong content type without writing", async () => {
    const wrongOrigin = request(new Uint8Array([1, 2, 3]), {
      origin: "http://evil.example",
    });
    const originResponse = await inspectRoute(wrongOrigin);

    expect(originResponse.status).toBe(403);

    const wrongType = request(new Uint8Array([1, 2, 3]), {
      "content-type": "audio/webm",
    });
    const typeResponse = await inspectRoute(wrongType);

    expect(typeResponse.status).toBe(415);
  });

  it("rejects malformed media after streaming and deletes the temp file", async () => {
    const before = await meetingFiles(DEFAULT_MEETING_UPLOAD_DIR);
    const response = await inspectRoute(request(new Uint8Array([1, 2, 3])));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_media" },
    });
    expect(await meetingFiles(DEFAULT_MEETING_UPLOAD_DIR)).toEqual(before);
  });

  it("exposes typed upload errors without a file path", async () => {
    const error = new MeetingUploadError(413, "payload_too_large", "Příliš velké.");

    expect(error.status).toBe(413);
    expect(error.message).not.toContain(directory);
  });
});
