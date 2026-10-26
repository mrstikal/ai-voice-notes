// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NoteEditor } from "../../src/components/notes/NoteEditor";
import type { NoteDetail } from "../../src/lib/notes/client";
import { readStoredDraft } from "../../src/lib/notes/draft";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const emptyRectList = [] as unknown as DOMRectList;
const emptyRect = {
  bottom: 0,
  height: 0,
  left: 0,
  right: 0,
  top: 0,
  width: 0,
  x: 0,
  y: 0,
} as DOMRect;

if (!Range.prototype.getClientRects) {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => emptyRectList,
  });
}

if (!("getClientRects" in Text.prototype)) {
  Object.defineProperty(Text.prototype, "getClientRects", {
    configurable: true,
    value: () => emptyRectList,
  });
}

if (!("getBoundingClientRect" in Text.prototype)) {
  Object.defineProperty(Text.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => emptyRect,
  });
}

if (!Range.prototype.getBoundingClientRect) {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => emptyRect,
  });
}

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

const noteId = "11111111-1111-4111-8111-111111111111";

const baseNote: NoteDetail = {
  category: null,
  contentMd: "Původní text",
  contentPlain: "Původní text",
  createdAt: "2026-10-25T10:00:00.000Z",
  deletedAt: null,
  id: noteId,
  tags: [],
  title: "Testovací poznámka",
  updatedAt: "2026-10-25T10:00:00.000Z",
  version: 1,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function noteResponse(overrides: Partial<NoteDetail> = {}): Response {
  return jsonResponse({ ...baseNote, ...overrides });
}

function conflictResponse(latestVersion: number): Response {
  return jsonResponse(
    {
      error: {
        code: "version_conflict",
        latestVersion,
        message: "Poznámka byla mezitím změněna. Načtěte ji znovu.",
      },
    },
    409,
  );
}

type FetchHandler = (
  url: string,
  init: RequestInit | undefined,
) => Response | Promise<Response>;

function createFetchMock(handler: FetchHandler) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
}

function echoingFetchMock(): ReturnType<typeof createFetchMock> {
  let version = 1;

  return createFetchMock((_url, init) => {
    const body = JSON.parse(String(init?.body)) as { contentMd: string };
    version += 1;

    return noteResponse({
      contentMd: body.contentMd,
      contentPlain: body.contentMd,
      updatedAt: "2026-10-25T11:00:00.000Z",
      version,
    });
  });
}

function sourceTextarea(): HTMLTextAreaElement {
  return screen.getByLabelText("Obsah (Markdown)") as HTMLTextAreaElement;
}

function statusText(): string {
  return screen.getByRole("status").textContent ?? "";
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NoteEditor automatické ukládání konceptu", () => {
  it("uloží rozběhnutou psaní jedním debouncovaným konceptem", async () => {
    const fetchMock = echoingFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<NoteEditor note={baseNote} />);

    fireEvent.change(sourceTextarea(), { target: { value: "Rozběh" } });
    fireEvent.change(sourceTextarea(), { target: { value: "Rozběhnutá" } });
    fireEvent.change(sourceTextarea(), { target: { value: "Rozběhnutá poznámka" } });

    await advance(799);
    expect(fetchMock).not.toHaveBeenCalled();

    await advance(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/notes/${noteId}`);
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      contentMd: "Rozběhnutá poznámka",
      draft: true,
      expectedVersion: 1,
      title: baseNote.title,
    });
  });

  it("zobrazí Ukládá se… a po potvrzení serveru Uloženo s verzí", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<NoteEditor note={baseNote} />);
    fireEvent.change(sourceTextarea(), { target: { value: "Nový text" } });

    await advance(800);
    expect(statusText()).toContain("Ukládá se…");
    expect(statusText()).not.toContain("Uloženo");

    await act(async () => {
      resolveFetch?.(
        noteResponse({
          contentMd: "Nový text",
          contentPlain: "Nový text",
          updatedAt: "2026-10-25T11:00:00.000Z",
          version: 2,
        }),
      );
    });

    expect(statusText()).toContain("Uloženo");
    expect(statusText()).toContain("verze 2");
  });

  it("při chybě neukáže Uloženo a koncept si ponechá v sessionStorage", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("Síť není dostupná");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NoteEditor note={baseNote} />);
    fireEvent.change(sourceTextarea(), { target: { value: "Rozpracovaný text" } });

    await advance(800);

    expect(statusText()).not.toContain("Uloženo");
    expect(screen.getByRole("alert").textContent).toContain(
      "Ukládání konceptu se nezdařilo",
    );
    expect(sourceTextarea().value).toBe("Rozpracovaný text");
    expect(readStoredDraft(noteId)?.contentMd).toBe("Rozpracovaný text");
  });

  it("po úspěšném uložení koncept z sessionStorage vymaže", async () => {
    vi.stubGlobal("fetch", echoingFetchMock());

    render(<NoteEditor note={baseNote} />);
    fireEvent.change(sourceTextarea(), { target: { value: "Uložený text" } });

    expect(readStoredDraft(noteId)?.contentMd).toBe("Uložený text");

    await advance(800);

    expect(readStoredDraft(noteId)).toBeNull();
  });

  it("nabídne neuložený koncept po znovu načtení a obnoví jej", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Síť není dostupná");
      }),
    );

    const first = render(<NoteEditor note={baseNote} />);
    fireEvent.change(sourceTextarea(), { target: { value: "Neuložený text" } });
    await advance(800);
    first.unmount();

    render(<NoteEditor note={baseNote} />);

    expect(
      screen.getByRole("region", { name: "Nalezen neuložený koncept" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Obnovit koncept" }));

    expect(sourceTextarea().value).toBe("Neuložený text");
    expect(
      screen.queryByRole("region", { name: "Nalezen neuložený koncept" }),
    ).toBeNull();
  });

  it("zastaví automatické ukládání při konfliktu a ukáže obě verze", async () => {
    const fetchMock = createFetchMock((url, init) => {
      if (init?.method === "GET") {
        return noteResponse({
          contentMd: "Serverová verze",
          contentPlain: "Serverová verze",
          version: 5,
        });
      }

      return conflictResponse(5);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NoteEditor note={baseNote} />);
    fireEvent.change(sourceTextarea(), { target: { value: "Moje verze" } });

    await advance(800);
    await advance(800);

    expect(
      screen.getByRole("region", { name: "Konflikt uložení" }),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Můj text (verze 1)") as HTMLTextAreaElement).value,
    ).toBe("Moje verze");
    expect(
      (
        screen.getByLabelText(
          "Text na serveru (verze 5)",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("Serverová verze");
    expect(sourceTextarea().value).toBe("Moje verze");
    expect(screen.getByRole("alert").textContent).toContain("Aktuální verze: 5");

    const patchCalls = fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCalls).toHaveLength(1);
  });

  it("vytvoří tlačítkem Uložit pojmenovaný bod obnovy bez příznaku konceptu", async () => {
    const fetchMock = echoingFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<NoteEditor note={baseNote} />);
    fireEvent.change(sourceTextarea(), { target: { value: "Nový text" } });

    await advance(800);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Uložit" }));
    await advance(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, init] = fetchMock.mock.calls[1] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      contentMd: "Nový text",
      expectedVersion: 2,
      title: baseNote.title,
    });
  });

  it("ruční uložení převezme rozpracovaný koncept a neposílá ho dvakrát", async () => {
    const fetchMock = echoingFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<NoteEditor note={baseNote} />);
    fireEvent.change(sourceTextarea(), { target: { value: "Nový text" } });

    fireEvent.click(screen.getByRole("button", { name: "Uložit" }));
    await advance(0);
    await advance(800);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.draft).toBeUndefined();
    expect(body.contentMd).toBe("Nový text");
    expect(sourceTextarea().value).toBe("Nový text");
  });

  it("po ručním uložení zůstane v editoru uložený obsah", async () => {
    const fetchMock = createFetchMock((_url, init) => {
      const body = JSON.parse(String(init?.body)) as { contentMd: string };
      return noteResponse({
        contentMd: body.contentMd,
        contentPlain: body.contentMd,
        updatedAt: "2026-10-25T11:00:00.000Z",
        version: 2,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NoteEditor note={baseNote} />);
    fireEvent.change(sourceTextarea(), { target: { value: "Rozpracovaný text" } });

    await advance(800);
    fireEvent.click(screen.getByRole("button", { name: "Uložit" }));
    await advance(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sourceTextarea().value).toBe("Rozpracovaný text");
  });

  it("posílá požadavky jedno za druhým a nepošle nic neplatného", async () => {
    const pending: Array<(response: Response) => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);

      const response = await new Promise<Response>((resolve) => {
        pending.push(resolve);
      });

      inFlight -= 1;
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NoteEditor note={baseNote} />);
    fireEvent.change(sourceTextarea(), { target: { value: "První" } });

    await advance(800);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.change(sourceTextarea(), { target: { value: "Druhý" } });
    await advance(800);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending[0]?.(
        noteResponse({
          contentMd: "První",
          contentPlain: "První",
          updatedAt: "2026-10-25T11:00:00.000Z",
          version: 2,
        }),
      );
    });

    await advance(800);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);

    const [, secondInit] = fetchMock.mock.calls[1] ?? [];
    expect(JSON.parse(String(secondInit?.body))).toEqual({
      contentMd: "Druhý",
      draft: true,
      expectedVersion: 2,
      title: baseNote.title,
    });
  });

  it("neukládá text překračující limit viditelných znaků", async () => {
    const fetchMock = echoingFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<NoteEditor note={baseNote} />);
    fireEvent.change(sourceTextarea(), { target: { value: "a".repeat(20_001) } });

    await advance(800);
    await advance(800);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("schová panel obnovy konceptu, jakmile uživatel začne psát", async () => {
    vi.stubGlobal("fetch", echoingFetchMock());

    window.sessionStorage.setItem(
      `note-draft:${noteId}:1`,
      JSON.stringify({
        baseVersion: 1,
        contentMd: "Starý koncept",
        noteId,
        savedAt: "2026-10-25T10:05:00.000Z",
      }),
    );

    render(<NoteEditor note={baseNote} />);

    expect(
      screen.getByRole("region", { name: "Nalezen neuložený koncept" }),
    ).toBeTruthy();

    fireEvent.change(sourceTextarea(), { target: { value: "Nový text" } });

    expect(
      screen.queryByRole("region", { name: "Nalezen neuložený koncept" }),
    ).toBeNull();
    expect(readStoredDraft(noteId)?.contentMd).toBe("Nový text");
  });

  it("po konfliktu ručního uložení neukáže, že je vše uloženo", async () => {
    const fetchMock = createFetchMock((_url, init) => {
      if (init?.method === "GET") {
        return noteResponse({
          contentMd: "Serverová verze",
          contentPlain: "Serverová verze",
          version: 9,
        });
      }

      const body = JSON.parse(String(init?.body)) as { draft?: boolean };

      if (body.draft === true) {
        return noteResponse({
          contentMd: "Moje verze",
          contentPlain: "Moje verze",
          updatedAt: "2026-10-25T11:00:00.000Z",
          version: 2,
        });
      }

      return conflictResponse(9);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NoteEditor note={baseNote} />);
    fireEvent.change(sourceTextarea(), { target: { value: "Moje verze" } });

    await advance(800);
    expect(statusText()).toContain("Uloženo");

    fireEvent.click(screen.getByRole("button", { name: "Uložit" }));
    await advance(0);

    expect(statusText()).not.toContain("Vše je uloženo");
    expect(statusText()).not.toContain("Uloženo");
    expect(statusText()).toContain("Konflikt uložení");
  });

  it("ruční uložení převezme rozpracovaný koncept během probíhajícího uložení", async () => {
    const pendingDraft: Array<(response: Response) => void> = [];
    const pendingManual: Array<(response: Response) => void> = [];
    let draftCalls = 0;

    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        contentMd: string;
        draft?: boolean;
      };

      if (body.draft === true) {
        draftCalls += 1;

        if (draftCalls === 1) {
          return new Promise<Response>((resolve) => {
            pendingDraft.push(resolve);
          });
        }

        return noteResponse({
          contentMd: body.contentMd,
          contentPlain: body.contentMd,
          updatedAt: "2026-10-25T11:00:00.000Z",
          version: 3,
        });
      }

      return new Promise<Response>((resolve) => {
        pendingManual.push(resolve);
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NoteEditor note={baseNote} />);
    fireEvent.change(sourceTextarea(), { target: { value: "První" } });

    await advance(800);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole("button", { name: "Uložit" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.change(sourceTextarea(), { target: { value: "Druhý" } });
    await advance(800);

    await act(async () => {
      pendingDraft[0]?.(
        noteResponse({
          contentMd: "První",
          contentPlain: "První",
          updatedAt: "2026-10-25T11:00:00.000Z",
          version: 2,
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Uložit" }));
    await advance(0);
    await advance(800);
    await advance(800);

    const patchCalls = fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCalls).toHaveLength(2);

    const bodies = patchCalls.map((call) =>
      JSON.parse(String((call[1] as RequestInit).body)),
    );
    expect(bodies[0].draft).toBe(true);
    expect(bodies[0].contentMd).toBe("První");
    expect(bodies[1].draft).toBeUndefined();
    expect(bodies[1].contentMd).toBe("Druhý");

    await act(async () => {
      pendingManual[0]?.(
        noteResponse({
          contentMd: "Druhý",
          contentPlain: "Druhý",
          updatedAt: "2026-10-25T11:00:00.000Z",
          version: 3,
        }),
      );
    });
  });

  it("zobrazí nalezený koncept ve stavovém řádku a varuje při zavření karty", () => {
    vi.stubGlobal("fetch", echoingFetchMock());

    window.sessionStorage.setItem(
      `note-draft:${noteId}:1`,
      JSON.stringify({
        baseVersion: 1,
        contentMd: "Neuložený koncept",
        noteId,
        savedAt: "2026-10-25T10:05:00.000Z",
      }),
    );

    render(<NoteEditor note={baseNote} />);

    expect(statusText()).toContain("Nalezen neuložený koncept");
    expect(statusText()).not.toContain("Vše je uloženo");

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("obnoví koncept ve vizuálním režimu ve zdrojovém režimu", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", echoingFetchMock());

    window.sessionStorage.setItem(
      `note-draft:${noteId}:1`,
      JSON.stringify({
        baseVersion: 1,
        contentMd: "Obnovený koncept",
        noteId,
        savedAt: "2026-10-25T10:05:00.000Z",
      }),
    );

    const user = userEvent.setup();
    render(<NoteEditor note={baseNote} />);

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));
    await screen.findByRole("textbox", {
      name: "Vizuální editor poznámky",
    });

    fireEvent.click(screen.getByRole("button", { name: "Obnovit koncept" }));

    expect(sourceTextarea().value).toBe("Obnovený koncept");
    expect(
      screen.queryByRole("textbox", { name: "Vizuální editor poznámky" }),
    ).toBeNull();
  });

  it("nepřepíše čekající koncept při přepnutí vizuální → zdrojový režim bez úprav", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", echoingFetchMock());

    window.sessionStorage.setItem(
      `note-draft:${noteId}:1`,
      JSON.stringify({
        baseVersion: 1,
        contentMd: "Původní neuložený koncept",
        noteId,
        savedAt: "2026-10-25T10:05:00.000Z",
      }),
    );

    const user = userEvent.setup();
    render(<NoteEditor note={baseNote} />);

    expect(
      screen.getByRole("region", { name: "Nalezen neuložený koncept" }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));
    await screen.findByRole("textbox", {
      name: "Vizuální editor poznámky",
    });
    await user.click(screen.getByRole("button", { name: "Zdrojový režim" }));

    expect(readStoredDraft(noteId)?.contentMd).toBe("Původní neuložený koncept");
    expect(
      screen.getByRole("region", { name: "Nalezen neuložený koncept" }),
    ).toBeTruthy();
  });

  it("uloží koncept i při neúspěšném ručním uložení ve vizuálním režimu", async () => {
    vi.useRealTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Síť není dostupná");
      }),
    );

    const user = userEvent.setup();
    render(<NoteEditor note={baseNote} />);

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));
    const visual = await screen.findByRole("textbox", {
      name: "Vizuální editor poznámky",
    });
    visual.focus();
    await user.keyboard("x");

    fireEvent.click(screen.getByRole("button", { name: "Uložit" }));

    expect(readStoredDraft(noteId)?.contentMd).toContain("x");
  });

  it("uloží koncept při přepnutí z vizuálního do zdrojového režimu", async () => {
    vi.useRealTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Síť není dostupná");
      }),
    );

    const user = userEvent.setup();
    render(<NoteEditor note={baseNote} />);

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));
    const visual = await screen.findByRole("textbox", {
      name: "Vizuální editor poznámky",
    });
    visual.focus();
    await user.keyboard("x");

    await user.click(screen.getByRole("button", { name: "Zdrojový režim" }));

    expect(sourceTextarea().value).toContain("x");
    expect(readStoredDraft(noteId)?.contentMd).toContain("x");
  });

  it("nenechá panel konfliktu viset na načítání, když serverovou verzi nelze načíst", async () => {
    let getCalls = 0;
    const fetchMock = createFetchMock((_url, init) => {
      if (init?.method === "GET") {
        getCalls += 1;

        if (getCalls === 1) {
          return jsonResponse(
            { error: { code: "not_found", message: "Nenalezeno." } },
            404,
          );
        }

        return noteResponse({
          contentMd: "Serverová verze",
          contentPlain: "Serverová verze",
          version: 5,
        });
      }

      return conflictResponse(5);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NoteEditor note={baseNote} />);
    fireEvent.change(sourceTextarea(), { target: { value: "Moje verze" } });

    await advance(800);

    expect(
      (
        screen.getByLabelText(
          "Text na serveru (verze 5)",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("Serverovou verzi se nepodařilo načíst.");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Zkusit načíst serverovou verzi znovu",
      }),
    );
    await advance(0);

    expect(
      (
        screen.getByLabelText(
          "Text na serveru (verze 5)",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("Serverová verze");
  });

  it("ponechá režim a stav beze změny při opakovaném kliknutí na vizuální režim", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", echoingFetchMock());

    const user = userEvent.setup();
    render(<NoteEditor note={baseNote} />);

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));
    const visual = await screen.findByRole("textbox", {
      name: "Vizuální editor poznámky",
    });
    visual.focus();
    await user.keyboard("x");

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));

    expect(
      screen.getByRole("textbox", { name: "Vizuální editor poznámky" }),
    ).toBeTruthy();
    expect(statusText()).not.toContain("Vše je uloženo");
  });

  it("uloží aktuální zdrojový text, ne starý vizuální dokument", async () => {
    vi.useRealTimers();
    const fetchMock = echoingFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<NoteEditor note={baseNote} />);

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));
    await screen.findByRole("textbox", {
      name: "Vizuální editor poznámky",
    });
    await user.click(screen.getByRole("button", { name: "Zdrojový režim" }));

    fireEvent.change(sourceTextarea(), { target: { value: "Novější zdrojový text" } });

    await user.click(screen.getByRole("button", { name: "Vizuální režim" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Uložit" }));
    });

    const patchCalls = fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
    );
    const body = JSON.parse(
      String((patchCalls[patchCalls.length - 1]?.[1] as RequestInit).body),
    );
    expect(body.contentMd).toBe("Novější zdrojový text");
  });

  it("vymaže koncept, když se obsah vrátí k uloženému textu", async () => {
    vi.stubGlobal("fetch", echoingFetchMock());

    render(<NoteEditor note={baseNote} />);

    fireEvent.change(sourceTextarea(), { target: { value: "Rozpracovaný" } });
    expect(readStoredDraft(noteId)?.contentMd).toBe("Rozpracovaný");

    fireEvent.change(sourceTextarea(), {
      target: { value: baseNote.contentMd },
    });

    expect(readStoredDraft(noteId)).toBeNull();
  });

  it("nepoužije starší odpověď serveru při dvou konfliktech za sebou", async () => {
    const pendingServer: Array<(response: Response) => void> = [];
    let getCalls = 0;

    const fetchMock = createFetchMock((_url, init) => {
      if (init?.method === "GET") {
        getCalls += 1;

        if (getCalls === 1) {
          return new Promise<Response>((resolve) => {
            pendingServer.push(resolve);
          });
        }

        return noteResponse({
          contentMd: "Serverová verze 7",
          contentPlain: "Serverová verze 7",
          version: 7,
        });
      }

      const body = JSON.parse(String(init?.body)) as { draft?: boolean };

      if (body.draft === true) {
        return conflictResponse(5);
      }

      return conflictResponse(7);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NoteEditor note={baseNote} />);
    fireEvent.change(sourceTextarea(), { target: { value: "Moje verze" } });

    await advance(800);
    expect(
      screen.getByRole("region", { name: "Konflikt uložení" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Uložit" }));
    await advance(0);
    await advance(0);

    await act(async () => {
      pendingServer[0]?.(
        noteResponse({
          contentMd: "Serverová verze 5",
          contentPlain: "Serverová verze 5",
          version: 5,
        }),
      );
    });
    await advance(0);

    expect(
      (
        screen.getByLabelText(
          "Text na serveru (verze 7)",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("Serverová verze 7");
  });

  it("varuje před zavřením karty, dokud jsou neuložené změny", () => {
    render(<NoteEditor note={baseNote} />);

    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    fireEvent.change(sourceTextarea(), { target: { value: "Neuložený text" } });

    const dirtyEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);
  });

  it("zobrazí v panelu konfliktu aktuální text editoru", async () => {
    const fetchMock = createFetchMock((_url, init) => {
      if (init?.method === "GET") {
        return noteResponse({
          contentMd: "Serverová verze",
          contentPlain: "Serverová verze",
          version: 5,
        });
      }

      return conflictResponse(5);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NoteEditor note={baseNote} />);
    fireEvent.change(sourceTextarea(), { target: { value: "Moje verze" } });

    await advance(800);

    expect(
      (screen.getByLabelText("Můj text (verze 1)") as HTMLTextAreaElement).value,
    ).toBe("Moje verze");

    fireEvent.change(sourceTextarea(), { target: { value: "Moje novější verze" } });

    expect(
      (screen.getByLabelText("Můj text (verze 1)") as HTMLTextAreaElement).value,
    ).toBe("Moje novější verze");
  });

  it("po úspěšném uložení schová panel obnovy konceptu", async () => {
    vi.stubGlobal("fetch", echoingFetchMock());

    window.sessionStorage.setItem(
      `note-draft:${noteId}:1`,
      JSON.stringify({
        baseVersion: 1,
        contentMd: "Starý koncept",
        noteId,
        savedAt: "2026-10-25T10:05:00.000Z",
      }),
    );

    render(<NoteEditor note={baseNote} />);

    expect(
      screen.getByRole("region", { name: "Nalezen neuložený koncept" }),
    ).toBeTruthy();

    fireEvent.change(sourceTextarea(), { target: { value: "Nový obsah" } });
    fireEvent.click(screen.getByRole("button", { name: "Uložit" }));
    await advance(0);

    expect(
      screen.queryByRole("region", { name: "Nalezen neuložený koncept" }),
    ).toBeNull();
  });

  it("obnoví zastaralý koncept přes základní verzi a dostane konflikt místo přepisu", async () => {
    const fetchMock = createFetchMock((_url, init) => {
      if (init?.method === "GET") {
        return noteResponse({
          contentMd: "Serverová verze",
          contentPlain: "Serverová verze",
          version: 2,
        });
      }

      const body = JSON.parse(String(init?.body)) as {
        contentMd: string;
        expectedVersion: number;
      };

      if (body.expectedVersion !== 2) {
        return conflictResponse(2);
      }

      return noteResponse({ contentMd: "Zastaralý koncept", version: 3 });
    });
    vi.stubGlobal("fetch", fetchMock);

    window.sessionStorage.setItem(
      `note-draft:${noteId}:1`,
      JSON.stringify({
        baseVersion: 1,
        contentMd: "Zastaralý koncept",
        noteId,
        savedAt: "2026-10-25T10:05:00.000Z",
      }),
    );

    render(<NoteEditor note={{ ...baseNote, version: 2 }} />);

    fireEvent.click(screen.getByRole("button", { name: "Obnovit koncept" }));
    await advance(800);

    expect(
      screen.getByRole("region", { name: "Konflikt uložení" }),
    ).toBeTruthy();
    expect(sourceTextarea().value).toBe("Zastaralý koncept");

    const patchCalls = fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCalls).toHaveLength(1);
    expect(
      JSON.parse(String((patchCalls[0]?.[1] as RequestInit).body)).expectedVersion,
    ).toBe(1);
  });

  it("po vyřešení konfliktu převezme název serveru a pošle jej s dalším ukládáním", async () => {
    const fetchMock = createFetchMock((_url, init) => {
      if (init?.method === "GET") {
        return noteResponse({
          contentMd: "Serverová verze",
          contentPlain: "Serverová verze",
          title: "Název ze serveru",
          version: 4,
        });
      }

      const body = JSON.parse(String(init?.body)) as {
        contentMd: string;
        expectedVersion: number;
      };

      if (body.expectedVersion !== 4) {
        return conflictResponse(4);
      }

      return noteResponse({
        contentMd: body.contentMd,
        contentPlain: body.contentMd,
        title: "Název ze serveru",
        version: 5,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NoteEditor note={baseNote} />);
    fireEvent.change(sourceTextarea(), { target: { value: "Moje verze" } });

    await advance(800);

    fireEvent.click(
      screen.getByRole("button", { name: "Načíst serverovou verzi" }),
    );
    await advance(0);

    expect(sourceTextarea().value).toBe("Serverová verze");

    fireEvent.change(sourceTextarea(), { target: { value: "Nový text" } });
    await advance(800);

    const patchCalls = fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
    );
    const lastPatch = patchCalls[patchCalls.length - 1]?.[1] as RequestInit;
    expect(JSON.parse(String(lastPatch.body)).title).toBe("Název ze serveru");
    expect(JSON.parse(String(lastPatch.body)).expectedVersion).toBe(4);
  });

  it("po konfliktu ručního uložení zastaví automatické ukládání", async () => {
    const fetchMock = createFetchMock((_url, init) => {
      if (init?.method === "GET") {
        return noteResponse({
          contentMd: "Serverová verze",
          contentPlain: "Serverová verze",
          version: 7,
        });
      }

      return conflictResponse(7);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NoteEditor note={baseNote} />);
    fireEvent.change(sourceTextarea(), { target: { value: "Moje verze" } });

    fireEvent.click(screen.getByRole("button", { name: "Uložit" }));
    await advance(0);

    expect(
      screen.getByRole("region", { name: "Konflikt uložení" }),
    ).toBeTruthy();

    fireEvent.change(sourceTextarea(), { target: { value: "Moje verze 2" } });
    await advance(800);
    await advance(800);

    const patchCalls = fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCalls).toHaveLength(1);
  });
});
