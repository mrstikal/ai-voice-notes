import { describe, expect, it } from "vitest";

import {
  TranscriptSession,
  appendCommittedText,
  insertCommittedTextAtCursor,
} from "../../src/lib/voice/transcript-session";

describe("TranscriptSession", () => {
  it("accepts committed events once in callback order with a local sequence", () => {
    const session = new TranscriptSession();

    expect(session.accept({ text: "První věta." })).toEqual({
      sequence: 1,
      text: "První věta.",
      providerId: null,
    });
    expect(session.accept({ text: "Druhá věta." })).toEqual({
      sequence: 2,
      text: "Druhá věta.",
      providerId: null,
    });
  });

  it("retains identical legitimate text and dedupes only an identified event", () => {
    const session = new TranscriptSession();

    expect(
      session.accept({ text: "Stejná věta.", providerId: "segment-1" }),
    ).toMatchObject({ sequence: 1, text: "Stejná věta." });
    expect(
      session.accept({ text: "Stejná věta.", providerId: "segment-1" }),
    ).toBeNull();
    expect(
      session.accept({ text: "Stejná věta.", providerId: "segment-2" }),
    ).toMatchObject({ sequence: 2, text: "Stejná věta." });
    expect(session.accept({ text: "Stejná věta." })).toMatchObject({
      sequence: 3,
      text: "Stejná věta.",
    });
    expect(session.accept({ text: "Stejná věta." })).toMatchObject({
      sequence: 4,
      text: "Stejná věta.",
    });
  });

  it("ignores empty text and whitespace-only provider ids", () => {
    const session = new TranscriptSession();

    expect(session.accept({ text: "   " })).toBeNull();
    expect(
      session.accept({ text: "Text", providerId: "   " }),
    ).toMatchObject({ sequence: 1, providerId: null });
    expect(
      session.accept({ text: "Text", providerId: "   " }),
    ).toMatchObject({ sequence: 2, providerId: null });
  });

  it("prevents late callbacks after close", () => {
    const session = new TranscriptSession();

    expect(session.accept({ text: "Před stopem." })).not.toBeNull();
    session.close();

    expect(session.isClosed).toBe(true);
    expect(session.accept({ text: "Pozdní věta." })).toBeNull();
  });
});

describe("committed text insertion", () => {
  it("inserts at the visible cursor and returns the next cursor", () => {
    const result = insertCommittedTextAtCursor(
      "Začátek konec",
      "Nadiktovaný text",
      7,
    );

    expect(result.content).toBe("Začátek Nadiktovaný text konec");
    expect(result.cursor).toBe("Začátek Nadiktovaný text".length);
  });

  it("adds only the spacing needed around the cursor", () => {
    expect(
      insertCommittedTextAtCursor("Ahoj světe", "nový text", 4),
    ).toEqual({
      content: "Ahoj nový text světe",
      cursor: "Ahoj nový text".length,
    });
    expect(
      insertCommittedTextAtCursor("Ahoj ", "světe", 5),
    ).toEqual({
      content: "Ahoj světe",
      cursor: 10,
    });
    expect(
      insertCommittedTextAtCursor("Ahoj", "světe", 4),
    ).toEqual({
      content: "Ahoj světe",
      cursor: 10,
    });
  });

  it("preserves repeated legitimate segments instead of deduping text", () => {
    const first = insertCommittedTextAtCursor(
      "",
      "Opakovaná věta.",
      0,
    );
    const second = insertCommittedTextAtCursor(
      first.content,
      "Opakovaná věta.",
      first.cursor,
    );

    expect(second.content).toBe(
      "Opakovaná věta. Opakovaná věta.",
    );
  });

  it("appends at the explicit end with a single separator", () => {
    expect(appendCommittedText("", "První.")).toBe("První.");
    expect(appendCommittedText("První.", "Druhá.")).toBe(
      "První. Druhá.",
    );
    expect(appendCommittedText("První.\n", "Druhá.")).toBe(
      "První.\nDruhá.",
    );
    expect(appendCommittedText("První. ", "Druhá.")).toBe(
      "První. Druhá.",
    );
  });
});
