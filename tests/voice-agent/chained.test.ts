import { describe, expect, it, vi } from "vitest";

import { StructuredLlmError } from "../../src/lib/ai/structured";
import { parseNoteMarkdown } from "../../src/lib/notes/markdown";
import { hashNoteSource } from "../../src/lib/notes/operations";
import {
  EditProposalAmbiguousError,
  PROPOSAL_EXPIRY_MS,
  type CreatedEditProposalDto,
} from "../../src/lib/notes/proposals";
import { NoteNotFoundError, type NoteDetailDto } from "../../src/lib/notes/service";
import type { SearchResult } from "../../src/lib/search/fts";
import {
  generateChainedSummary,
  runChainedTurn,
  type ChainedDependencies,
} from "../../src/lib/voice/chained-controller";
import {
  CHAINED_INTENT_JSON_SCHEMA,
  CHAINED_NOTE_PREVIEW_MAX_GRAPHEMES,
  CHAINED_SESSION_MAX_MS,
  CHAINED_TRANSCRIPT_MAX_GRAPHEMES,
  ChainedIntentError,
  appendTranscriptSegment,
  isTodoCommand,
  normalizeTodoText,
  buildChainedIntentPrompt,
  interpretChainedIntent,
  parseChainedIntent,
} from "../../src/lib/voice/chained-intent";
import { createReadServices } from "../../src/lib/voice-agent/read-services";
import { createChainedRouteHandler } from "../../src/app/api/voice-agent/chained/route";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const CONTENT = [
  "# Migrace",
  "",
  "První odstavec o databázi.",
  "",
  "- [ ] Ověřit kompatibilitu",
  "",
  "Poslední odstavec o API.",
].join("\n");

function note(overrides: Partial<NoteDetailDto> = {}): NoteDetailDto {
  return {
    category: null,
    contentMd: CONTENT,
    contentPlain: parseNoteMarkdown(CONTENT).plainText,
    createdAt: new Date(NOW),
    deletedAt: null,
    id: "11111111-1111-4111-8111-111111111111",
    tags: [],
    title: "Migrace",
    updatedAt: new Date(NOW),
    version: 3,
    ...overrides,
  };
}

function searchResult(): SearchResult {
  return {
    empty: false,
    hasNext: false,
    items: [
      {
        category: null,
        id: note().id,
        snippet: "[[[Migrace]]]",
        tags: [],
        title: "Migrace",
        updatedAt: new Date(NOW),
      },
    ],
    page: 1,
    pageSize: 10,
    query: "migrace",
    total: 1,
  };
}

function proposal(): CreatedEditProposalDto {
  return {
    afterMd: `${CONTENT}\n\n- [ ] Koupit mléko`,
    beforeMd: CONTENT,
    confirmationNonce: "n".repeat(43),
    createdAt: new Date(NOW),
    diff: {
      end: CONTENT.length,
      inserted: "\n\n- [ ] Koupit mléko",
      prefix: CONTENT,
      removed: "",
      start: CONTENT.length,
      suffix: "",
    },
    expectedVersion: 3,
    expiresAt: new Date(NOW + PROPOSAL_EXPIRY_MS),
    id: "22222222-2222-4222-8222-222222222222",
    noteId: note().id,
    noteTitle: "Migrace",
    operation: { text: "- [ ] Koupit mléko", type: "append_bounded_section" },
    originalHash: hashNoteSource(CONTENT),
    selectedCandidate: null,
    status: "pending",
    updatedAt: new Date(NOW),
  };
}

function intent(partial: {
  action:
    | "search_notes"
    | "get_note"
    | "read_note_section"
    | "summarize_note"
    | "propose_edit"
    | "unclear";
  clarification?: string | null;
  operation?: unknown;
  query?: string | null;
  section?: "last_paragraph" | "tasks" | "selection" | null;
}) {
  return {
    action: partial.action,
    clarification: partial.clarification ?? null,
    operation: partial.operation ?? null,
    query: partial.query ?? null,
    section: partial.section ?? null,
  };
}

function harness(intentResponse: unknown) {
  const notes = new Map([[note().id, note()]]);
  const llm = {
    requestChainedIntent: vi.fn(async () => intentResponse),
    requestSummary: vi.fn(async () => ({ summaryText: "Shrnutí migrace." })),
  };
  const create = vi.fn(async () => proposal());
  const dependencies: ChainedDependencies = {
    llm: llm as never,
    proposals: { create },
    readServices: createReadServices({
      getNote: async (noteId) => {
        const value = notes.get(noteId);

        if (!value) {
          throw new NoteNotFoundError();
        }

        return value;
      },
      searchNotes: async () => searchResult(),
    }),
  };

  return { create, dependencies, llm, notes };
}

describe("P52 chained intent", () => {
  it("bounds the transcript and rejects actions outside the allowlist", () => {
    expect(CHAINED_SESSION_MAX_MS).toBe(10 * 60_000);
    expect(CHAINED_TRANSCRIPT_MAX_GRAPHEMES).toBe(600);
    expect(CHAINED_NOTE_PREVIEW_MAX_GRAPHEMES).toBe(1_200);
    expect(CHAINED_INTENT_JSON_SCHEMA).toHaveProperty("properties.action");

    expect(
      parseChainedIntent(intent({ action: "search_notes", query: "migrace" })),
    ).toEqual({ action: "search_notes", query: "migrace" });

    expect(() =>
      parseChainedIntent({
        ...intent({ action: "search_notes", query: "migrace" }),
        action: "delete_note",
      }),
    ).toThrow(ChainedIntentError);

    expect(() =>
      parseChainedIntent({
        ...intent({ action: "search_notes", query: "migrace" }),
        noteId: note().id,
      }),
    ).toThrow(ChainedIntentError);

    expect(() =>
      parseChainedIntent(
        intent({
          action: "propose_edit",
          operation: {
            expectedVersion: 3,
            text: "Nový text.",
            type: "replace_last_sentence",
          },
        }),
      ),
    ).toThrow(ChainedIntentError);
  });

  it("sends only transcript data and selection flags to the intent model", async () => {
    const llm = {
      requestChainedIntent: vi.fn(async () =>
        intent({ action: "read_note_section", section: "last_paragraph" }),
      ),
    };

    await interpretChainedIntent(
      {
        hasSelectedNote: true,
        hasSelection: false,
        transcript: "Přečti poslední odstavec.",
      },
      llm as never,
    );

    const prompt =
      (
        llm.requestChainedIntent.mock.calls[0] as unknown as
          | [{ readonly prompt: string }]
          | undefined
      )?.[0]?.prompt ?? "";
    expect(prompt).toContain("Přečti poslední odstavec.");
    expect(prompt).toContain("\"hasSelectedNote\":true");
    expect(prompt).not.toContain(note().id);
    expect(prompt).not.toContain("\"version\"");
    expect(buildChainedIntentPrompt({
      hasSelectedNote: false,
      hasSelection: true,
      transcript: "x",
    })).toContain("\"hasSelection\":true");
  });

  it("returns search results without a session or note read", async () => {
    const current = harness(intent({ action: "search_notes", query: "migrace" }));

    const outcome = await runChainedTurn(
      { transcript: "Najdi migraci." },
      current.dependencies,
    );

    expect(outcome).toMatchObject({
      empty: false,
      intent: { action: "search_notes", query: "migrace" },
      kind: "search",
      query: "migrace",
      results: [{ noteId: note().id, title: "Migrace" }],
      speechText: null,
    });
    expect(current.create).not.toHaveBeenCalled();
  });

  it("requires a user-selected note before reading or editing", async () => {
    const current = harness(intent({ action: "get_note" }));

    const outcome = await runChainedTurn(
      { transcript: "Přečti poznámku." },
      current.dependencies,
    );

    expect(outcome.kind).toBe("needs_selection");
    expect(outcome.speechText).toContain("vyberte");
  });

  it("reads the exact section and returns bounded speech text", async () => {
    const current = harness(
      intent({ action: "read_note_section", section: "last_paragraph" }),
    );

    const outcome = await runChainedTurn(
      { selectedNoteId: note().id, selectedNoteVersion: 3, transcript: "Přečti poslední odstavec." },
      current.dependencies,
    );

    expect(outcome).toMatchObject({
      kind: "section",
      section: {
        status: "ok",
        text: "Poslední odstavec o API.",
        title: "Migrace",
        version: 3,
      },
      speechText: "Poslední odstavec o API.",
    });
    expect(current.create).not.toHaveBeenCalled();
  });

  it("marks and announces a truncated note read", async () => {
    const current = harness(intent({ action: "get_note" }));
    const long = "a".repeat(1_300);
    current.notes.set(
      note().id,
      note({ contentMd: long, contentPlain: long }),
    );

    const outcome = await runChainedTurn(
      { selectedNoteId: note().id, selectedNoteVersion: 3, transcript: "Přečti poznámku." },
      current.dependencies,
    );

    expect(outcome).toMatchObject({
      kind: "note",
      note: { truncated: true },
    });
    expect(outcome.speechText).toMatch(/prvních\s+1\s+200 znaků/u);
  });

  it("offers a paid summary without calling the summary provider", async () => {
    const current = harness(intent({ action: "summarize_note" }));

    const outcome = await runChainedTurn(
      { selectedNoteId: note().id, selectedNoteVersion: 3, transcript: "Shrň poznámku." },
      current.dependencies,
    );

    expect(outcome).toMatchObject({
      kind: "summary_offer",
      noteId: note().id,
      noteVersion: 3,
      speechText: null,
    });
    expect(typeof (outcome as { configured: boolean }).configured).toBe(
      "boolean",
    );
    expect(current.llm.requestSummary).not.toHaveBeenCalled();

    const summary = await generateChainedSummary(
      { noteId: note().id, expectedVersion: 3 },
      current.dependencies,
    );
    expect(summary).toMatchObject({
      noteVersion: 3,
      summaryText: "Shrnutí migrace.",
    });
    expect(current.llm.requestSummary).toHaveBeenCalledTimes(1);
  });

  it("rejects a selected note version that differs from the reviewed one", async () => {
    const current = harness(intent({ action: "summarize_note" }));

    await expect(
      runChainedTurn(
        {
          selectedNoteId: note().id,
          selectedNoteVersion: 2,
          transcript: "Shrň poznámku.",
        },
        current.dependencies,
      ),
    ).rejects.toMatchObject({ code: "note_stale", status: 409 });
    expect(current.llm.requestSummary).not.toHaveBeenCalled();

    await expect(
      generateChainedSummary(
        { noteId: note().id, expectedVersion: 2 },
        current.dependencies,
      ),
    ).rejects.toMatchObject({ code: "note_stale", status: 409 });
    expect(current.llm.requestSummary).not.toHaveBeenCalled();
  });

  it("refuses a selected note without a reviewed version", async () => {
    const current = harness(intent({ action: "get_note" }));

    await expect(
      runChainedTurn(
        { selectedNoteId: note().id, transcript: "Přečti poznámku." },
        current.dependencies,
      ),
    ).rejects.toMatchObject({ code: "note_stale", status: 409 });
    expect(current.llm.requestSummary).not.toHaveBeenCalled();
  });

  it("accumulates spoken segments and formats a task deterministically", async () => {
    expect(appendTranscriptSegment("Najdi", "migraci.")).toBe("Najdi migraci.");
    expect(appendTranscriptSegment("", "migraci.")).toBe("migraci.");
    expect(isTodoCommand("Přidej úkol koupit mléko.")).toBe(true);
    expect(isTodoCommand("Pridat ukol koupit mleko")).toBe(true);
    expect(isTodoCommand("Přečti poslední odstavec.")).toBe(false);
    expect(isTodoCommand("Vysvětli metodologii migrace.")).toBe(false);
    expect(normalizeTodoText("Koupit mléko")).toBe("- [ ] Koupit mléko");
    expect(normalizeTodoText("- [x] Hotovo")).toBe("- [ ] Hotovo");

    const current = harness(
      intent({
        action: "propose_edit",
        operation: {
          text: "Koupit mléko",
          type: "append_bounded_section",
        },
      }),
    );
    const outcome = await runChainedTurn(
      { selectedNoteId: note().id, selectedNoteVersion: 3, transcript: "Přidej úkol koupit mléko." },
      current.dependencies,
    );

    expect(outcome.kind).toBe("proposal");
    expect(current.create).toHaveBeenCalledWith(
      note().id,
      expect.objectContaining({
        operation: {
          text: "- [ ] Koupit mléko",
          type: "append_bounded_section",
        },
      }),
    );
  });

  it("creates a P23 proposal with the server version and no note mutation", async () => {
    const current = harness(
      intent({
        action: "propose_edit",
        operation: {
          text: "- [ ] Koupit mléko",
          type: "append_bounded_section",
        },
      }),
    );

    const outcome = await runChainedTurn(
      { selectedNoteId: note().id, selectedNoteVersion: 3, transcript: "Přidej úkol koupit mléko." },
      current.dependencies,
    );

    expect(outcome).toMatchObject({
      kind: "proposal",
      proposal: {
        confirmationNonce: "n".repeat(43),
        expectedVersion: 3,
        status: "pending",
      },
    });
    expect(current.create).toHaveBeenCalledWith(note().id, {
      expectedSourceHash: hashNoteSource(CONTENT),
      expectedVersion: 3,
      operation: {
        text: "- [ ] Koupit mléko",
        type: "append_bounded_section",
      },
    });
    expect(current.notes.get(note().id)?.contentMd).toBe(CONTENT);
    expect(current.notes.get(note().id)?.version).toBe(3);
  });

  it("maps ambiguity and provider failures without losing their provider", async () => {
    const ambiguous = harness(
      intent({
        action: "propose_edit",
        operation: { text: "Nový text.", type: "replace_last_sentence" },
      }),
    );
    ambiguous.create.mockRejectedValueOnce(
      new EditProposalAmbiguousError(
        [
          {
            blockIndex: 0,
            id: "p0:s0",
            ordinal: 1,
            sentenceIndex: 0,
            snippet: "První odstavec o databázi.",
            text: "První odstavec o databázi.",
          },
        ],
        3,
        hashNoteSource(CONTENT),
      ),
    );

    await expect(
      runChainedTurn(
        { selectedNoteId: note().id, selectedNoteVersion: 3, transcript: "Nahraď větu." },
        ambiguous.dependencies,
      ),
    ).rejects.toMatchObject({
      code: "proposal_ambiguous",
      provider: "proposal",
      status: 409,
    });

    const unavailable = harness(intent({ action: "get_note" }));
    unavailable.llm.requestChainedIntent.mockRejectedValueOnce(
      new StructuredLlmError(
        503,
        "llm_not_configured",
        "OpenRouter není nakonfigurovaný.",
      ),
    );
    await expect(
      runChainedTurn(
        { selectedNoteId: note().id, selectedNoteVersion: 3, transcript: "Přečti." },
        unavailable.dependencies,
      ),
    ).rejects.toMatchObject({
      code: "llm_not_configured",
      provider: "openrouter",
      status: 503,
    });
  });
});

describe("P52 chained route", () => {
  it("guards the route and returns the controller outcome without a session id", async () => {
    const current = harness(intent({ action: "search_notes", query: "migrace" }));
    const handler = createChainedRouteHandler({
      dependencies: current.dependencies,
      rateLimit: { limit: 1_000, windowMs: 60_000 },
    });
    const body = {
      kind: "turn",
      transcript: "Najdi migraci.",
    };

    const crossOrigin = await handler(
      new Request("http://127.0.0.1:3000/api/voice-agent/chained", {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1:3000",
          origin: "http://evil.test",
        },
        method: "POST",
      }),
    );
    expect(crossOrigin.status).toBe(403);

    const response = await handler(
      new Request("http://127.0.0.1:3000/api/voice-agent/chained", {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
        },
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      kind: "turn",
      outcome: { kind: "search", results: [{ title: "Migrace" }] },
    });
  });

  it("surfaces the grapheme bound with the ElevenLabs provider", async () => {
    const current = harness(intent({ action: "get_note" }));
    const handler = createChainedRouteHandler({
      dependencies: current.dependencies,
      rateLimit: { limit: 1_000, windowMs: 60_000 },
    });
    const response = await handler(
      new Request("http://127.0.0.1:3000/api/voice-agent/chained", {
        body: JSON.stringify({
          kind: "turn",
          transcript: "a".repeat(601),
        }),
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "chained_transcript_too_large",
        provider: "elevenlabs",
      },
    });
    expect(current.llm.requestChainedIntent).not.toHaveBeenCalled();
  });

  it("maps controller errors with the failed provider", async () => {
    const current = harness(intent({ action: "get_note" }));
    current.llm.requestChainedIntent.mockRejectedValueOnce(
      new StructuredLlmError(503, "llm_not_configured", "OpenRouter chybí."),
    );
    const handler = createChainedRouteHandler({
      dependencies: current.dependencies,
      rateLimit: { limit: 1_000, windowMs: 60_000 },
    });
    const response = await handler(
      new Request("http://127.0.0.1:3000/api/voice-agent/chained", {
        body: JSON.stringify({
          kind: "turn",
          selectedNoteId: note().id,
          selectedNoteVersion: 3,
          transcript: "Přečti.",
        }),
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "llm_not_configured",
        message: "OpenRouter chybí.",
        provider: "openrouter",
      },
    });
    expect(current.create).not.toHaveBeenCalled();
  });
});
