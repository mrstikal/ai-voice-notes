import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  DEFAULT_AI_REQUEST_BUDGET_USD,
  DEFAULT_APP_ORIGIN,
  DEFAULT_ELEVENLABS_API_BASE_URL,
  DEFAULT_MEETING_MAX_MINUTES,
  DEFAULT_NOTE_MAX_CHARACTERS,
  TEST_MODE_PROVIDER_KEYS,
  loadConfig,
  validateStartupEnvironment,
  type Environment,
} from "../src/lib/config";
import { CONTENT_MAX_GRAPHEMES } from "../src/lib/notes/limits";

const SUPPORTED_NODE = "22.19.0";

const TEST_MODE_ENV: Environment = {
  AI_TEST_MODE: "1",
  DATABASE_URL:
    "postgresql://ai_voice_notes:ai_voice_notes@127.0.0.1:55433/ai_voice_notes_test",
  TEST_DATABASE_URL:
    "postgresql://ai_voice_notes:ai_voice_notes@127.0.0.1:55433/ai_voice_notes_test",
  ELEVENLABS_API_KEY: TEST_MODE_PROVIDER_KEYS.ELEVENLABS_API_KEY,
  ELEVENLABS_API_BASE_URL: "http://127.0.0.1:4010",
  OPENROUTER_API_KEY: TEST_MODE_PROVIDER_KEYS.OPENROUTER_API_KEY,
  OPENAI_API_KEY: TEST_MODE_PROVIDER_KEYS.OPENAI_API_KEY,
  GEMINI_API_KEY: TEST_MODE_PROVIDER_KEYS.GEMINI_API_KEY,
};

function configWith(env: Environment = {}, nodeVersion = SUPPORTED_NODE) {
  return loadConfig(env, nodeVersion);
}

describe("loadConfig", () => {
  it("returns documented defaults without environment values", () => {
    const config = configWith();

    expect(config.noteMaxCharacters).toBe(CONTENT_MAX_GRAPHEMES);

    expect(config).toEqual({
      appOrigin: DEFAULT_APP_ORIGIN,
      appHost: "127.0.0.1",
      appPort: 3000,
      databaseUrl: null,
      testDatabaseUrl: null,
      aiTestMode: false,
      allowForwardedLoopback: false,
      elevenLabsApiKey: null,
      elevenLabsApiBaseUrl: DEFAULT_ELEVENLABS_API_BASE_URL,
      openRouterApiKey: null,
      openAiApiKey: null,
      geminiApiKey: null,
      noteMaxCharacters: DEFAULT_NOTE_MAX_CHARACTERS,
      meetingMaxMinutes: DEFAULT_MEETING_MAX_MINUTES,
      aiRequestBudgetUsd: DEFAULT_AI_REQUEST_BUDGET_USD,
    });
  });

  it("accepts a loopback origin override with an explicit port", () => {
    const config = configWith({ APP_ORIGIN: "http://127.0.0.1:3100" });

    expect(config.appOrigin).toBe("http://127.0.0.1:3100");
    expect(config.appHost).toBe("127.0.0.1");
    expect(config.appPort).toBe(3100);
  });

  it("parses the forwarded-loopback opt-in", () => {
    expect(configWith().allowForwardedLoopback).toBe(false);
    expect(
      configWith({ APP_ALLOW_FORWARDED_LOOPBACK: "0" }).allowForwardedLoopback,
    ).toBe(false);
    expect(
      configWith({ APP_ALLOW_FORWARDED_LOOPBACK: "1" }).allowForwardedLoopback,
    ).toBe(true);

    for (const value of ["true", "yes", "2"]) {
      expect(() =>
        configWith({ APP_ALLOW_FORWARDED_LOOPBACK: value }),
      ).toThrow(ConfigurationError);
    }
  });

  it("accepts localhost and IPv6 loopback origins", () => {
    expect(configWith({ APP_ORIGIN: "http://localhost:3000" })).toMatchObject({
      appOrigin: "http://localhost:3000",
      appHost: "localhost",
      appPort: 3000,
    });

    expect(configWith({ APP_ORIGIN: "http://[::1]:3000" })).toMatchObject({
      appOrigin: "http://[::1]:3000",
      appHost: "::1",
      appPort: 3000,
    });
  });

  it("accepts an explicit default HTTP port and normalizes the origin", () => {
    const config = configWith({ APP_ORIGIN: "http://127.0.0.1:80" });

    expect(config.appPort).toBe(80);
    expect(config.appOrigin).toBe("http://127.0.0.1");
  });

  it("rejects non-loopback or malformed origins", () => {
    const invalidOrigins = [
      "http://example.com:3000",
      "http://192.168.1.10:3000",
      "http://127.0.0.1",
      "http://127.0.0.1:3000/notes",
      "http://127.0.0.1:3000/?query=1",
      "http://127.0.0.1:3000/#fragment",
      "http://user:password@127.0.0.1:3000",
      "https://127.0.0.1:3000",
      "ftp://127.0.0.1:3000",
      "not-a-url",
    ];

    for (const appOrigin of invalidOrigins) {
      expect(() => configWith({ APP_ORIGIN: appOrigin })).toThrow(ConfigurationError);
    }
  });

  it("requires Node.js 22.19 or newer", () => {
    expect(() => configWith({}, "22.18.9")).toThrow(/Node\.js 22\.19\.0/);
    expect(() => configWith({}, "21.99.0")).toThrow(ConfigurationError);
    expect(() => configWith({}, "not-a-version")).toThrow(ConfigurationError);

    expect(configWith({}, "22.19.0").appPort).toBe(3000);
    expect(configWith({}, "22.19.1").appPort).toBe(3000);
    expect(configWith({}, "23.0.0").appPort).toBe(3000);
    expect(configWith({}, "24.4.2").appPort).toBe(3000);
  });

  it("accepts optional PostgreSQL URLs and rejects invalid ones", () => {
    const config = configWith({
      DATABASE_URL:
        "postgresql://ai_voice_notes:ai_voice_notes@127.0.0.1:5432/ai_voice_notes",
      TEST_DATABASE_URL:
        "postgres://ai_voice_notes:ai_voice_notes@127.0.0.1:5433/ai_voice_notes_test",
    });

    expect(config.databaseUrl).toContain("/ai_voice_notes");
    expect(config.testDatabaseUrl).toContain("/ai_voice_notes_test");

    expect(() =>
      configWith({ DATABASE_URL: "mysql://127.0.0.1:3306/notes" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      configWith({ DATABASE_URL: "postgresql://127.0.0.1:5432" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      configWith({ TEST_DATABASE_URL: "postgresql://:5433/notes_test" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      configWith({ DATABASE_URL: "postgresql://db.example.com:5432/notes" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      configWith({ TEST_DATABASE_URL: "postgresql://10.0.0.5:5432/notes_test" }),
    ).toThrow(ConfigurationError);
  });

  it("parses bounded numeric settings", () => {
    const config = configWith({
      NOTE_MAX_CHARACTERS: "15000",
      MEETING_MAX_MINUTES: "20",
      AI_REQUEST_BUDGET_USD: "3.25",
    });

    expect(config.noteMaxCharacters).toBe(15_000);
    expect(config.meetingMaxMinutes).toBe(20);
    expect(config.aiRequestBudgetUsd).toBe(3.25);

    expect(() =>
      configWith({ NOTE_MAX_CHARACTERS: String(CONTENT_MAX_GRAPHEMES + 1) }),
    ).toThrow(ConfigurationError);

    for (const invalid of ["0", "-1", "1.5", "abc"]) {
      expect(() => configWith({ NOTE_MAX_CHARACTERS: invalid })).toThrow(
        ConfigurationError,
      );
      expect(() => configWith({ MEETING_MAX_MINUTES: invalid })).toThrow(
        ConfigurationError,
      );
    }

    for (const invalid of ["0", "-2", "1.1234567", "abc"]) {
      expect(() => configWith({ AI_REQUEST_BUDGET_USD: invalid })).toThrow(
        ConfigurationError,
      );
    }
  });

  it("parses AI_TEST_MODE strictly", () => {
    expect(configWith({ AI_TEST_MODE: "0" }).aiTestMode).toBe(false);
    expect(configWith({ AI_TEST_MODE: "" }).aiTestMode).toBe(false);
    expect(() => configWith({ AI_TEST_MODE: "true" })).toThrow(ConfigurationError);
    expect(configWith(TEST_MODE_ENV).aiTestMode).toBe(true);
  });
});

describe("validateStartupEnvironment", () => {
  it("validates Node and origin without coupling the build to runtime database settings", () => {
    expect(() =>
      validateStartupEnvironment(
        {
          APP_ORIGIN: DEFAULT_APP_ORIGIN,
          DATABASE_URL: "postgresql://db.example.com:5432/notes",
          NOTE_MAX_CHARACTERS: "not-a-number",
        },
        SUPPORTED_NODE,
      ),
    ).not.toThrow();

    expect(() =>
      validateStartupEnvironment(
        { APP_ORIGIN: "http://example.com:3000" },
        SUPPORTED_NODE,
      ),
    ).toThrow(ConfigurationError);

    expect(() => validateStartupEnvironment({}, "22.18.0")).toThrow(
      ConfigurationError,
    );
  });
});
