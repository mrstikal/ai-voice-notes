import { describe, expect, it, vi } from "vitest";

import {
  CLEANUP_PARAGRAPH_MAX_GRAPHEMES,
  CleanupError,
  collectCleanupParagraphs,
  normalizeProperNames,
  suggestCleanup,
  validateCleanupText,
  validateProperNames,
} from "../../src/lib/ai/cleanup";
import type { LlmEditResponse } from "../../src/lib/ai/schemas";
import type { StructuredLlmService } from "../../src/lib/ai/structured";
import {
  hashNoteSource,
  resolveOperation,
} from "../../src/lib/notes/operations";

const original = [
  "Já jsem já jsem se včera ehm sešel s Janem Novákem a měl jsem 3 schůzky.",
  "",
  "Druhý odstavec zůstává beze změny.",
].join("\n");
const cleaned =
  "Včera jsem se sešel s Janem Novákem a měl jsem 3 schůzky.";

function fakeLlm(
  response: LlmEditResponse | (() => Promise<LlmEditResponse>),
): Pick<StructuredLlmService, "request"> & {
  request: ReturnType<typeof vi.fn>;
} {
  return {
    request: vi.fn(
      typeof response === "function"
        ? response
        : async () => response,
    ),
  } as Pick<StructuredLlmService, "request"> & {
    request: ReturnType<typeof vi.fn>;
  };
}

function replaceParagraphResponse(text: string): LlmEditResponse {
  return {
    kind: "operation",
    operation: {
      type: "replace_paragraph",
      target: { startPhrase: "Já", endPhrase: "schůzky." },
      text,
    },
  };
}

async function suggest(
  llm: Pick<StructuredLlmService, "request">,
  options: {
    readonly blockIndex?: number;
    readonly properNames?: readonly string[];
    readonly contentMd?: string;
  } = {},
) {
  return suggestCleanup({
    note: { contentMd: options.contentMd ?? original },
    blockIndex: options.blockIndex ?? 0,
    properNames: options.properNames ?? ["Janem Novákem"],
    llm,
  });
}

describe("cleanup paragraph selection", () => {
  it("offers only supported plain prose paragraphs within the bound", () => {
    const content = [
      "# Nadpis",
      "",
      "První prostý odstavec.",
      "",
      "- odrážka",
      "",
      `Dlouhý ${"x".repeat(CLEANUP_PARAGRAPH_MAX_GRAPHEMES)}`,
    ].join("\n");

    expect(collectCleanupParagraphs(content).map((item) => item.text)).toEqual([
      "První prostý odstavec.",
    ]);
  });

  it("excludes paragraphs with hard line breaks from cleanup targets", async () => {
    const hardBreak = "První řádek  \nDruhý řádek.";
    const paragraphs = collectCleanupParagraphs(hardBreak);

    expect(paragraphs).toEqual([]);
    await expect(
      suggest(fakeLlm(replaceParagraphResponse("Spojený řádek.")), {
        blockIndex: 0,
        contentMd: hardBreak,
        properNames: [],
      }),
    ).rejects.toMatchObject({ code: "cleanup_paragraph_hard_break" });
  });

  it("rejects headings, tasks, code and oversized paragraphs before billing", async () => {
    const llm = fakeLlm(replaceParagraphResponse(cleaned));
    const headingContent = "# Nadpis\n\nProstý odstavec.";

    await expect(
      suggest(llm, { blockIndex: 0, contentMd: headingContent }),
    ).rejects.toMatchObject({
      code: "cleanup_paragraph_unsupported",
      status: 422,
    });

    const longContent = "x".repeat(CLEANUP_PARAGRAPH_MAX_GRAPHEMES + 1);
    await expect(
      suggest(llm, { blockIndex: 0, contentMd: longContent }),
    ).rejects.toMatchObject({
      code: "cleanup_paragraph_too_large",
      status: 422,
    });

    expect(llm.request).not.toHaveBeenCalled();
  });

  it("normalizes duplicate proper names and rejects names outside the paragraph", () => {
    expect(
      normalizeProperNames([" Jan  Novák ", "Jan Novák", "", "Praha"]),
    ).toEqual(["Jan Novák", "Praha"]);

    expect(() =>
      validateProperNames(["Petr"], "Odstavec bez Karla."),
    ).toThrow(CleanupError);

    expect(() =>
      validateProperNames(
        [Array.from({ length: 81 }, () => "a").join("")],
        "aaaa",
      ),
    ).toThrow(CleanupError);
  });
});

describe("cleanup suggestion safety", () => {
  it("cleans repeated filler, keeps numbers/names and changes only the selected paragraph", async () => {
    const llm = fakeLlm(replaceParagraphResponse(cleaned));
    const result = await suggest(llm);

    expect(result.cleanedText).toBe(cleaned);
    expect(result.operation.type).toBe("replace_paragraph");
    expect(result.operation.text).toBe(cleaned);
    expect(result.operation.target.startPhrase).toBe(original.split("\n\n")[0]!);

    const prompt = String(llm.request.mock.calls[0]?.[0]?.prompt);
    expect(prompt).toContain("Janem Novákem");
    expect(prompt).toContain("requiredTarget");
    expect(prompt).not.toContain("Druhý odstavec");

    const resolution = resolveOperation({
      contentMd: original,
      operation: result.operation,
      noteVersion: 1,
      expectedVersion: 1,
      expectedSourceHash: hashNoteSource(original),
      candidateId: "p0",
    });

    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.beforeMd).toBe(original);
    expect(resolution.afterMd).toBe(
      `${cleaned}\n\nDruhý odstavec zůstává beze změny.`,
    );
    expect(resolution.candidate?.blockIndex).toBe(0);
  });

  it("rejects an altered number, altered proper name and added task marker", async () => {
    const numberLlm = fakeLlm(
      replaceParagraphResponse(
        "Včera jsem se sešel s Janem Novákem a měl jsem 4 schůzky.",
      ),
    );
    await expect(suggest(numberLlm)).rejects.toMatchObject({
      code: "cleanup_numeric_changed",
    });

    const nameLlm = fakeLlm(
      replaceParagraphResponse(
        "Včera jsem se sešel s Honzou Novákem a měl jsem 3 schůzky.",
      ),
    );
    await expect(suggest(nameLlm)).rejects.toMatchObject({
      code: "cleanup_name_changed",
    });

    const taskLlm = fakeLlm(
      replaceParagraphResponse(
        "Včera jsem se sešel s Janem Novákem.\n- [ ] úkol",
      ),
    );
    await expect(
      suggest(taskLlm, { properNames: [] }),
    ).rejects.toMatchObject({
      code: "cleanup_structure_changed",
    });

    const markdownLlm = fakeLlm(
      replaceParagraphResponse(
        "# Včera jsem se sešel s Janem Novákem a měl jsem 3 schůzky.",
      ),
    );
    await expect(
      suggest(markdownLlm, { properNames: [] }),
    ).rejects.toMatchObject({
      code: "cleanup_structure_changed",
    });
  });

  it("rejects inline Markdown, links and raw HTML in the returned paragraph", async () => {
    const variants = [
      "Včera jsem se sešel s **Janem Novákem** a měl jsem 3 schůzky.",
      "Včera jsem se sešel s [Janem Novákem](https://example.com) a měl jsem 3 schůzky.",
      "Včera <b>jsem</b> se sešel s Janem Novákem a měl jsem 3 schůzky.",
      "Včera jsem se sešel s `Janem Novákem` a měl jsem 3 schůzky.",
    ];

    for (const text of variants) {
      await expect(
        suggest(fakeLlm(replaceParagraphResponse(text)), { properNames: [] }),
      ).rejects.toMatchObject({ code: "cleanup_structure_changed" });
    }
  });

  it("keeps generated target phrases within the provider schema code-unit bound", async () => {
    const emoji = "👍".repeat(100);
    const content = `${emoji} Já jsem já jsem ehm přišel na schůzku 3.`;
    const result = await suggest(
      fakeLlm(
        replaceParagraphResponse(`${emoji} Přišel jsem na schůzku 3.`),
      ),
      { contentMd: content, properNames: [] },
    );

    expect(result.operation.target.startPhrase.length).toBeLessThanOrEqual(160);
    expect(result.operation.target.endPhrase.length).toBeLessThanOrEqual(160);
    expect(
      resolveOperation({
        contentMd: content,
        operation: result.operation,
        noteVersion: 1,
        expectedVersion: 1,
        expectedSourceHash: hashNoteSource(content),
        candidateId: "p0",
      }).status,
    ).toBe("resolved");
  });

  it("does not treat a legitimate leading day number as Markdown", async () => {
    const content = "Dne 3. března jsem se sešel s Janem Novákem.";
    const result = await suggest(
      fakeLlm(
        replaceParagraphResponse(
          "Dne 3. března jsme se sešli s Janem Novákem.",
        ),
      ),
      { contentMd: content, properNames: ["Janem Novákem"] },
    );

    expect(result.cleanedText).toBe(
      "Dne 3. března jsme se sešli s Janem Novákem.",
    );
  });

  it("requires whole-name boundaries so a longer name cannot bypass the lock", () => {
    expect(() =>
      validateCleanupText({
        originalText: "Jan přišel včas.",
        cleanedText: "Janák přišel včas.",
        properNames: ["Jan"],
      }),
    ).toThrow(CleanupError);

    expect(
      validateCleanupText({
        originalText: "Jan přišel včas.",
        cleanedText: "Jan přišel dnes včas.",
        properNames: ["Jan"],
      }),
    ).toBe("Jan přišel dnes včas.");
  });

  it("rejects no-op, wrong operation kind and provider failure without touching a note", async () => {
    await expect(
      suggest(fakeLlm(replaceParagraphResponse(original.split("\n\n")[0]!))),
    ).rejects.toMatchObject({ code: "cleanup_no_change" });

    await expect(
      suggest(
        fakeLlm({
          kind: "operation",
          operation: {
            type: "append_bounded_section",
            text: "Text.",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "cleanup_model_invalid" });

    await expect(
      suggest(
        fakeLlm(async () => {
          throw new Error("Poskytovatel selhal.");
        }),
      ),
    ).rejects.toThrow("Poskytovatel selhal.");
  });

  it("validates locked tokens directly for defensive reuse", () => {
    expect(
      validateCleanupText({
        originalText: "Měl 3 schůzky s Janem Novákem.",
        cleanedText: "Dnes měl 3 schůzky s Janem Novákem.",
        properNames: ["Janem Novákem"],
      }),
    ).toBe("Dnes měl 3 schůzky s Janem Novákem.");
  });
});
