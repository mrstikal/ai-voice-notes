import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  MeetingMediaError,
  assertFfprobeAvailable,
  inspectMeetingAudio,
} from "../../src/lib/meetings/audio";
import {
  cleanupMedia,
  createSilentMatroskaOpus,
  createLiveWebmOpus,
  createSilentMp3,
  createSilentWav,
  createSilentWebmOpus,
  hasFfmpeg,
  type GeneratedMedia,
} from "../fixtures/media";

const generated: GeneratedMedia[] = [];
let scriptDirectory: string;

async function script(name: string, content: string): Promise<string> {
  const filePath = path.join(scriptDirectory, name);

  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);

  return filePath;
}

function minimalWavBuffer(): Buffer {
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8_000, 24);
  buffer.writeUInt32LE(16_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(0, 40);
  return buffer;
}

async function wavForFakeProbe(): Promise<string> {
  const filePath = path.join(scriptDirectory, "fake-input.wav");

  await writeFile(filePath, minimalWavBuffer());

  return filePath;
}

async function webmForFakeProbe(): Promise<string> {
  const filePath = path.join(scriptDirectory, "fake-input.webm");
  const header = Buffer.alloc(32);

  header[0] = 0x1a;
  header[1] = 0x45;
  header[2] = 0xdf;
  header[3] = 0xa3;
  header.write("webm", 16, "latin1");

  await writeFile(filePath, header);

  return filePath;
}

beforeAll(async () => {
  scriptDirectory = await mkdtemp(path.join(tmpdir(), "meeting-probe-"));
});

afterEach(async () => {
  while (generated.length > 0) {
    const item = generated.pop();

    if (item) {
      await cleanupMedia(item.directory);
    }
  }
});

afterAll(async () => {
  await rm(scriptDirectory, { recursive: true, force: true });
});

async function generate(
  factory: () => Promise<GeneratedMedia>,
): Promise<GeneratedMedia> {
  const item = await factory();

  generated.push(item);

  return item;
}

describe.skipIf(!hasFfmpeg())("P41B real media inspection", () => {
  it("accepts a short WAV and reports actual duration/type", async () => {
    const media = await generate(() => createSilentWav(1));
    const inspected = await inspectMeetingAudio(media.path, {
      maxDurationSeconds: 900,
    });

    expect(inspected.format).toBe("wav");
    expect(inspected.codec).toBe("pcm_s16le");
    expect(inspected.durationSeconds).toBeGreaterThan(0.9);
    expect(inspected.durationSeconds).toBeLessThan(1.2);
    expect(inspected.sizeBytes).toBeGreaterThan(44);
  });

  it("accepts a short MP3", async () => {
    const media = await generate(createSilentMp3);
    const inspected = await inspectMeetingAudio(media.path, {
      maxDurationSeconds: 900,
    });

    expect(inspected.format).toBe("mp3");
    expect(inspected.codec).toBe("mp3");
    expect(inspected.durationSeconds).toBeGreaterThan(0.9);
  });

  it("accepts a short WebM-Opus", async () => {
    const media = await generate(createSilentWebmOpus);
    const inspected = await inspectMeetingAudio(media.path, {
      maxDurationSeconds: 900,
    });

    expect(inspected.format).toBe("webm");
    expect(inspected.codec).toBe("opus");
    expect(inspected.durationSeconds).toBeGreaterThan(0.9);
  });

  it("derives a MediaRecorder-like headerless WebM duration from packet timestamps", async () => {
    const media = await generate(createLiveWebmOpus);
    const inspected = await inspectMeetingAudio(media.path, {
      maxDurationSeconds: 900,
    });

    expect(inspected.format).toBe("webm");
    expect(inspected.codec).toBe("opus");
    expect(inspected.durationSeconds).toBeGreaterThan(1.9);
    expect(inspected.durationSeconds).toBeLessThan(2.2);
  });

  it("rejects a 15-minute + 1 second WAV", async () => {
    const media = await generate(() => createSilentWav(901));

    await expect(
      inspectMeetingAudio(media.path, { maxDurationSeconds: 900 }),
    ).rejects.toMatchObject({ status: 422, code: "audio_too_long" });
  }, 20_000);

  it("rejects Matroska in a .mkv container and spoofed text", async () => {
    const matroska = await generate(createSilentMatroskaOpus);

    await expect(
      inspectMeetingAudio(matroska.path, { maxDurationSeconds: 900 }),
    ).rejects.toMatchObject({ status: 422, code: "invalid_media" });

    const fakePath = path.join(scriptDirectory, "spoofed.wav");

    await writeFile(fakePath, "not really audio");

    await expect(
      inspectMeetingAudio(fakePath, { maxDurationSeconds: 900 }),
    ).rejects.toMatchObject({ status: 422, code: "invalid_media" });
  });
});

describe("P41B ffprobe failure and parser paths", () => {
  it("reports missing ffprobe with the exact Czech instruction", async () => {
    await expect(
      assertFfprobeAvailable("/nonexistent/ffprobe"),
    ).rejects.toMatchObject({
      status: 503,
      code: "ffprobe_missing",
      message: "Chybí ffprobe: nainstalujte FFmpeg.",
    });

    const wav = await wavForFakeProbe();

    await expect(
      inspectMeetingAudio(wav, {
        ffprobePath: "/nonexistent/ffprobe",
        maxDurationSeconds: 900,
      }),
    ).rejects.toMatchObject({ code: "ffprobe_missing" });
  });

  it("reports a broken ffprobe binary", async () => {
    const broken = await script(
      "broken-ffprobe",
      "#!/bin/sh\nexit 1\n",
    );

    await expect(
      assertFfprobeAvailable(broken),
    ).rejects.toMatchObject({
      status: 503,
      code: "ffprobe_unavailable",
    });
  });

  it("reports a timed-out media probe", async () => {
    const slow = await script(
      "slow-ffprobe",
      '#!/bin/sh\ncase "$1" in -version) echo "ffprobe version fake"; exit 0;; esac\nexec sleep 5\n',
    );
    const wav = await wavForFakeProbe();

    await expect(
      inspectMeetingAudio(wav, {
        ffprobePath: slow,
        maxDurationSeconds: 900,
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ status: 504, code: "ffprobe_timeout" });
  });

  it("parses valid ffprobe JSON and rejects mismatched codecs", async () => {
    const valid = await script(
      "valid-ffprobe",
      '#!/bin/sh\ncase "$1" in -version) echo "ffprobe version fake"; exit 0;; esac\nprintf \'%s\' \'{"format":{"format_name":"wav","duration":"1.000000"},"streams":[{"codec_type":"audio","codec_name":"pcm_s16le","duration":"1.000000"}]}\'\n',
    );
    const mismatch = await script(
      "mismatch-ffprobe",
      '#!/bin/sh\ncase "$1" in -version) echo "ffprobe version fake"; exit 0;; esac\nprintf \'%s\' \'{"format":{"format_name":"wav","duration":"1.000000"},"streams":[{"codec_type":"audio","codec_name":"mp3","duration":"1.000000"}]}\'\n',
    );
    const wav = await wavForFakeProbe();

    await expect(
      inspectMeetingAudio(wav, {
        ffprobePath: valid,
        maxDurationSeconds: 900,
      }),
    ).resolves.toMatchObject({
      format: "wav",
      codec: "pcm_s16le",
      durationSeconds: 1,
    });

    await expect(
      inspectMeetingAudio(wav, {
        ffprobePath: mismatch,
        maxDurationSeconds: 900,
      }),
    ).rejects.toMatchObject({ status: 422, code: "invalid_media" });
  });

  it("derives a headerless WebM duration from packet timestamps", async () => {
    const fallback = await script(
      "packet-fallback-ffprobe",
      '#!/bin/sh\ncase "$*" in *"-version"*) echo "ffprobe version fake"; exit 0;; *"packet=pts_time"*) printf \'0.000000,0.020000\\n1.000000,0.020000\\n\'; exit 0;; esac\nprintf \'%s\' \'{"format":{"format_name":"matroska,webm","duration":"N/A"},"streams":[{"codec_type":"audio","codec_name":"opus","duration":"N/A"}]}\'\n',
    );
    const webm = await webmForFakeProbe();

    await expect(
      inspectMeetingAudio(webm, {
        ffprobePath: fallback,
        maxDurationSeconds: 900,
      }),
    ).resolves.toMatchObject({
      format: "webm",
      codec: "opus",
      durationSeconds: 1.02,
    });
  });

  it("rejects malformed JSON and an unknown duration", async () => {
    const malformed = await script(
      "malformed-ffprobe",
      '#!/bin/sh\ncase "$1" in -version) echo "ffprobe version fake"; exit 0;; esac\necho not-json\n',
    );
    const unknownDuration = await script(
      "unknown-duration-ffprobe",
      '#!/bin/sh\ncase "$1" in -version) echo "ffprobe version fake"; exit 0;; esac\nprintf \'%s\' \'{"format":{"format_name":"wav"},"streams":[{"codec_type":"audio","codec_name":"pcm_s16le"}]}\'\n',
    );
    const wav = await wavForFakeProbe();

    await expect(
      inspectMeetingAudio(wav, {
        ffprobePath: malformed,
        maxDurationSeconds: 900,
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: "ffprobe_invalid_output",
    });

    await expect(
      inspectMeetingAudio(wav, {
        ffprobePath: unknownDuration,
        maxDurationSeconds: 900,
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: "media_duration_unknown",
    });
  });

  it("rejects a media probe exit failure as invalid media", async () => {
    const failing = await script(
      "media-failure-ffprobe",
      '#!/bin/sh\ncase "$1" in -version) echo "ffprobe version fake"; exit 0;; esac\nexit 1\n',
    );
    const wav = await wavForFakeProbe();

    await expect(
      inspectMeetingAudio(wav, {
        ffprobePath: failing,
        maxDurationSeconds: 900,
      }),
    ).rejects.toBeInstanceOf(MeetingMediaError);
  });

  it("rejects missing, empty and oversized temp files before probing", async () => {
    await expect(
      inspectMeetingAudio(path.join(scriptDirectory, "missing.wav"), {
        maxDurationSeconds: 900,
      }),
    ).rejects.toMatchObject({ status: 400, code: "upload_missing" });

    const empty = path.join(scriptDirectory, "empty.wav");

    await writeFile(empty, "");

    await expect(
      inspectMeetingAudio(empty, { maxDurationSeconds: 900 }),
    ).rejects.toMatchObject({ status: 422, code: "invalid_media" });

    const wav = await wavForFakeProbe();

    await expect(
      inspectMeetingAudio(wav, {
        maxDurationSeconds: 900,
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ status: 413, code: "payload_too_large" });
  });
});
