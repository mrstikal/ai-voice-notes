import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_GEMINI_API_BASE_URL,
  type AppConfig,
} from "../../src/lib/config";
import {
  GEMINI_LIVE_MODEL_ID,
  GEMINI_LIVE_TOKEN_URL,
  buildGeminiTokenRequest,
  geminiTokenUrl,
  mintGeminiToken,
} from "../../src/lib/voice-agent/gemini-session";
import { GEMINI_VOICE_TOOL_DECLARATIONS } from "../../src/lib/voice-agent/read-services";
import {
  MAX_ACTIVE_TOOL_SESSIONS,
  MAX_TOOL_CALLS_PER_SESSION,
  MAX_TOOL_CALLS_PER_TURN,
} from "../../src/lib/voice-agent/tool-dispatch";

const ROOT = process.cwd();
const VOICE_AGENT_COMPONENTS = path.join(ROOT, "src", "components", "voice-agent");
const VOICE_AGENT_LIB = path.join(ROOT, "src", "lib", "voice-agent");
const GEMINI_ENDPOINTS = path.join(
  VOICE_AGENT_LIB,
  "gemini-endpoints.ts",
);
const BROWSER_STORAGE_OR_BEACON =
  /\b(?:localStorage|sessionStorage|indexedDB|sendBeacon)\b/u;
const SERVER_ONLY_VOICE_MODULES = new Set([
  "gemini-session",
  "read-services",
  "tool-dispatch",
]);
const SERVER_ONLY_NOTE_MODULES = new Set(["proposals"]);
const IMPORT_SPECIFIER = /\bfrom\s+["']([^"']+)["']/gu;
const DYNAMIC_IMPORT_SPECIFIER = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;

async function sourceFiles(
  directory: string,
  extensions: readonly string[],
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(fullPath, extensions)));
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      files.push(fullPath);
    }
  }

  return files;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];

  for (const pattern of [IMPORT_SPECIFIER, DYNAMIC_IMPORT_SPECIFIER]) {
    pattern.lastIndex = 0;

    for (const match of source.matchAll(pattern)) {
      if (match[1]) {
        specifiers.push(match[1]);
      }
    }
  }

  return specifiers;
}

function lastModuleName(specifier: string): string {
  return (specifier.split("/").at(-1) ?? specifier).replace(
    /\.(?:ts|tsx)$/u,
    "",
  );
}

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    appOrigin: "http://127.0.0.1:3000",
    appHost: "127.0.0.1",
    appPort: 3000,
    databaseUrl: null,
    testDatabaseUrl: null,
    aiTestMode: false,
    allowForwardedLoopback: false,
    elevenLabsApiKey: null,
    elevenLabsApiBaseUrl: "https://api.elevenlabs.io",
    geminiApiBaseUrl: DEFAULT_GEMINI_API_BASE_URL,
    openRouterApiKey: null,
    openRouterLlmModel: "deepseek/deepseek-v4.1-flash-1017",
    openRouterEmbeddingModel: "openai/text-embedding-3-small",
    geminiApiKey: "test-gemini-boundary-secret",
    geminiLiveModel: GEMINI_LIVE_MODEL_ID,
    noteMaxCharacters: 20_000,
    meetingMaxMinutes: 15,
    aiRequestBudgetUsd: 2,
    ...overrides,
  };
}

describe("P54 Stage 5 deployment boundary", () => {
  it("never persists transcripts, note text or audio from the voice-agent browser modules", async () => {
    const clientComponents = await sourceFiles(VOICE_AGENT_COMPONENTS, [".tsx"]);
    const browserLibModules = (
      await sourceFiles(VOICE_AGENT_LIB, [".ts"])
    ).filter(
      (file) => !SERVER_ONLY_VOICE_MODULES.has(path.parse(file).name),
    );

    for (const file of [...clientComponents, ...browserLibModules]) {
      const source = await readFile(file, "utf8");
      const relative = path.relative(ROOT, file);

      expect(source, `${relative} must not use browser persistence`).not.toMatch(
        BROWSER_STORAGE_OR_BEACON,
      );
      expect(source, `${relative} must not log conversation data`).not.toContain(
        "console.",
      );
    }
  });

  it("never imports a server-only voice or proposal module from a client component", async () => {
    const clientComponents = await sourceFiles(VOICE_AGENT_COMPONENTS, [".tsx"]);

    for (const file of clientComponents) {
      const source = await readFile(file, "utf8");
      const relative = path.relative(ROOT, file);

      for (const specifier of importSpecifiers(source)) {
        const moduleName = lastModuleName(specifier);

        expect(
          SERVER_ONLY_VOICE_MODULES.has(moduleName),
          `${relative} must not import server-only voice module ${specifier}`,
        ).toBe(false);
        expect(
          SERVER_ONLY_NOTE_MODULES.has(moduleName),
          `${relative} must not import server-only proposal module ${specifier}`,
        ).toBe(false);
      }
    }
  });

  it("pins the browser WebSocket host and resolves the token URL from config", async () => {
    expect(geminiTokenUrl(DEFAULT_GEMINI_API_BASE_URL)).toBe(
      GEMINI_LIVE_TOKEN_URL,
    );
    expect(geminiTokenUrl("http://127.0.0.1:4010/")).toBe(
      "http://127.0.0.1:4010/v1beta/auth_tokens",
    );

    const source = await readFile(GEMINI_ENDPOINTS, "utf8");
    const socketMatch =
      /export const GEMINI_WEBSOCKET_URL\s*=\s*"([^"]+)"/u.exec(source);

    expect(socketMatch?.[1]).toBe(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained",
    );
    expect(source).not.toContain("generativelanguage.googleapis.com/v1beta/auth_tokens");
  });

  it("keeps the Gemini tool list fixed to seven bounded, non-mutating-in-place tools", async () => {
    expect(MAX_TOOL_CALLS_PER_TURN).toBe(4);
    expect(MAX_TOOL_CALLS_PER_SESSION).toBe(20);
    expect(MAX_ACTIVE_TOOL_SESSIONS).toBe(20);

    expect(GEMINI_VOICE_TOOL_DECLARATIONS.map((tool) => tool.name)).toEqual([
      "search_notes",
      "get_note",
      "read_note_section",
      "summarize_note",
      "add_todo",
      "propose_edit",
      "confirm_edit",
    ]);

    const setup = buildGeminiTokenRequest("Aoede", new Date()) as {
      bidiGenerateContentSetup: {
        model: string;
        tools: Array<{ functionDeclarations: Array<{ name: string }> }>;
      };
    };

    expect(setup.bidiGenerateContentSetup.model).toBe(
      `models/${GEMINI_LIVE_MODEL_ID}`,
    );
    expect(
      setup.bidiGenerateContentSetup.tools.flatMap((group) =>
        group.functionDeclarations.map((tool) => tool.name),
      ),
    ).toEqual([
      "search_notes",
      "get_note",
      "read_note_section",
      "summarize_note",
      "add_todo",
      "propose_edit",
      "confirm_edit",
    ]);
  });

  it("keeps Stage 5 imports out of the Stage 1-4 note, search and health modules", async () => {
    for (const relative of [
      "src/lib/notes/service.ts",
      "src/lib/notes/markdown.ts",
      "src/lib/search/fts.ts",
      "src/app/api/health/route.ts",
    ]) {
      const source = await readFile(path.join(ROOT, relative), "utf8");

      expect(source, `${relative} must stay independent of Stage 5`).not.toMatch(
        /voice-agent|gemini/iu,
      );
    }
  });

  it("maps a provider outage to a Czech error without exposing the server key", async () => {
    const apiKey = "test-gemini-boundary-secret";
    const networkFailure = await mintGeminiToken({
      config: testConfig({ geminiApiKey: apiKey }),
      fetchImpl: async () => {
        throw new TypeError("socket hang up");
      },
      voice: "Aoede",
    }).catch((error: unknown) => error);

    expect(networkFailure).toMatchObject({
      code: "gemini_network_error",
      status: 502,
    });
    expect(String(networkFailure)).not.toContain(apiKey);
    expect(String(networkFailure)).toContain("Spojení s Google");

    const rateLimited = await mintGeminiToken({
      config: testConfig({ geminiApiKey: apiKey }),
      fetchImpl: async () => ({ status: 429, json: {} }),
      voice: "Aoede",
    }).catch((error: unknown) => error);

    expect(rateLimited).toMatchObject({
      code: "gemini_rate_limited",
      status: 503,
    });
    expect(String(rateLimited)).not.toContain(apiKey);
  });
});
