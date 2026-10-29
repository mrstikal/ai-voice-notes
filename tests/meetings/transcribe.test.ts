import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../../src/lib/config";
import {
  MEETING_TRANSCRIPT_MAX_GRAPHEMES,
  SCRIBE_BATCH_MODEL_ID,
  SCRIBE_BATCH_OPERATION,
  buildMeetingTranscriptionOffer,
  createMeetingTranscribeHandlers,
  createMeetingTranscriptionService,
  estimateMeetingTranscriptionMaxCostUsd,
  parseMeetingTranscriptionResponse,
  type BatchTranscribeTransport,
  type MeetingTranscriptionError,
} from "../../src/lib/meetings/transcribe";
import type {
  UsageOperationDto,
  UsageService,
} from "../../src/lib/ai/usage";
import { cleanupMedia, createSilentWav, hasFfmpeg } from "../fixtures/media";

const APP_ORIGIN = "http://127.0.0.1:3000";

function configWith(options: { readonly apiKey?: string | null } = {}): AppConfig {
  return loadConfig({
    APP_ORIGIN,
    ELEVENLABS_API_KEY:
      options.apiKey === undefined ? "test-only-elevenlabs" : (options.apiKey ?? ""),
    ELEVENLABS_API_BASE_URL: "https://api.elevenlabs.io",
    MEETING_MAX_MINUTES: "15",
  });
}

interface FakeUsage {
  readonly usage: UsageService;
  readonly reservations: Parameters<UsageService["reserve"]>[0][];
  readonly unknowns: { id: string; providerUsage: unknown }[];
}

function fakeUsage(): FakeUsage {
  const reservations: Parameters<UsageService["reserve"]>[0][] = [];
  const unknowns: { id: string; providerUsage: unknown }[] = [];
  let counter = 0;

  function toDto(input: Parameters<UsageService["reserve"]>[0]): UsageOperationDto {
    counter += 1;

    return {
      id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
      operation: input.operation,
      provider: input.provider,
      model: input.model,
      status: "started",
      reservedCostUsd: String(input.estimatedMaxCostUsd ?? 0),
      reportedCostUsd: null,
      providerUsage: null,
      startedAt: new Date("2026-10-29T12:00:00Z"),
      settledAt: null,
    };
  }

  const usage: UsageService = {
    async reserve(input) {
      reservations.push(input);
      return toDto(input);
    },
    async settle() {
      throw new Error("settle must not be called for batch transcription");
    },
    async markUnknown(id, providerUsage) {
      unknowns.push({ id, providerUsage });
      return { ...toDto(reservations[0]!), id, status: "unknown" };
    },
    async getSummary() {
      throw new Error("unexpected getSummary");
    },
    async resetUsage() {
      throw new Error("unexpected resetUsage");
    },
  };

  return { usage, reservations, unknowns };
}

function transportReturning(
  payload: unknown,
  onRequest?: (request: unknown) => void,
): BatchTranscribeTransport {
  return {
    async transcribe(request) {
      onRequest?.(request);
      return payload;
    },
  };
}

function providerPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    language_code: "cs",
    language_probability: 0.99,
    audio_duration_secs: 12.5,
    text: "Dobrý den, týme. Schůzka začíná v devět.",
    words: [
      { text: "Dobrý", type: "word", speaker_id: "speaker_0" },
      { text: " ", type: "spacing" },
      { text: "den,", type: "word", speaker_id: "speaker_0" },
      { text: " ", type: "spacing" },
      { text: "týme.", type: "word", speaker_id: "speaker_0" },
      { text: " ", type: "spacing" },
      { text: "Schůzka", type: "word", speaker_id: "speaker_1" },
      { text: " ", type: "spacing" },
      { text: "začíná", type: "word", speaker_id: "speaker_1" },
      { text: " ", type: "spacing" },
      { text: "v", type: "word", speaker_id: "speaker_1" },
      { text: " ", type: "spacing" },
      { text: "devět.", type: "word", speaker_id: "speaker_1" },
    ],
    ...overrides,
  };
}

function providerError(statusCode: number, name = "ElevenLabsApiError"): Error {
  const error = new Error(`provider ${statusCode}`);
  error.name = name;
  (error as { statusCode?: number }).statusCode = statusCode;

  return error;
}

async function expectMeetingError(
  promise: Promise<unknown>,
  expected: { status: number; code: string },
): Promise<MeetingTranscriptionError> {
  try {
    await promise;
  } catch (error) {
    const typed = error as MeetingTranscriptionError;

    expect(typed.status).toBe(expected.status);
    expect(typed.code).toBe(expected.code);
    return typed;
  }

  throw new Error("Expected a MeetingTranscriptionError.");
}

describe("P42 batch transcription contract", () => {
  it("declares the documented direct batch Scribe v2 endpoint contract", () => {
    expect(SCRIBE_BATCH_MODEL_ID).toBe("scribe_v2");
    expect(SCRIBE_BATCH_OPERATION).toBe("elevenlabs_scribe_batch");
    expect(estimateMeetingTranscriptionMaxCostUsd(15)).toBe(0.055);
    expect(estimateMeetingTranscriptionMaxCostUsd(1)).toBe(0.003667);
  });

  it("builds a cost offer from the configured meeting bound", () => {
    const offer = buildMeetingTranscriptionOffer(configWith());

    expect(offer).toMatchObject({
      provider: "elevenlabs",
      model: "scribe_v2",
      operation: "elevenlabs_scribe_batch",
      languageCode: "cs",
      maxMinutes: 15,
      estimatedMaxCostUsd: 0.055,
      transcriptMaxGraphemes: MEETING_TRANSCRIPT_MAX_GRAPHEMES,
      testMode: false,
    });
    expect(offer.maxBytes).toBe(25 * 1024 * 1024);
  });

  it("derives speaker segments only from real diarization data", () => {
    const parsed = parseMeetingTranscriptionResponse(providerPayload());

    expect(parsed.text).toBe("Dobrý den, týme. Schůzka začíná v devět.");
    expect(parsed.languageCode).toBe("cs");
    expect(parsed.audioDurationSeconds).toBe(12.5);
    expect(parsed.diarization).toBe("available");
    expect(parsed.speakers).toEqual(["speaker_0", "speaker_1"]);
    expect(parsed.segments).toEqual([
      { speakerId: "speaker_0", text: "Dobrý den, týme. " },
      { speakerId: "speaker_1", text: "Schůzka začíná v devět." },
    ]);
    expect(parsed.transcriptGraphemes).toBe(40);
  });

  it("accepts the camelCase shape returned by the installed SDK", () => {
    const parsed = parseMeetingTranscriptionResponse({
      languageCode: "cs",
      audioDurationSecs: 3.5,
      text: "Ahoj světe.",
      words: [
        { text: "Ahoj", type: "word", speakerId: "speaker_0", logprob: -0.1 },
        { text: " ", type: "spacing", logprob: -0.1 },
        { text: "světe.", type: "word", speakerId: "speaker_0", logprob: -0.1 },
      ],
    });

    expect(parsed.languageCode).toBe("cs");
    expect(parsed.audioDurationSeconds).toBe(3.5);
    expect(parsed.diarization).toBe("available");
    expect(parsed.segments).toEqual([
      { speakerId: "speaker_0", text: "Ahoj světe." },
    ]);
  });

  it("never fabricates speaker labels when the provider omits speaker ids", () => {
    const parsed = parseMeetingTranscriptionResponse(
      providerPayload({
        words: [
          { text: "Bez", type: "word" },
          { text: " ", type: "spacing" },
          { text: "mluvčích.", type: "word" },
        ],
      }),
    );

    expect(parsed.diarization).toBe("unavailable");
    expect(parsed.speakers).toBeNull();
    expect(parsed.segments).toBeNull();
    expect(parsed.text).toBe("Dobrý den, týme. Schůzka začíná v devět.");
  });

  it("falls back to no speakers when any word lacks a valid speaker id", () => {
    const parsed = parseMeetingTranscriptionResponse(
      providerPayload({
        words: [
          { text: "Ahoj", type: "word", speaker_id: "speaker_0" },
          { text: " ", type: "spacing" },
          { text: "světe", type: "word" },
        ],
      }),
    );

    expect(parsed.diarization).toBe("unavailable");
    expect(parsed.segments).toBeNull();
  });

  it("rejects malformed, empty and oversized transcripts", async () => {
    await expectMeetingError(
      Promise.resolve().then(() => parseMeetingTranscriptionResponse(null)),
      { status: 502, code: "invalid_provider_response" },
    );
    await expectMeetingError(
      Promise.resolve().then(() =>
        parseMeetingTranscriptionResponse({ text: 42 }),
      ),
      { status: 502, code: "invalid_provider_response" },
    );
    await expectMeetingError(
      Promise.resolve().then(() =>
        parseMeetingTranscriptionResponse({ text: "   " }),
      ),
      { status: 422, code: "meeting_transcript_empty" },
    );
    await expectMeetingError(
      Promise.resolve().then(() =>
        parseMeetingTranscriptionResponse({
          text: "a".repeat(MEETING_TRANSCRIPT_MAX_GRAPHEMES + 1),
        }),
      ),
      { status: 422, code: "meeting_transcript_too_long" },
    );
  });
});

describe("P42 transcription service", () => {
  it("reserves the bounded estimate, calls the transport once and marks usage unknown", async () => {
    const ledger = fakeUsage();
    let seen: unknown;
    const service = createMeetingTranscriptionService({
      config: configWith(),
      usage: ledger.usage,
      transport: transportReturning(providerPayload(), (request) => {
        seen = request;
      }),
    });

    const result = await service.transcribe({
      filePath: "/tmp/meeting-upload.webm",
      fileName: "meeting-upload.webm",
    });

    expect(result.text).toContain("Dobrý den");
    expect(seen).toMatchObject({
      apiKey: "test-only-elevenlabs",
      baseUrl: "https://api.elevenlabs.io",
      filePath: "/tmp/meeting-upload.webm",
      fileName: "meeting-upload.webm",
    });
    expect(ledger.reservations).toEqual([
      {
        operation: "elevenlabs_scribe_batch",
        provider: "elevenlabs",
        model: "scribe_v2",
        estimatedMaxCostUsd: 0.055,
      },
    ]);
    expect(ledger.unknowns).toHaveLength(1);
    expect(ledger.unknowns[0]!.providerUsage).toMatchObject({
      model: "scribe_v2",
      languageCode: "cs",
      audioDurationSecs: 12.5,
      diarize: true,
      chargeReason: "batch_transcript_usage_unknown",
    });
    expect(JSON.stringify(ledger.unknowns[0]!.providerUsage)).not.toContain(
      "Dobrý den",
    );
  });

  it("fails before reserving anything when the key is missing", async () => {
    const ledger = fakeUsage();
    const service = createMeetingTranscriptionService({
      config: configWith({ apiKey: null }),
      usage: ledger.usage,
      transport: transportReturning(providerPayload()),
    });

    await expectMeetingError(
      service.transcribe({ filePath: "/tmp/a.wav", fileName: "a.wav" }),
      { status: 503, code: "elevenlabs_not_configured" },
    );
    expect(ledger.reservations).toEqual([]);
    expect(ledger.unknowns).toEqual([]);
  });

  it("maps an entitlement denial and keeps the charge unknown", async () => {
    const ledger = fakeUsage();
    const service = createMeetingTranscriptionService({
      config: configWith(),
      usage: ledger.usage,
      transport: {
        async transcribe() {
          throw providerError(401);
        },
      },
    });

    await expectMeetingError(
      service.transcribe({ filePath: "/tmp/a.wav", fileName: "a.wav" }),
      { status: 502, code: "elevenlabs_entitlement_denied" },
    );
    expect(ledger.unknowns).toHaveLength(1);
    expect(ledger.unknowns[0]!.providerUsage).toMatchObject({
      chargeReason: "provider_request_failed",
    });
  });

  it("maps timeouts, rate limits and provider failures", async () => {
    const cases = [
      { error: providerError(429), status: 503, code: "elevenlabs_rate_limited" },
      {
        error: providerError(0, "ElevenLabsTimeoutError"),
        status: 504,
        code: "elevenlabs_timeout",
      },
      { error: providerError(500), status: 502, code: "elevenlabs_error" },
      { error: providerError(422), status: 422, code: "elevenlabs_invalid_audio" },
    ] as const;

    for (const item of cases) {
      const ledger = fakeUsage();
      const service = createMeetingTranscriptionService({
        config: configWith(),
        usage: ledger.usage,
        transport: {
          async transcribe() {
            throw item.error;
          },
        },
      });

      await expectMeetingError(
        service.transcribe({ filePath: "/tmp/a.wav", fileName: "a.wav" }),
        { status: item.status, code: item.code },
      );
      expect(ledger.unknowns).toHaveLength(1);
    }
  });

  it("marks a malformed provider response as unknown usage", async () => {
    const ledger = fakeUsage();
    const service = createMeetingTranscriptionService({
      config: configWith(),
      usage: ledger.usage,
      transport: transportReturning({ unexpected: true }),
    });

    await expectMeetingError(
      service.transcribe({ filePath: "/tmp/a.wav", fileName: "a.wav" }),
      { status: 502, code: "invalid_provider_response" },
    );
    expect(ledger.unknowns[0]!.providerUsage).toMatchObject({
      chargeReason: "invalid_provider_response",
    });
  });
});

describe("P42 transcribe route", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "meeting-transcribe-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function request(
    url: string,
    body: BodyInit | null = null,
    headers: Record<string, string> = {},
  ): Request {
    return new Request(url, {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: APP_ORIGIN,
        "content-type": "application/octet-stream",
        ...headers,
      },
      body,
    });
  }

  async function tempFiles(): Promise<string[]> {
    try {
      return (await readdir(directory)).filter((name) =>
        name.startsWith("meeting-"),
      );
    } catch {
      return [];
    }
  }

  it("serves a free cost offer without any provider or ledger call", async () => {
    const ledger = fakeUsage();
    const handlers = createMeetingTranscribeHandlers({
      config: configWith(),
      usage: ledger.usage,
      uploadDirectory: directory,
    });
    const response = await handlers.GET(
      new Request("http://127.0.0.1:3000/api/meetings/transcribe", {
        headers: { host: "127.0.0.1:3000" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      provider: "elevenlabs",
      model: "scribe_v2",
      estimatedMaxCostUsd: 0.055,
      maxMinutes: 15,
    });
    expect(ledger.reservations).toEqual([]);
    expect(ledger.unknowns).toEqual([]);
  });

  it("rejects wrong Origin and content type before any work", async () => {
    const ledger = fakeUsage();
    const handlers = createMeetingTranscribeHandlers({
      config: configWith(),
      usage: ledger.usage,
      uploadDirectory: directory,
      transport: transportReturning(providerPayload()),
    });
    const url = `${APP_ORIGIN}/api/meetings/transcribe?approveCostUsd=0.055`;

    const wrongOrigin = await handlers.POST(
      request(url, new Uint8Array([1]), { origin: "http://127.0.0.1:3999" }),
    );
    expect(wrongOrigin.status).toBe(403);

    const wrongType = await handlers.POST(
      request(url, new Uint8Array([1]), { "content-type": "audio/wav" }),
    );
    expect(wrongType.status).toBe(415);

    expect(ledger.reservations).toEqual([]);
    expect(await tempFiles()).toEqual([]);
  });

  it("requires an explicit cost approval at or above the estimate", async () => {
    const ledger = fakeUsage();
    const handlers = createMeetingTranscribeHandlers({
      config: configWith(),
      usage: ledger.usage,
      uploadDirectory: directory,
      transport: transportReturning(providerPayload()),
    });

    const missing = await handlers.POST(
      request(`${APP_ORIGIN}/api/meetings/transcribe`, new Uint8Array([1])),
    );
    expect(missing.status).toBe(409);
    await expect(missing.json()).resolves.toMatchObject({
      error: {
        code: "meeting_cost_not_approved",
        estimatedMaxCostUsd: 0.055,
      },
    });

    const low = await handlers.POST(
      request(
        `${APP_ORIGIN}/api/meetings/transcribe?approveCostUsd=0.01`,
        new Uint8Array([1]),
      ),
    );
    expect(low.status).toBe(409);
    expect(ledger.reservations).toEqual([]);
  });

  it.skipIf(!hasFfmpeg())(
    "re-validates real media, transcribes, returns the preview and deletes the temp file",
    async () => {
    const media = await createSilentWav(1);
    const ledger = fakeUsage();
    const handlers = createMeetingTranscribeHandlers({
      config: configWith(),
      usage: ledger.usage,
      uploadDirectory: directory,
      transport: transportReturning(providerPayload()),
    });

    try {
      const response = await handlers.POST(
        request(
          `${APP_ORIGIN}/api/meetings/transcribe?approveCostUsd=0.055`,
          await readFile(media.path),
        ),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        text: "Dobrý den, týme. Schůzka začíná v devět.",
        diarization: "available",
        speakers: ["speaker_0", "speaker_1"],
        format: "wav",
        model: "scribe_v2",
        provider: "elevenlabs",
        testMode: false,
      });
      expect(ledger.reservations).toHaveLength(1);
      expect(ledger.unknowns).toHaveLength(1);
      expect(await tempFiles()).toEqual([]);
    } finally {
      await cleanupMedia(media.directory);
    }
    },
  );

  it("accepts the displayed approval for a larger configured meeting limit", async () => {
    const ledger = fakeUsage();
    const handlers = createMeetingTranscribeHandlers({
      config: loadConfig({
        APP_ORIGIN,
        ELEVENLABS_API_KEY: "test-only-elevenlabs",
        ELEVENLABS_API_BASE_URL: "https://api.elevenlabs.io",
        MEETING_MAX_MINUTES: "300",
      }),
      usage: ledger.usage,
      uploadDirectory: directory,
      transport: transportReturning(providerPayload()),
    });

    const offerResponse = await handlers.GET(
      new Request("http://127.0.0.1:3000/api/meetings/transcribe", {
        headers: { host: "127.0.0.1:3000" },
      }),
    );
    const offer = (await offerResponse.json()) as {
      estimatedMaxCostUsd: number;
    };

    expect(offer.estimatedMaxCostUsd).toBe(1.1);

    const response = await handlers.POST(
      request(
        `${APP_ORIGIN}/api/meetings/transcribe?approveCostUsd=1.1`,
        Buffer.from("not audio"),
      ),
    );

    expect(response.status).toBe(422);
    expect(ledger.reservations).toEqual([]);
  });

  it.skipIf(!hasFfmpeg())(
    "maps a full 15-minute provider entitlement denial and deletes the temp file",
    async () => {
      const media = await createSilentWav(900);
      const ledger = fakeUsage();
      let providerCalled = false;
      const handlers = createMeetingTranscribeHandlers({
        config: configWith(),
        usage: ledger.usage,
        uploadDirectory: directory,
        transport: {
          async transcribe() {
            providerCalled = true;
            throw providerError(403);
          },
        },
      });

      try {
        const response = await handlers.POST(
          request(
            `${APP_ORIGIN}/api/meetings/transcribe?approveCostUsd=0.055`,
            await readFile(media.path),
          ),
        );

        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "elevenlabs_entitlement_denied" },
        });
        expect(providerCalled).toBe(true);
        expect(ledger.reservations[0]?.estimatedMaxCostUsd).toBe(0.055);
        expect(ledger.unknowns).toHaveLength(1);
        expect(await tempFiles()).toEqual([]);
      } finally {
        await cleanupMedia(media.directory);
      }
    },
    30_000,
  );

  it("does not reserve or retry when inspection rejects the media", async () => {
    const ledger = fakeUsage();
    const handlers = createMeetingTranscribeHandlers({
      config: configWith(),
      usage: ledger.usage,
      uploadDirectory: directory,
      transport: transportReturning(providerPayload()),
    });

    const response = await handlers.POST(
      request(
        `${APP_ORIGIN}/api/meetings/transcribe?approveCostUsd=0.055`,
        Buffer.from("not audio"),
      ),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_media" },
    });
    expect(ledger.reservations).toEqual([]);
    expect(await tempFiles()).toEqual([]);
  });
});
