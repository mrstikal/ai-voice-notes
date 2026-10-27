import { describe, expect, it } from "vitest";

import type { LlmOperation } from "../../src/lib/ai/schemas";
import {
  hashNoteSource,
  resolveOperation,
  type ResolveOperationInput,
} from "../../src/lib/notes/operations";

const BASE = "První věta. Druhá věta.";

function resolve(
  contentMd: string,
  operation: LlmOperation,
  options: Partial<ResolveOperationInput> = {},
) {
  return resolveOperation({
    contentMd,
    operation,
    noteVersion: 1,
    ...options,
  });
}

const replaceFirst: LlmOperation = {
  type: "replace_sentence",
  target: { startPhrase: "První", endPhrase: "věta" },
  text: "Nová věta.",
};

describe("P22 pure AST operation resolver", () => {
  it("resolves a unique sentence and preserves the exact prefix and suffix bytes", () => {
    const result = resolve(BASE, replaceFirst);

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;

    expect(result.afterMd).toBe("Nová věta. Druhá věta.");
    expect(result.diff).toMatchObject({
      start: 0,
      end: "První věta.".length,
      removed: "První věta.",
      inserted: "Nová věta.",
      prefix: "",
      suffix: " Druhá věta.",
    });
    expect(result.afterMd.slice(0, result.diff.start)).toBe(result.diff.prefix);
    expect(result.afterMd.slice(result.diff.start + result.diff.inserted.length)).toBe(
      result.diff.suffix,
    );
  });

  it("returns no match for an absent phrase and does not guess", () => {
    const result = resolve(BASE, {
      ...replaceFirst,
      target: { startPhrase: "Třetí", endPhrase: "věta" },
    });

    expect(result.status).toBe("no_match");
    expect(result).toMatchObject({ code: "operation_no_match" });
    expect(result).not.toHaveProperty("afterMd");
  });

  it("returns numbered candidates for two matching sentences and binds a selected candidate", () => {
    const content = "Stejná věta. Jiná věta. Stejná věta.";
    const operation: LlmOperation = {
      ...replaceFirst,
      target: { startPhrase: "Stejná", endPhrase: "věta" },
      text: "Upravená věta.",
    };

    const ambiguous = resolve(content, operation);
    expect(ambiguous.status).toBe("ambiguous");
    if (ambiguous.status !== "ambiguous") return;
    expect(ambiguous.candidates).toHaveLength(2);
    expect(ambiguous.candidates.map((candidate) => candidate.ordinal)).toEqual([
      1, 2,
    ]);
    expect(ambiguous.candidates[0]!.snippet).toBe("Stejná věta.");

    const selected = resolve(content, operation, {
      candidateId: ambiguous.candidates[1]!.id,
      expectedVersion: 1,
      expectedSourceHash: hashNoteSource(content),
    });
    expect(selected.status).toBe("resolved");
    if (selected.status !== "resolved") return;
    expect(selected.afterMd).toBe(
      "Stejná věta. Jiná věta. Upravená věta.",
    );
    expect(selected.afterMd.match(/Stejná věta\./gu)).toHaveLength(1);
  });

  it("never matches a phrase inside a fenced code block", () => {
    const result = resolve(
      "```\nPrvní věta.\n```",
      replaceFirst,
    );

    expect(result.status).toBe("no_match");
  });

  it("rejects unsupported inline markup instead of crossing AST nodes", () => {
    const result = resolve(
      "**První věta.** Druhá věta.",
      replaceFirst,
    );

    expect(result.status).toBe("invalid");
    expect(result).toMatchObject({ code: "unsupported_inline_markup" });
    expect(result).not.toHaveProperty("afterMd");
  });

  it("fails closed when the same target also occurs in unsupported markup", () => {
    const content =
      "První věta. Druhá věta.\n\nÚvod. **První věta.** Závěr.";
    const result = resolve(content, replaceFirst);

    expect(result.status).toBe("invalid");
    expect(result).toMatchObject({ code: "unsupported_inline_markup" });

    const selected = resolve(content, replaceFirst, {
      candidateId: "p0:s0",
      expectedVersion: 1,
      expectedSourceHash: hashNoteSource(content),
    });
    expect(selected.status).toBe("resolved");
    if (selected.status === "resolved") {
      expect(selected.afterMd).toBe(
        "Nová věta. Druhá věta.\n\nÚvod. **První věta.** Závěr.",
      );
    }
  });

  it("removes exactly one separator when deleting a middle sentence", () => {
    const result = resolve("První věta. Prostřední věta. Třetí věta.", {
      type: "delete_sentence",
      target: { startPhrase: "Prostřední", endPhrase: "věta" },
    });

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.afterMd).toBe("První věta. Třetí věta.");
    }
  });

  it("maps soft and hard line breaks without excluding the paragraph", () => {
    const soft = resolve("První věta.\nDruhá věta.", replaceFirst);
    expect(soft.status).toBe("resolved");
    if (soft.status === "resolved") {
      expect(soft.afterMd).toBe("Nová věta.\nDruhá věta.");
      expect(soft.diff.suffix).toBe("\nDruhá věta.");
    }

    const hard = resolve("První věta.  \nDruhá věta.", replaceFirst);
    expect(hard.status).toBe("resolved");
    if (hard.status === "resolved") {
      expect(hard.afterMd).toBe("Nová věta.  \nDruhá věta.");
    }

    const wrapped = resolve("Příliš dlouhá\nvěta.", {
      type: "replace_last_sentence",
      text: "Nová věta.",
    });
    expect(wrapped.status).toBe("resolved");
    if (wrapped.status === "resolved") {
      expect(wrapped.afterMd).toBe("Nová věta.");
      expect(wrapped.diff.removed).toBe("Příliš dlouhá\nvěta.");
    }

    const multipleSpaces = resolve("První  věta. Druhá věta.", replaceFirst);
    expect(multipleSpaces.status).toBe("resolved");
    if (multipleSpaces.status === "resolved") {
      expect(multipleSpaces.afterMd).toBe("Nová věta. Druhá věta.");
    }

    const indentedHardBreak = resolve(
      "První věta.  \n  Druhá věta.",
      replaceFirst,
    );
    expect(indentedHardBreak.status).toBe("resolved");
    if (indentedHardBreak.status === "resolved") {
      expect(indentedHardBreak.afterMd).toBe(
        "Nová věta.  \n  Druhá věta.",
      );
    }
  });

  it("requires a version and source hash for an explicitly selected candidate", () => {
    const content = "Stejná věta. Jiná věta. Stejná věta.";
    const operation: LlmOperation = {
      ...replaceFirst,
      target: { startPhrase: "Stejná", endPhrase: "věta" },
      text: "Upravená věta.",
    };
    const ambiguous = resolve(content, operation);
    if (ambiguous.status !== "ambiguous") {
      throw new Error("expected ambiguity");
    }

    const unbound = resolve(content, operation, {
      candidateId: ambiguous.candidates[1]!.id,
    });
    expect(unbound.status).toBe("invalid");
    expect(unbound).toMatchObject({ code: "candidate_binding_required" });
  });

  it("replaces only one paragraph and leaves the other bytes unchanged", () => {
    const content = "První odstavec.\n\nDruhý odstavec.";
    const result = resolve(content, {
      type: "replace_paragraph",
      target: { startPhrase: "První", endPhrase: "odstavec" },
      text: "Nahrazený odstavec.",
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.afterMd).toBe("Nahrazený odstavec.\n\nDruhý odstavec.");
    expect(result.afterMd.endsWith("\n\nDruhý odstavec.")).toBe(true);
  });

  it("enforces paragraph and append grapheme bounds", () => {
    const tooLong = "a".repeat(2_001);
    const paragraph = resolve(`${tooLong}\n\nBezpečný.`, {
      type: "replace_paragraph",
      target: { startPhrase: "a", endPhrase: "a" },
      text: "Krátké.",
    });

    expect(paragraph.status).toBe("invalid");
    expect(paragraph).toMatchObject({ code: "paragraph_too_large" });

    const atLimit = resolve("Text.", {
      type: "append_bounded_section",
      text: "a".repeat(2_000),
    });
    expect(atLimit.status).toBe("resolved");

    const append = resolve("Text.", {
      type: "append_bounded_section",
      text: tooLong,
    });
    expect(append.status).toBe("invalid");
    expect(append).toMatchObject({ code: "operation_invalid" });
  });

  it("appends a bounded section with an exact separator and preserves all original bytes", () => {
    const content = "Původní text.";
    const result = resolve(content, {
      type: "append_bounded_section",
      text: "Nový odstavec.",
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.afterMd).toBe("Původní text.\n\nNový odstavec.");
    expect(result.afterMd.startsWith(content)).toBe(true);
    expect(result.diff).toMatchObject({
      start: content.length,
      end: content.length,
      removed: "",
      inserted: "\n\nNový odstavec.",
    });
  });

  it("inserts a bounded heading before a sentence and keeps the target text", () => {
    const result = resolve(BASE, {
      type: "insert_heading_before_sentence",
      target: { startPhrase: "Druhá", endPhrase: "věta" },
      depth: 2,
      text: "Nadpis",
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.afterMd).toBe(
      "První věta. \n\n## Nadpis\n\nDruhá věta.",
    );
    expect(result.afterMd).toContain("## Nadpis");
    expect(result.afterMd).toContain("Druhá věta.");
  });

  it("enforces heading depth, length and single-line bounds", () => {
    const base = {
      type: "insert_heading_before_sentence" as const,
      target: { startPhrase: "První", endPhrase: "věta" },
    };

    for (const operation of [
      { ...base, depth: 4, text: "Nadpis" },
      { ...base, depth: 1, text: "" },
      { ...base, depth: 1, text: "a".repeat(161) },
      { ...base, depth: 1, text: "Nadpis\nDruhý" },
    ]) {
      const result = resolve(BASE, operation as LlmOperation);
      expect(result.status).toBe("invalid");
    }
  });

  it("rejects model-supplied offsets and whole-document operations", () => {
    const offsetOperation = {
      ...replaceFirst,
      offset: 0,
    } as unknown as LlmOperation;
    const offset = resolve(BASE, offsetOperation);
    expect(offset.status).toBe("invalid");
    expect(offset).toMatchObject({ code: "operation_invalid" });

    const documentOperation = {
      type: "replace_document",
      markdown: BASE,
    } as unknown as LlmOperation;
    const document = resolve(BASE, documentOperation);
    expect(document.status).toBe("invalid");
    expect(document).toMatchObject({ code: "operation_invalid" });
    expect(document).not.toHaveProperty("afterMd");
  });

  it("handles insert before/after and delete with bounded whitespace", () => {
    const before = resolve(BASE, {
      type: "insert_before_sentence",
      target: { startPhrase: "Druhá", endPhrase: "věta" },
      text: "Vložená věta.",
    });
    expect(before.status).toBe("resolved");
    if (before.status === "resolved") {
      expect(before.afterMd).toBe(
        "První věta. Vložená věta. Druhá věta.",
      );
    }

    const after = resolve(BASE, {
      type: "insert_after_sentence",
      target: { startPhrase: "První", endPhrase: "věta" },
      text: "Vložená věta.",
    });
    expect(after.status).toBe("resolved");
    if (after.status === "resolved") {
      expect(after.afterMd).toBe(
        "První věta. Vložená věta. Druhá věta.",
      );
    }

    const deleted = resolve(BASE, {
      type: "delete_sentence",
      target: { startPhrase: "První", endPhrase: "věta" },
    });
    expect(deleted.status).toBe("resolved");
    if (deleted.status === "resolved") {
      expect(deleted.afterMd).toBe("Druhá věta.");
    }
  });

  it("replaces the last sentence only", () => {
    const result = resolve(BASE, {
      type: "replace_last_sentence",
      text: "Poslední nová věta.",
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.afterMd).toBe("První věta. Poslední nová věta.");
  });

  it("reports duplicate tasks and toggles exactly the selected checkbox", () => {
    const content = [
      "- [ ] Koupit mléko",
      "- [x] Zavolat lékaři",
      "- [ ] Koupit mléko",
    ].join("\n");
    const operation: LlmOperation = {
      type: "set_task_checked",
      taskText: "Koupit mléko",
      checked: true,
    };

    const ambiguous = resolve(content, operation);
    expect(ambiguous.status).toBe("ambiguous");
    if (ambiguous.status !== "ambiguous") return;
    expect(ambiguous.candidates.map((candidate) => candidate.ordinal)).toEqual([
      1, 2,
    ]);
    expect(ambiguous.candidates.map((candidate) => candidate.checked)).toEqual([
      false,
      false,
    ]);

    const selected = resolve(content, operation, {
      candidateId: ambiguous.candidates[1]!.id,
      expectedVersion: 1,
      expectedSourceHash: hashNoteSource(content),
    });
    expect(selected.status).toBe("resolved");
    if (selected.status !== "resolved") return;
    expect(selected.afterMd).toBe(
      [
        "- [ ] Koupit mléko",
        "- [x] Zavolat lékaři",
        "- [x] Koupit mléko",
      ].join("\n"),
    );
    expect(selected.diff.removed).toBe(" ");
    expect(selected.diff.inserted).toBe("x");
  });

  it("rejects stale versions, mismatched source hashes and deleted notes", () => {
    const hash = hashNoteSource(BASE);

    const version = resolve(BASE, replaceFirst, {
      expectedVersion: 2,
      expectedSourceHash: hash,
    });
    expect(version.status).toBe("stale");
    expect(version).toMatchObject({ code: "version_mismatch" });

    const source = resolve(BASE, replaceFirst, {
      expectedVersion: 1,
      expectedSourceHash: "a".repeat(64),
    });
    expect(source.status).toBe("stale");
    expect(source).toMatchObject({ code: "source_mismatch" });

    const deleted = resolve(BASE, replaceFirst, {
      deletedAt: new Date("2026-10-27T10:00:00Z"),
    });
    expect(deleted.status).toBe("invalid");
    expect(deleted).toMatchObject({ code: "note_deleted" });
  });

  it("does not accept model-supplied offsets or a whole-document replacement", () => {
    const result = resolve(BASE, {
      type: "append_bounded_section",
      text: "Bezpečný text.",
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.diff.start).toBe(BASE.length);
    expect(result.afterMd.startsWith(BASE)).toBe(true);
    expect(JSON.stringify(result.operation)).not.toContain("offset");
    expect(JSON.stringify(result.operation)).not.toContain("beforeMd");
  });
});
