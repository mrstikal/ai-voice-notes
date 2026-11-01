import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as interpretRoute } from "@/app/api/voice/interpret/route";
import {
  StructuredLlmError,
} from "@/lib/ai/structured";
import type { LlmOperation } from "@/lib/ai/schemas";

const note = vi.hoisted(() => ({
  getNote: vi.fn(),
}));
const llm = vi.hoisted(() => ({
  getStructuredLlmService: vi.fn(),
  request: vi.fn(),
}));

vi.mock("@/lib/notes/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notes/service")>();

  return {
    ...actual,
    getNoteService: () => note,
  };
});

vi.mock("@/lib/ai/structured", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/structured")>();

  return {
    ...actual,
    getStructuredLlmService: llm.getStructuredLlmService,
  };
});

const APP_ORIGIN = "http://127.0.0.1:3000";
const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const operation: LlmOperation = {
  type: "replace_sentence",
  target: { startPhrase: "První", endPhrase: "věta" },
  text: "Nová věta.",
};

function request(body: unknown, origin = APP_ORIGIN): Request {
  return new Request(`${APP_ORIGIN}/api/voice/interpret`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

describe("P26 interpret route", () => {
  beforeAll(() => vi.stubEnv("APP_ORIGIN", APP_ORIGIN));
  afterAll(() => vi.unstubAllEnvs());

  beforeEach(() => {
    vi.resetAllMocks();
    note.getNote.mockResolvedValue({
      id: NOTE_ID,
      title: "Poznámka",
      contentMd: "První věta. Druhá věta.",
      contentPlain: "První věta. Druhá věta.",
      category: null,
      tags: [],
      version: 7,
      createdAt: new Date("2026-10-27T10:00:00.000Z"),
      updatedAt: new Date("2026-10-27T10:00:00.000Z"),
      deletedAt: null,
    });
    llm.getStructuredLlmService.mockReturnValue({ request: llm.request });
  });

  it("returns a validated operation and does not mutate the note", async () => {
    llm.request.mockResolvedValue({ kind: "operation", operation });

    const response = await interpretRoute(
      request({
        noteId: NOTE_ID,
        command: "Nahraď první větu.",
        snippet: "První věta.",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "operation",
      operation,
    });
    expect(llm.request).toHaveBeenCalledTimes(1);
    const arg = llm.request.mock.calls[0]?.[0] as { prompt: string };
    expect(arg.prompt).toContain("Nahraď první větu.");
    expect(arg.prompt).toContain("První věta.");
    expect(arg.prompt).toContain("Poznámka");
    expect((await note.getNote(NOTE_ID)).version).toBe(7);
  });

  it("returns an unclear clarification without a proposal", async () => {
    llm.request.mockResolvedValue({
      kind: "unclear",
      clarification: "Není jasné, co změnit.",
    });

    const response = await interpretRoute(
      request({
        noteId: NOTE_ID,
        command: "Udělej to lepší.",
        snippet: "Druhá věta.",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "unclear",
      clarification: "Není jasné, co změnit.",
    });
  });

  it("handles Undo without constructing or calling the LLM", async () => {
    const response = await interpretRoute(
      request({
        noteId: NOTE_ID,
        command: "Vrať poslední změnu.",
        snippet: "",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "undo" });
    expect(llm.getStructuredLlmService).not.toHaveBeenCalled();
    expect(llm.request).not.toHaveBeenCalled();
    expect((await note.getNote(NOTE_ID)).version).toBe(7);
  });

  it("returns a Czech unavailable response when the provider/key is unavailable", async () => {
    llm.getStructuredLlmService.mockImplementation(() => {
      throw new Error("missing key");
    });

    const response = await interpretRoute(
      request({
        noteId: NOTE_ID,
        command: "Nahraď první větu.",
        snippet: "První věta.",
      }),
    );

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("ai_unavailable");
    expect((await note.getNote(NOTE_ID)).version).toBe(7);
  });

  it("maps malformed model output and invalid snippets without note changes", async () => {
    llm.request.mockRejectedValue(
      new StructuredLlmError(
        502,
        "llm_malformed_json",
        "Model nevrátil platný JSON.",
      ),
    );

    const malformed = await interpretRoute(
      request({
        noteId: NOTE_ID,
        command: "Nahraď první větu.",
        snippet: "První věta.",
      }),
    );
    expect(malformed.status).toBe(502);
    expect(await errorCode(malformed)).toBe("llm_malformed_json");

    vi.resetAllMocks();
    note.getNote.mockResolvedValue({
      id: NOTE_ID,
      title: "Poznámka",
      contentMd: "První věta.",
      contentPlain: "První věta.",
      category: null,
      tags: [],
      version: 7,
      createdAt: new Date("2026-10-27T10:00:00.000Z"),
      updatedAt: new Date("2026-10-27T10:00:00.000Z"),
      deletedAt: null,
    });
    llm.getStructuredLlmService.mockReturnValue({ request: llm.request });

    const missingSnippet = await interpretRoute(
      request({
        noteId: NOTE_ID,
        command: "Nahraď první větu.",
        snippet: "",
      }),
    );
    expect(missingSnippet.status).toBe(400);
    expect(await errorCode(missingSnippet)).toBe("ai_snippet_empty");
    expect(llm.request).not.toHaveBeenCalled();
  });

  it("rejects a snippet that is not part of the note before any LLM call", async () => {
    const response = await interpretRoute(
      request({
        noteId: NOTE_ID,
        command: "Nahraď první větu.",
        snippet: "Text, který v poznámce není.",
      }),
    );

    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("ai_snippet_unbound");
    expect(llm.request).not.toHaveBeenCalled();
  });

  it("rejects a foreign origin before touching the note or model", async () => {
    const response = await interpretRoute(
      request(
        {
          noteId: NOTE_ID,
          command: "Nahraď první větu.",
          snippet: "První věta.",
        },
        "http://evil.example",
      ),
    );

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("invalid_origin");
    expect(note.getNote).not.toHaveBeenCalled();
    expect(llm.request).not.toHaveBeenCalled();
  });
});
