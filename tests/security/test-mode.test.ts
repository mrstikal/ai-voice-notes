import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConfigurationError,
  DEFAULT_ELEVENLABS_API_BASE_URL,
  TEST_MODE_PROVIDER_KEYS,
  loadConfig,
  type Environment,
} from "../../src/lib/config";
import {
  ScribeTokenError,
  getElevenLabsTransport,
  setElevenLabsTransportForTests,
} from "../../src/lib/elevenlabs/client";
import {
  createMockElevenLabsTransport,
  resetProviderMocks,
} from "../helpers/provider-mocks";

const SUPPORTED_NODE = "22.19.0";
const TEST_DATABASE_URL =
  "postgresql://ai_voice_notes:ai_voice_notes@127.0.0.1:55433/ai_voice_notes_test";
const DEV_DATABASE_URL =
  "postgresql://ai_voice_notes:ai_voice_notes@127.0.0.1:55432/ai_voice_notes";

const TEST_MODE_ENV: Environment = {
  AI_TEST_MODE: "1",
  DATABASE_URL: TEST_DATABASE_URL,
  TEST_DATABASE_URL,
  ELEVENLABS_API_KEY: TEST_MODE_PROVIDER_KEYS.ELEVENLABS_API_KEY,
  ELEVENLABS_API_BASE_URL: "http://127.0.0.1:4010",
  OPENROUTER_API_KEY: TEST_MODE_PROVIDER_KEYS.OPENROUTER_API_KEY,
  OPENAI_API_KEY: TEST_MODE_PROVIDER_KEYS.OPENAI_API_KEY,
  GEMINI_API_KEY: TEST_MODE_PROVIDER_KEYS.GEMINI_API_KEY,
};

function configWithTestMode(overrides: Environment = {}) {
  return loadConfig({ ...TEST_MODE_ENV, ...overrides }, SUPPORTED_NODE);
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetProviderMocks();
});

describe("AI_TEST_MODE guard", () => {
  it("accepts an isolated _test database, a loopback mock and exact dummy keys", () => {
    const config = configWithTestMode();

    expect(config.aiTestMode).toBe(true);
    expect(config.databaseUrl).toBe(TEST_DATABASE_URL);
    expect(config.testDatabaseUrl).toBe(TEST_DATABASE_URL);
    expect(config.elevenLabsApiKey).toBe(
      TEST_MODE_PROVIDER_KEYS.ELEVENLABS_API_KEY,
    );
    expect(config.elevenLabsApiBaseUrl).toBe("http://127.0.0.1:4010");
    expect(config.openRouterApiKey).toBe(
      TEST_MODE_PROVIDER_KEYS.OPENROUTER_API_KEY,
    );
    expect(config.openAiApiKey).toBe(TEST_MODE_PROVIDER_KEYS.OPENAI_API_KEY);
    expect(config.geminiApiKey).toBe(TEST_MODE_PROVIDER_KEYS.GEMINI_API_KEY);
  });

  it("rejects a missing or non-_test database", () => {
    expect(() =>
      configWithTestMode({
        DATABASE_URL: undefined,
        TEST_DATABASE_URL: undefined,
      }),
    ).toThrow(/AI_TEST_MODE=1 vyžaduje DATABASE_URL/u);

    expect(() =>
      configWithTestMode({ DATABASE_URL: undefined }),
    ).toThrow(/AI_TEST_MODE=1 vyžaduje DATABASE_URL/u);

    expect(() =>
      configWithTestMode({ DATABASE_URL: DEV_DATABASE_URL }),
    ).toThrow(/DATABASE_URL.*_test/u);

    expect(() =>
      configWithTestMode({ TEST_DATABASE_URL: DEV_DATABASE_URL }),
    ).toThrow(/TEST_DATABASE_URL.*_test/u);

    expect(() =>
      configWithTestMode({
        DATABASE_URL: `${TEST_DATABASE_URL}?dbname=ai_voice_notes`,
      }),
    ).toThrow(/query parametrech/u);
  });

  it("rejects every real or malformed provider key before clients are built", () => {
    for (const name of Object.keys(TEST_MODE_PROVIDER_KEYS)) {
      expect(() =>
        configWithTestMode({ [name]: "sk-real-provider-key" }),
      ).toThrow(new RegExp(name, "u"));
    }
  });

  it("rejects public or non-http mock endpoints", () => {
    for (const baseUrl of [
      "https://api.elevenlabs.io",
      "http://192.168.1.5:4010",
      "http://127.0.0.1:4010/?query=1",
      "ftp://127.0.0.1:4010",
    ]) {
      expect(() =>
        configWithTestMode({ ELEVENLABS_API_BASE_URL: baseUrl }),
      ).toThrow(ConfigurationError);
    }
  });

  it("accepts real keys and public provider endpoints when test mode is off", () => {
    const config = loadConfig(
      {
        AI_TEST_MODE: "0",
        ELEVENLABS_API_KEY: "sk-real-looking-key",
        ELEVENLABS_API_BASE_URL: DEFAULT_ELEVENLABS_API_BASE_URL,
      },
      SUPPORTED_NODE,
    );

    expect(config.aiTestMode).toBe(false);
    expect(config.elevenLabsApiKey).toBe("sk-real-looking-key");
    expect(config.elevenLabsApiBaseUrl).toBe(DEFAULT_ELEVENLABS_API_BASE_URL);
  });
});

describe("test-only provider transport", () => {
  it("blocks unmocked provider calls in unit tests", () => {
    resetProviderMocks();

    expect(() => getElevenLabsTransport()).toThrow(ScribeTokenError);
    expect(() => getElevenLabsTransport()).toThrow(/nemockovaný/u);
  });

  it("uses an injected transport only while NODE_ENV=test", () => {
    const fakeTransport = createMockElevenLabsTransport({
      tokens: ["sutkn_injected_token"],
    });

    setElevenLabsTransportForTests(fakeTransport);
    expect(getElevenLabsTransport()).toBe(fakeTransport);

    vi.stubEnv("NODE_ENV", "production");

    expect(getElevenLabsTransport()).not.toBe(fakeTransport);
    expect(() => setElevenLabsTransportForTests(fakeTransport)).toThrow(
      /NODE_ENV=test/u,
    );
  });
});
