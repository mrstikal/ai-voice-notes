import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  OpenRouterHttpError,
  getOpenRouterTransport,
  setOpenRouterTransportForTests,
} from "../../src/lib/ai/openrouter";
import { loadConfig } from "../../src/lib/config";
import { receiveMeetingAudioToTemp } from "../../src/lib/meetings/audio";
import { estimateMeetingTranscriptionMaxCostUsd } from "../../src/lib/meetings/transcribe";
import { buildDownloadContentDisposition } from "../../src/lib/notes/export-filename";
import { parseNoteMarkdown } from "../../src/lib/notes/markdown";
import { buildSearchSnippet } from "../../src/lib/search/fts";
import {
  checkLocalHost,
  checkMutationOrigin,
} from "../../src/lib/security/http";

const ROOT = process.cwd();
const SOURCE_ROOT = path.join(ROOT, "src");
const SECRET_NAMES =
  /ELEVENLABS_API_KEY|OPENROUTER_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY/u;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(fullPath)));
    } else if (/\.(?:ts|tsx)$/u.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

function requestWith(
  headers: Record<string, string>,
): Request {
  return new Request("http://127.0.0.1:3000/api/test", {
    method: "POST",
    headers,
  });
}

describe("P44 privacy and offline audit", () => {
  it("keeps long-lived keys, raw HTML injection and prompt logs out of client code", async () => {
    const files = await sourceFiles(SOURCE_ROOT);

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const relative = path.relative(ROOT, file);

      expect(source, `${relative} must not use dangerouslySetInnerHTML`).not.toContain(
        "dangerouslySetInnerHTML",
      );

      const clientSurface =
        relative.startsWith(`src${path.sep}components`) ||
        source.includes('"use client"') ||
        source.includes("'use client'");

      if (clientSurface) {
        expect(source, `${relative} must not reference server provider keys`).not.toMatch(
          SECRET_NAMES,
        );
        expect(source, `${relative} must not import server config`).not.toMatch(
          /(?:from|import)\s+["'][^"']*\/config(?:\.ts)?["']/u,
        );
        expect(source, `${relative} must not use NEXT_PUBLIC secrets`).not.toContain(
          "NEXT_PUBLIC_",
        );
      }

      for (const line of source.split("\n").filter((candidate) =>
        candidate.includes("console."),
      )) {
        expect(
          line,
          `${relative} must not log a provider key, note body or prompt`,
        ).not.toMatch(
          /apiKey|API_KEY|contentMd|contentPlain|transcript|prompt|noteBody/u,
        );
      }
    }
  });

  it("keeps typed notes, Markdown and full-text search independent of provider clients", async () => {
    for (const relative of [
      "src/lib/notes/service.ts",
      "src/lib/notes/markdown.ts",
      "src/lib/notes/export-docx.ts",
      "src/lib/search/fts.ts",
    ]) {
      const source = await readFile(path.join(ROOT, relative), "utf8");

      expect(source, `${relative} must stay offline`).not.toMatch(
        /openrouter|elevenlabs|openai|gemini/iu,
      );
    }

    const config = loadConfig({}, "22.19.0");

    expect(config.elevenLabsApiKey).toBeNull();
    expect(config.openRouterApiKey).toBeNull();
    expect(config.openAiApiKey).toBeNull();
    expect(config.geminiApiKey).toBeNull();
    expect(config.aiRequestBudgetUsd).toBe(2);
    expect(estimateMeetingTranscriptionMaxCostUsd(15)).toBeLessThanOrEqual(
      config.aiRequestBudgetUsd,
    );
  });

  it("fails closed on unmocked OpenRouter egress even with padded test mode", () => {
    setOpenRouterTransportForTests(null);

    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("AI_TEST_MODE", " 1 ");

      expect(() => getOpenRouterTransport()).toThrowError(OpenRouterHttpError);
      expect(() => getOpenRouterTransport()).toThrow(/unmocked|testovacím/iu);
    } finally {
      vi.unstubAllEnvs();
      setOpenRouterTransportForTests(null);
    }
  });

  it("keeps unsafe Markdown source-only and search snippets as plain text", () => {
    const rawHtml = parseNoteMarkdown(
      "# Nadpis\n\n<script>alert('xss')</script>",
    );
    const unsafeLink = parseNoteMarkdown("[odkaz](javascript:alert(1))");
    const snippet = buildSearchSnippet(
      "<img src=x onerror=alert(1)> databáze",
      "img",
    );

    expect(rawHtml.sourceOnly).toBe(true);
    expect(unsafeLink.sourceOnly).toBe(true);
    expect(snippet).toContain("<");
    expect(snippet).toContain("onerror=alert(1)");
    expect(snippet).toContain("[[[img]]]");
  });

  it("rejects cross-origin and non-loopback mutations before any side effect", () => {
    const appOrigin = "http://127.0.0.1:3000";
    const crossOrigin = requestWith({
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3999",
    });
    const badHost = requestWith({
      host: "evil.example",
      origin: appOrigin,
    });

    expect(checkLocalHost(badHost, appOrigin, false)?.status).toBe(403);
    expect(checkMutationOrigin(crossOrigin, appOrigin, false)?.status).toBe(403);
    expect(
      checkMutationOrigin(
        requestWith({ host: "127.0.0.1:3000", origin: appOrigin }),
        appOrigin,
        false,
      ),
    ).toBeNull();
  });

  it("writes launch audio 0600 in a 0700 directory and leaves no file on rejection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "p44-privacy-"));
    const directory = path.join(root, "uploads");
    await mkdir(directory, { recursive: true, mode: 0o777 });
    await chmod(directory, 0o777);

    try {
      const accepted = await receiveMeetingAudioToTemp(
        new Request("http://127.0.0.1:3000/api/meetings/transcribe", {
          method: "POST",
          headers: { "content-length": "64" },
          body: new Uint8Array(64),
        }),
        { directory, maxBytes: 64 },
      );
      const fileStat = await stat(accepted.path);
      const directoryStat = await stat(directory);

      expect(fileStat.mode & 0o777).toBe(0o600);
      expect(directoryStat.mode & 0o777).toBe(0o700);

      await unlink(accepted.path);
      expect(await readdir(directory)).toEqual([]);

      const oversizedStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(65));
          controller.close();
        },
      });
      const oversizedRequest = new Request(
        "http://127.0.0.1:3000/api/meetings/transcribe",
        {
          method: "POST",
          body: oversizedStream,
          duplex: "half",
        } as RequestInit & { duplex: "half" },
      );

      expect(oversizedRequest.headers.get("content-length")).toBeNull();
      await expect(
        receiveMeetingAudioToTemp(oversizedRequest, {
          directory,
          maxBytes: 64,
        }),
      ).rejects.toMatchObject({ status: 413, code: "payload_too_large" });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses path and header control characters in export filenames", () => {
    const disposition = buildDownloadContentDisposition(
      "../../etc/passwd\r\n<script>.md",
      "md",
    );

    expect(disposition).toContain("attachment");
    expect(disposition).toMatch(/\.md/u);
    expect(disposition).not.toMatch(/[\\/\r\n<>]/u);
  });
});
