import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as suggestCleanupRoute } from "@/app/api/notes/[id]/ai-suggest/route";
import { BudgetExceededError } from "@/lib/ai/usage";
import type { LlmEditResponse } from "@/lib/ai/schemas";
import { ConfigurationError } from "@/lib/config";
import { parseNoteMarkdown } from "@/lib/notes/markdown";
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
const llmTagRequest = vi.hoisted(() => vi.fn());
const llmTaskRequest = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/structured", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/ai/structured")>();

  return {
    ...actual,
    getStructuredLlmService: () => ({
      request: llmRequest,
      requestTagSuggestions: llmTagRequest,
      requestTaskSuggestions: llmTaskRequest,
    }),
  };
});

vi.mock("@/lib/notes/service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/notes/service")>();

  return {
    ...actual,
    getNoteService: () => ({
      getNote: async () => ({
        id: NOTE_ID,
        title: "Testovací poznámka",
        contentMd: original,
        contentPlain: original,
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
  llmTagRequest.mockReset();
  llmTaskRequest.mockReset();
});

describe("cleanup suggestion API", () => {
  it("returns bounded task suggestions and prepares an append operation without writing", async () => {
    llmTaskRequest.mockResolvedValue({
      tasks: [{ text: "Koupit mléko" }, { text: "Zavolat lékaři" }],
    });
    const plain = parseNoteMarkdown(original).plainText;
    const firstEnd = plain.indexOf("Druhý") - 1;

    const suggestion = await suggestCleanupRoute(
      request({
        kind: "task_suggestions",
        start: 0,
        end: firstEnd,
      }),
      context(),
    );
    expect(suggestion.status).toBe(200);
    expect(await suggestion.json()).toMatchObject({
      kind: "task_suggestions",
      noteId: NOTE_ID,
      noteVersion: 1,
      tasks: [
        { duplicate: false, text: "Koupit mléko" },
        { duplicate: false, text: "Zavolat lékaři" },
      ],
    });

    const applied = await suggestCleanupRoute(
      request({
        kind: "task_apply",
        expectedVersion: 1,
        tasks: ["Koupit mléko", "Zavolat lékaři"],
      }),
      context(),
    );
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      kind: "task_apply",
      noteVersion: 1,
      operation: { type: "append_bounded_section" },
    });
  });

  it("rejects duplicate/stale task insertions without writing a note", async () => {
    const duplicate = await suggestCleanupRoute(
      request({
        kind: "task_apply",
        expectedVersion: 1,
        tasks: ["Koupit mléko", "koupit mléko"],
      }),
      context(),
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      error: { code: "task_suggestion_duplicate" },
    });

    const stale = await suggestCleanupRoute(
      request({
        kind: "task_apply",
        expectedVersion: 2,
        tasks: ["Koupit mléko"],
      }),
      context(),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "task_suggestion_stale" },
    });
  });

  it("returns bounded AI tag suggestions without writing a note", async () => {
    llmTagRequest.mockResolvedValue({
      tags: ["atlas", "migrace"],
      category: "Práce",
    });

    const response = await suggestCleanupRoute(
      request({ kind: "tag_suggestions" }),
      context(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      kind: string;
      tags: string[];
      category: string | null;
      noteId: string;
      noteVersion: number;
      expiresAt: string;
    };
    expect(body).toMatchObject({
      kind: "tag_suggestions",
      tags: ["atlas", "migrace"],
      category: "Práce",
      noteId: NOTE_ID,
      noteVersion: 1,
    });
    expect(Number.isNaN(Date.parse(body.expiresAt))).toBe(false);
    expect(llmTagRequest).toHaveBeenCalledTimes(1);
    const prompt = String(
      llmTagRequest.mock.calls[0]?.[0]?.prompt,
    );
    expect(prompt).toContain("Já jsem já jsem");
    expect(prompt).toContain("Druhý odstavec");
    expect(prompt).toContain("Testovací poznámka");
  });

  it("rejects invalid provider tag data and maps tag-specific fallback wording", async () => {
    llmTagRequest.mockResolvedValueOnce({
      tags: ["x".repeat(33)],
      category: null,
    });
    const invalid = await suggestCleanupRoute(
      request({ kind: "tag_suggestions" }),
      context(),
    );
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({
      error: { code: "tag_suggestion_invalid" },
    });

    llmTagRequest.mockRejectedValueOnce(
      new ConfigurationError("OpenRouter není nakonfigurovaný."),
    );
    const config = await suggestCleanupRoute(
      request({ kind: "tag_suggestions" }),
      context(),
    );
    expect(config.status).toBe(503);
    expect(await config.json()).toMatchObject({
      error: {
        message: "AI návrh tagů není dostupný. Ruční tagy lze dál upravovat.",
      },
    });
  });

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

  it("returns a bound derived summary without writing a note", async () => {
    const summary = "Shrnutí: včera proběhla schůzka s Janem a třemi kroky.";
    llmRequest.mockResolvedValue({
      kind: "operation",
      operation: { type: "append_bounded_section", text: summary },
    } as LlmEditResponse);
    const plain = parseNoteMarkdown(original).plainText;
    const secondStart = plain.indexOf("Druhý");

    const response = await suggestCleanupRoute(
      request({
        kind: "summary",
        scope: "range",
        start: 0,
        end: secondStart - 1,
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: "summary",
      noteId: NOTE_ID,
      noteVersion: 1,
      summaryText: summary,
    });
    const prompt = String(llmRequest.mock.calls[0]?.[0]?.prompt);
    expect(prompt).toContain("Já jsem já jsem");
    expect(prompt).not.toContain("Druhý odstavec");
  });

  it("maps summary budget and configuration failures to summary-specific responses", async () => {
    llmRequest.mockRejectedValueOnce(
      new BudgetExceededError({
        budgetUsd: "2.000000",
        committedUsd: "2.000000",
        requestedUsd: "0.011187",
      }),
    );
    const budgetResponse = await suggestCleanupRoute(
      request({ kind: "summary", scope: "full" }),
      context(),
    );
    expect(budgetResponse.status).toBe(402);
    expect(await budgetResponse.json()).toMatchObject({
      error: { code: "budget_exceeded" },
    });

    llmRequest.mockRejectedValueOnce(
      new ConfigurationError("OpenRouter není nakonfigurovaný."),
    );
    const configResponse = await suggestCleanupRoute(
      request({ kind: "summary", scope: "full" }),
      context(),
    );
    expect(configResponse.status).toBe(503);
    expect(await configResponse.json()).toMatchObject({
      error: {
        code: "ai_unavailable",
        message: "Shrnutí není dostupné. Poznámky lze dál upravovat ručně.",
      },
    });
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
