import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as suggestCleanupRoute } from "@/app/api/notes/[id]/ai-suggest/route";
import type { LlmEditResponse } from "@/lib/ai/schemas";
import {
  hashNoteSource,
} from "@/lib/notes/operations";

const APP_ORIGIN = "http://127.0.0.1:3000";
const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const original =
  "Já jsem já jsem se včera ehm sešel s Janem Novákem a měl jsem 3 schůzky.\n\nDruhý odstavec zůstává beze změny.";
const cleaned =
  "Včera jsem se sešel s Janem Novákem a měl jsem 3 schůzky.";

const llmRequest = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/structured", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/ai/structured")>();

  return {
    ...actual,
    getStructuredLlmService: () => ({ request: llmRequest }),
  };
});

vi.mock("@/lib/notes/service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/notes/service")>();

  return {
    ...actual,
    getNoteService: () => ({
      getNote: async () => ({
        contentMd: original,
        version: 1,
      }),
    }),
  };
});

function request(body: unknown): Request {
  return new Request(`${APP_ORIGIN}/api/notes/${NOTE_ID}/ai-suggest`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: APP_ORIGIN,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function context() {
  return { params: Promise.resolve({ id: NOTE_ID }) };
}

function operation(text: string): LlmEditResponse {
  return {
    kind: "operation",
    operation: {
      type: "replace_paragraph",
      target: {
        startPhrase: "Já jsem já jsem se včera ehm sešel s Janem Novákem a měl jsem 3 schůzky.",
        endPhrase: "Já jsem já jsem se včera ehm sešel s Janem Novákem a měl jsem 3 schůzky.",
      },
      text,
    },
  };
}

beforeAll(() => {
  vi.stubEnv("APP_ORIGIN", APP_ORIGIN);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  llmRequest.mockReset();
});

describe("cleanup suggestion API", () => {
  it("returns one resolved paragraph operation bound to version, hash and candidate", async () => {
    llmRequest.mockResolvedValue(operation(cleaned));

    const response = await suggestCleanupRoute(
      request({ kind: "cleanup", blockIndex: 0, properNames: ["Janem Novákem"] }),
      context(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      candidateId: string;
      cleanedText: string;
      operation: unknown;
      noteVersion: number;
      sourceHash: string;
    };
    expect(body).toMatchObject({
      candidateId: "p0",
      cleanedText: cleaned,
      noteVersion: 1,
      sourceHash: hashNoteSource(original),
    });
    expect(body.operation).toEqual({
      type: "replace_paragraph",
      target: {
        startPhrase:
          "Já jsem já jsem se včera ehm sešel s Janem Novákem a měl jsem 3 schůzky.",
        endPhrase:
          "Já jsem já jsem se včera ehm sešel s Janem Novákem a měl jsem 3 schůzky.",
      },
      text: cleaned,
    });
    expect(llmRequest).toHaveBeenCalledTimes(1);
    const prompt = String(llmRequest.mock.calls[0]?.[0]?.prompt);
    expect(prompt).toContain("Janem Novákem");
    expect(prompt).not.toContain("Druhý odstavec");
  });

  it("rejects altered numbers and unknown names before any note is touched", async () => {
    llmRequest.mockResolvedValue(
      operation(
        "Včera jsem se sešel s Janem Novákem a měl jsem 4 schůzky.",
      ),
    );

    const numberResponse = await suggestCleanupRoute(
      request({ kind: "cleanup", blockIndex: 0 }),
      context(),
    );
    expect(numberResponse.status).toBe(422);
    expect(await numberResponse.json()).toMatchObject({
      error: { code: "cleanup_numeric_changed" },
    });

    llmRequest.mockClear();
    const nameResponse = await suggestCleanupRoute(
      request({
        kind: "cleanup",
        blockIndex: 0,
        properNames: ["Karel"],
      }),
      context(),
    );
    expect(nameResponse.status).toBe(422);
    expect(await nameResponse.json()).toMatchObject({
      error: { code: "cleanup_name_missing" },
    });
    expect(llmRequest).not.toHaveBeenCalled();
  });

  it("rejects unsupported blocks before billing", async () => {
    const response = await suggestCleanupRoute(
      request({ kind: "cleanup", blockIndex: 99 }),
      context(),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "cleanup_paragraph_unsupported" },
    });
    expect(llmRequest).not.toHaveBeenCalled();
  });
});
