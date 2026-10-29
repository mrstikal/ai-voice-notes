import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface GeneratedMedia {
  readonly directory: string;
  readonly path: string;
}

export function hasFfmpeg(): boolean {
  return (
    spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 &&
    spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0
  );
}

async function createDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "meeting-media-"));
}

function runFfmpeg(args: readonly string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

export async function createSilentWav(
  durationSeconds: number,
): Promise<GeneratedMedia> {
  const directory = await createDirectory();
  const filePath = path.join(directory, `silent-${durationSeconds}.wav`);

  runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=8000:cl=mono",
    "-t",
    String(durationSeconds),
    "-c:a",
    "pcm_s16le",
    filePath,
  ]);

  return { directory, path: filePath };
}

export async function createSilentMp3(): Promise<GeneratedMedia> {
  const directory = await createDirectory();
  const filePath = path.join(directory, "silent.mp3");

  runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=8000:cl=mono",
    "-t",
    "1",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "32k",
    filePath,
  ]);

  return { directory, path: filePath };
}

export async function createSilentWebmOpus(): Promise<GeneratedMedia> {
  const directory = await createDirectory();
  const filePath = path.join(directory, "silent.webm");

  runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono",
    "-t",
    "1",
    "-c:a",
    "libopus",
    "-b:a",
    "24k",
    filePath,
  ]);

  return { directory, path: filePath };
}

export async function createLiveWebmOpus(): Promise<GeneratedMedia> {
  const directory = await createDirectory();
  const filePath = path.join(directory, "live.webm");

  runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono",
    "-t",
    "2",
    "-c:a",
    "libopus",
    "-b:a",
    "24k",
    "-f",
    "webm",
    "-live",
    "1",
    filePath,
  ]);

  return { directory, path: filePath };
}

export async function createSilentMatroskaOpus(): Promise<GeneratedMedia> {
  const directory = await createDirectory();
  const filePath = path.join(directory, "silent.mkv");

  runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono",
    "-t",
    "1",
    "-c:a",
    "libopus",
    "-b:a",
    "24k",
    filePath,
  ]);

  return { directory, path: filePath };
}

export async function cleanupMedia(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
