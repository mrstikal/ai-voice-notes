// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AudioPlayer,
  type PlaybackAudioFactory,
  type PlaybackAudioHandle,
} from "../../src/components/tts/AudioPlayer";
import {
  resetMediaActivityForTests,
  setMicrophoneOwnerActive,
} from "../../src/lib/media/activity";
import { TTS_PLAYBACK_LOCK_NAME } from "../../src/lib/tts/playback-lease";
import { writeTtsVoicePreference } from "../../src/lib/tts/voice-preference";
import { MICROPHONE_LOCK_NAME } from "../../src/lib/voice/microphone";
import type { MicrophoneLockManager } from "../../src/lib/voice/microphone";
import { createFakeLockManager } from "../helpers/provider-mocks";
import type { NoteDetail } from "../../src/lib/notes/client";
import type { TtsProviderStatus } from "../../src/lib/tts/provider";
import type {
  TtsManifest,
  TtsManifestSection,
  TtsSelectionPayload,
} from "../../src/lib/tts/player";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const NOTE_ID = "44444444-4444-4444-8444-444444444444";
const SOURCE_HASH = "a".repeat(64);

const providerStatus: TtsProviderStatus = {
  model: "elevenlabs/eleven-v4-turbo",
  responseFormat: "mp3",
  maxInputCodeUnits: 3500,
  estimatedMaxCostUsd: 0.14,
  configured: true,
  liveStatus: "verified",
  voices: [
    { id: "sarah", label: "Sarah", availability: "available" },
    { id: "george", label: "George", availability: "available" },
  ],
};

interface FakeAudio extends PlaybackAudioHandle {
  readonly src: string;
  readonly playCalls: number;
  readonly pauseCalls: number;
  readonly disposed: boolean;
  triggerEnded(): void;
  triggerError(): void;
}

interface FakeAudioHarness {
  readonly factory: PlaybackAudioFactory;
  readonly instances: FakeAudio[];
}

function createAudioHarness(): FakeAudioHarness {
  const instances: FakeAudio[] = [];
  const factory: PlaybackAudioFactory = (src) => {
    let playCalls = 0;
    let pauseCalls = 0;
    let disposed = false;
    let endedHandler: (() => void) | null = null;
    let errorHandler: (() => void) | null = null;

    const audio = {
      src,
      get playCalls() {
        return playCalls;
      },
      get pauseCalls() {
        return pauseCalls;
      },
      get disposed() {
        return disposed;
      },
      play() {
        playCalls += 1;
        return Promise.resolve();
      },
      pause() {
        pauseCalls += 1;
      },
      dispose() {
        disposed = true;
        pauseCalls += 1;
      },
      setOnEnded(handler: (() => void) | null) {
        endedHandler = handler;
      },
      setOnError(handler: (() => void) | null) {
        errorHandler = handler;
      },
      triggerEnded() {
        endedHandler?.();
      },
      triggerError() {
        errorHandler?.();
      },
    } as FakeAudio;

    instances.push(audio);
    return audio;
  };

  return { factory, instances };
}

interface FetchCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly signal: AbortSignal | null;
}

function createFetchHarness(
  handler: (
    body: Record<string, unknown>,
    call: FetchCall,
  ) => Response | Promise<Response>,
): {
  readonly fetchImpl: typeof fetch;
  readonly calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      const call: FetchCall = {
        url: String(input),
        body,
        signal: init?.signal ?? null,
      };
      calls.push(call);

      return handler(body, call);
    },
  ) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function note(contentMd: string, version = 1): NoteDetail {
  return {
    id: NOTE_ID,
    title: "Testovací poznámka",
    category: null,
    version,
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T10:00:00.000Z",
    deletedAt: null,
    contentMd,
    contentPlain: contentMd,
    tags: [],
  };
}

function manifestSections(texts: readonly string[]): TtsManifestSection[] {
  let offset = 0;

  return texts.map((text, index) => {
    const start = offset;
    offset += text.length + 1;

    return {
      index,
      text,
      start,
      end: start + text.length,
      cacheKey: `key-${index}`,
      cached: false,
    };
  });
}

function manifest(
  texts: readonly string[],
  overrides: Partial<TtsManifest> = {},
): TtsManifest {
  return {
    noteId: NOTE_ID,
    noteVersion: 1,
    sourceHash: SOURCE_HASH,
    voice: "sarah",
    model: "elevenlabs/eleven-v4-turbo",
    selection: { scope: "full" },
    cacheHit: false,
    estimatedMaxCostUsd: "0.280000",
    sections: manifestSections(texts),
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function audioResponse(): Response {
  return new Response(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0]), {
    status: 200,
    headers: { "content-type": "audio/mpeg" },
  });
}

function selectionFromBody(body: Record<string, unknown>): TtsSelectionPayload {
  return {
    scope: body.scope as TtsSelectionPayload["scope"],
    ...(typeof body.start === "number" ? { start: body.start } : {}),
    ...(typeof body.end === "number" ? { end: body.end } : {}),
    ...(typeof body.paragraphIndex === "number"
      ? { paragraphIndex: body.paragraphIndex }
      : {}),
    ...(typeof body.listIndex === "number" ? { listIndex: body.listIndex } : {}),
  };
}

async function renderPlayer(options: {
  readonly noteContent?: string;
  readonly handler: (
    body: Record<string, unknown>,
    call: FetchCall,
  ) => Response | Promise<Response>;
  readonly version?: number;
  readonly playbackLocks?: MicrophoneLockManager | null;
}) {
  const audio = createAudioHarness();
  const network = createFetchHarness(options.handler);

  render(
    <AudioPlayer
      audioFactory={audio.factory}
      fetchImpl={network.fetchImpl}
      note={note(
        options.noteContent ?? "První odstavec.\n\nDruhý odstavec.",
        options.version,
      )}
      playbackLocks={options.playbackLocks}
      providerStatus={providerStatus}
    />,
  );

  return { audio, network };
}

async function prepareManifest(
  texts: readonly string[],
  overrides: Partial<TtsManifest> = {},
) {
  const result = await renderPlayer({
    handler: (body) =>
      body.sectionIndex === undefined
        ? jsonResponse(manifest(texts, overrides))
        : audioResponse(),
  });

  fireEvent.click(screen.getByRole("button", { name: "Zjistit rozsah a cenu" }));

  await screen.findByTestId("tts-section-list");
  return result;
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => `blob:test-${Math.random()}`),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetMediaActivityForTests();
  vi.unstubAllGlobals();
});

describe("AudioPlayer", () => {
  it("shows provider, model, voice and cost, requires consent and speaks one section at a time", async () => {
    const { audio, network } = await renderPlayer({
      handler: (body) =>
        body.sectionIndex === undefined
          ? jsonResponse(manifest(["První odstavec.", "Druhý odstavec."]))
          : audioResponse(),
    });

    expect(
      screen.getByText(/elevenlabs\/eleven-v4-turbo/),
    ).toBeDefined();
    expect(screen.getByText(/hlas Sarah/)).toBeDefined();
    expect(screen.getByText(/3 500 znaků/)).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "Zjistit rozsah a cenu" }),
    );

    await screen.findByTestId("tts-section-list");

    const manifestCall = network.calls[0]!;
    expect(manifestCall.url).toBe("/api/tts");
    expect(manifestCall.body).toMatchObject({
      noteId: NOTE_ID,
      scope: "full",
      voice: "sarah",
    });
    expect(screen.getByText("První odstavec.")).toBeDefined();
    expect(screen.getByText("Druhý odstavec.")).toBeDefined();
    expect(screen.getByText(/až 0,28 USD/)).toBeDefined();

    const play = screen.getByRole("button", { name: "Přehrát" });
    expect(play).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByTestId("tts-consent"));
    expect(play).toHaveProperty("disabled", false);

    fireEvent.click(play);

    await waitFor(() => {
      expect(audio.instances).toHaveLength(1);
    });

    expect(network.calls).toHaveLength(2);
    expect(network.calls[1]!.body).toMatchObject({
      noteId: NOTE_ID,
      scope: "full",
      sectionIndex: 0,
      expectedSourceHash: SOURCE_HASH,
      voice: "sarah",
    });
    expect(audio.instances[0]!.playCalls).toBe(1);

    const sections = screen.getByTestId("tts-section-list");
    const first = within(sections).getByText("První odstavec.").closest("li");
    expect(first?.getAttribute("aria-current")).toBe("true");
  });

  it("sends range, paragraph and task-list selections to the P19 manifest", async () => {
    const { network } = await renderPlayer({
      noteContent: [
        "První odstavec.",
        "",
        "Druhý odstavec.",
        "",
        "- [ ] Koupit mléko",
        "- [x] Zavolat lékaři",
        "",
        "Mezi tímto textem.",
        "",
        "- [ ] Připravit report",
      ].join("\n"),
      handler: (body) =>
        jsonResponse(
          manifest(["Vybraný text."], {
            selection: selectionFromBody(body),
          }),
        ),
    });

    fireEvent.change(screen.getByTestId("tts-scope"), {
      target: { value: "range" },
    });
    fireEvent.change(screen.getByTestId("tts-range-start"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByTestId("tts-range-end"), {
      target: { value: "5" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Zjistit rozsah a cenu" }),
    );

    await waitFor(() => {
      expect(network.calls).toHaveLength(1);
    });
    expect(network.calls[0]!.body).toMatchObject({
      scope: "range",
      start: 0,
      end: 5,
    });

    fireEvent.change(screen.getByTestId("tts-scope"), {
      target: { value: "paragraph" },
    });
    fireEvent.change(screen.getByTestId("tts-paragraph"), {
      target: { value: "1" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Zjistit rozsah a cenu" }),
    );

    await waitFor(() => {
      expect(network.calls).toHaveLength(2);
    });
    expect(network.calls[1]!.body).toMatchObject({
      scope: "paragraph",
      paragraphIndex: 1,
    });

    fireEvent.change(screen.getByTestId("tts-scope"), {
      target: { value: "tasks" },
    });
    fireEvent.change(screen.getByTestId("tts-task-list"), {
      target: { value: "1" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Zjistit rozsah a cenu" }),
    );

    await waitFor(() => {
      expect(network.calls).toHaveLength(3);
    });
    expect(network.calls[2]!.body).toMatchObject({
      scope: "tasks",
      listIndex: 1,
    });
  });

  it("explains a single-section note and shows transport buttons only while playing", async () => {
    await prepareManifest(["Jediná sekce."]);

    expect(screen.queryByRole("button", { name: "Předchozí" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Další" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(
      screen.getByText(/Poznámka se vejde do jedné sekce/),
    ).toBeDefined();
    expect(
      screen.getByText(/Přehrát se aktivuje po zaškrtnutí souhlasu/),
    ).toBeDefined();

    fireEvent.click(screen.getByTestId("tts-consent"));
    fireEvent.click(screen.getByRole("button", { name: "Přehrát" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Pozastavit" }),
      ).toBeDefined();
    });
    expect(screen.getByRole("button", { name: "Stop" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Přehrát" })).toBeDefined();
  });

  it("selects a section before playback and starts from the selected one", async () => {
    const { network } = await prepareManifest([
      "První sekce.",
      "Druhá sekce.",
      "Třetí sekce.",
    ]);

    expect(screen.getByRole("button", { name: "Další" })).toHaveProperty(
      "disabled",
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "Další" }));

    expect(network.calls).toHaveLength(1);
    expect(
      within(screen.getByTestId("tts-section-list"))
        .getByText("Druhá sekce.")
        .closest("li")
        ?.getAttribute("aria-current"),
    ).toBe("true");
    expect(screen.getByText(/Sekce 2 z 3/)).toBeDefined();

    fireEvent.click(screen.getByTestId("tts-consent"));
    fireEvent.click(screen.getByRole("button", { name: "Přehrát" }));

    await waitFor(() => {
      expect(network.calls).toHaveLength(2);
    });
    expect(network.calls[1]!.body).toMatchObject({ sectionIndex: 1 });
  });

  it("pauses, resumes, skips sections and advances sequentially", async () => {
    const { audio, network } = await prepareManifest([
      "První sekce.",
      "Druhá sekce.",
      "Třetí sekce.",
    ]);

    fireEvent.click(screen.getByTestId("tts-consent"));
    fireEvent.click(screen.getByRole("button", { name: "Přehrát" }));

    await waitFor(() => {
      expect(audio.instances).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Pozastavit" }));
    expect(audio.instances[0]!.pauseCalls).toBe(1);
    expect(
      screen.getByRole("button", { name: "Pokračovat" }),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Pokračovat" }));
    await waitFor(() => {
      expect(audio.instances[0]!.playCalls).toBe(2);
    });

    fireEvent.click(screen.getByRole("button", { name: "Další" }));
    await waitFor(() => {
      expect(audio.instances).toHaveLength(2);
    });
    expect(network.calls.at(-1)!.body).toMatchObject({ sectionIndex: 1 });
    expect(
      within(screen.getByTestId("tts-section-list"))
        .getByText("Druhá sekce.")
        .closest("li")
        ?.getAttribute("aria-current"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Předchozí" }));
    await waitFor(() => {
      expect(audio.instances).toHaveLength(3);
    });
    expect(network.calls.at(-1)!.body).toMatchObject({ sectionIndex: 0 });

    act(() => {
      audio.instances[2]!.triggerEnded();
    });

    await waitFor(() => {
      expect(audio.instances).toHaveLength(4);
    });
    expect(network.calls.at(-1)!.body).toMatchObject({ sectionIndex: 1 });
  });

  it("stops audible output, aborts a pending section fetch and never requests the next section", async () => {
    const pending: {
      resolve: ((response: Response) => void) | null;
    } = { resolve: null };
    let sectionCalls = 0;
    const { audio, network } = await renderPlayer({
      handler: (body) => {
        if (body.sectionIndex === undefined) {
          return jsonResponse(manifest(["První sekce.", "Druhá sekce."]));
        }

        sectionCalls += 1;

        if (sectionCalls === 1) {
          return audioResponse();
        }

        return new Promise<Response>((resolve) => {
          pending.resolve = resolve;
        });
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Zjistit rozsah a cenu" }),
    );
    await screen.findByTestId("tts-section-list");
    fireEvent.click(screen.getByTestId("tts-consent"));
    fireEvent.click(screen.getByRole("button", { name: "Přehrát" }));
    await waitFor(() => {
      expect(audio.instances).toHaveLength(1);
    });

    act(() => {
      audio.instances[0]!.triggerEnded();
    });

    await waitFor(() => {
      expect(network.calls).toHaveLength(3);
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(audio.instances[0]!.disposed).toBe(true);
    expect(screen.getByText("Přehrávání bylo zastaveno.")).toBeDefined();

    pending.resolve?.(audioResponse());
    await Promise.resolve();
    await Promise.resolve();

    expect(audio.instances).toHaveLength(1);
    expect(network.calls).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Přehrát" })).toBeDefined();
  });

  it("turns a 429 on the next section into a stop without further provider requests", async () => {
    let sectionCalls = 0;
    const { audio, network } = await renderPlayer({
      handler: (body) => {
        if (body.sectionIndex === undefined) {
          return jsonResponse(manifest(["První sekce.", "Druhá sekce."]));
        }

        sectionCalls += 1;

        if (sectionCalls === 1) {
          return audioResponse();
        }

        return jsonResponse(
          {
            error: {
              code: "rate_limited",
              message: "Příliš mnoho požadavků. Zkuste to za chvíli.",
            },
          },
          429,
        );
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Zjistit rozsah a cenu" }),
    );
    await screen.findByTestId("tts-section-list");
    fireEvent.click(screen.getByTestId("tts-consent"));
    fireEvent.click(screen.getByRole("button", { name: "Přehrát" }));
    await waitFor(() => {
      expect(audio.instances).toHaveLength(1);
    });

    act(() => {
      audio.instances[0]!.triggerEnded();
    });

    expect(
      await screen.findByText("Příliš mnoho požadavků. Zkuste to za chvíli."),
    ).toBeDefined();
    await waitFor(() => {
      expect(network.calls).toHaveLength(3);
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(network.calls).toHaveLength(3);
    expect(audio.instances).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Přehrát" })).toBeDefined();
  });

  it("disables playback while a microphone session owns the device and stops on a later session", async () => {
    const { audio } = await prepareManifest(["První sekce."]);

    act(() => {
      setMicrophoneOwnerActive("title-dictation", true);
    });

    expect(
      screen.getByText(/Mikrofon je právě aktivní/i),
    ).toBeDefined();
    expect(screen.getByTestId("tts-consent")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Přehrát" })).toHaveProperty(
      "disabled",
      true,
    );

    act(() => {
      setMicrophoneOwnerActive("title-dictation", false);
    });

    fireEvent.click(screen.getByTestId("tts-consent"));
    fireEvent.click(screen.getByRole("button", { name: "Přehrát" }));
    await waitFor(() => {
      expect(audio.instances).toHaveLength(1);
    });

    act(() => {
      setMicrophoneOwnerActive("body-dictation", true);
    });

    expect(audio.instances[0]!.disposed).toBe(true);
    expect(screen.getByRole("button", { name: "Přehrát" })).toBeDefined();
  });

  it("releases audio resources when the player unmounts", async () => {
    const { audio } = await prepareManifest(["První sekce."]);
    fireEvent.click(screen.getByTestId("tts-consent"));
    fireEvent.click(screen.getByRole("button", { name: "Přehrát" }));
    await waitFor(() => {
      expect(audio.instances).toHaveLength(1);
    });

    cleanup();

    expect(audio.instances[0]!.disposed).toBe(true);
  });

  it("invalidates the manifest and consent when a loaded sub-selection changes", async () => {
    const { network } = await renderPlayer({
      handler: () =>
        jsonResponse(
          manifest(["První odstavec."], {
            selection: { scope: "paragraph", paragraphIndex: 0 },
          }),
        ),
    });

    fireEvent.change(screen.getByTestId("tts-scope"), {
      target: { value: "paragraph" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Zjistit rozsah a cenu" }),
    );
    await screen.findByTestId("tts-section-list");
    fireEvent.click(screen.getByTestId("tts-consent"));
    expect(screen.getByRole("button", { name: "Přehrát" })).toHaveProperty(
      "disabled",
      false,
    );

    fireEvent.change(screen.getByTestId("tts-paragraph"), {
      target: { value: "1" },
    });

    expect(screen.queryByTestId("tts-section-list")).toBeNull();
    expect(screen.queryByRole("button", { name: "Přehrát" })).toBeNull();
    expect(network.calls).toHaveLength(1);
  });

  it("invalidates a loaded manifest when another tab changes the voice", async () => {
    const { network } = await prepareManifest(["První odstavec."]);
    fireEvent.click(screen.getByTestId("tts-consent"));
    expect(screen.getByRole("button", { name: "Přehrát" })).toHaveProperty(
      "disabled",
      false,
    );

    act(() => {
      writeTtsVoicePreference("george");
    });

    expect(screen.queryByTestId("tts-section-list")).toBeNull();
    expect(screen.queryByRole("button", { name: "Přehrát" })).toBeNull();
    expect(screen.getByTestId("tts-voice")).toHaveProperty("value", "george");
    expect(network.calls).toHaveLength(1);
    expect(
      screen.getByText("Hlas se změnil. Načtěte rozsah a cenu znovu."),
    ).toBeDefined();
  });

  it("persists the chosen voice and purges the previous voice cache", async () => {
    const { network } = await renderPlayer({
      handler: (body) =>
        body.action === "purge"
          ? jsonResponse({ affected: 0 })
          : jsonResponse(manifest(["První odstavec."])),
    });

    fireEvent.change(screen.getByTestId("tts-voice"), {
      target: { value: "george" },
    });

    await waitFor(() => {
      expect(window.localStorage.getItem("ai-voice-notes:tts-voice")).toBe(
        "george",
      );
    });
    await waitFor(() => {
      expect(network.calls).toHaveLength(1);
    });
    expect(network.calls[0]!.url).toBe("/api/tts/cache");
    expect(network.calls[0]!.body).toEqual({
      action: "purge",
      voice: "sarah",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Zjistit rozsah a cenu" }),
    );
    await waitFor(() => {
      expect(network.calls).toHaveLength(2);
    });
    expect(network.calls[1]!.body).toMatchObject({ voice: "george" });
  });

  it("holds the cross-tab playback and microphone leases while playing and releases them on Stop", async () => {
    const heldNames = new Set<string>();
    const requestedModes: string[] = [];
    const locks: MicrophoneLockManager = {
      request(name, options, callback) {
        requestedModes.push(`${name}:${options?.mode ?? "exclusive"}`);

        return new Promise<void>((resolve) => {
          if (heldNames.has(name)) {
            void Promise.resolve(callback(null)).then(resolve);
            return;
          }

          heldNames.add(name);
          void Promise.resolve(
            callback({ name, mode: options?.mode ?? "exclusive" }),
          ).then(() => {
            heldNames.delete(name);
            resolve();
          });
        });
      },
    };

    const { audio } = await renderPlayer({
      handler: () => jsonResponse(manifest(["První sekce."])),
      playbackLocks: locks,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Zjistit rozsah a cenu" }),
    );
    await screen.findByTestId("tts-section-list");
    fireEvent.click(screen.getByTestId("tts-consent"));
    fireEvent.click(screen.getByRole("button", { name: "Přehrát" }));

    await waitFor(() => {
      expect(audio.instances).toHaveLength(1);
    });
    expect(heldNames.has(TTS_PLAYBACK_LOCK_NAME)).toBe(true);
    expect(heldNames.has(MICROPHONE_LOCK_NAME)).toBe(true);
    expect(requestedModes).toEqual([
      `${TTS_PLAYBACK_LOCK_NAME}:exclusive`,
      `${MICROPHONE_LOCK_NAME}:exclusive`,
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(heldNames.size).toBe(0);
    });

    fireEvent.click(screen.getByRole("button", { name: "Přehrát" }));
    await waitFor(() => {
      expect(audio.instances).toHaveLength(2);
    });
    expect(heldNames.has(TTS_PLAYBACK_LOCK_NAME)).toBe(true);
    expect(heldNames.has(MICROPHONE_LOCK_NAME)).toBe(true);

    act(() => {
      audio.instances[1]!.triggerEnded();
    });

    await waitFor(() => {
      expect(heldNames.size).toBe(0);
    });
    expect(screen.getByText("Přehrávání je dokončené.")).toBeDefined();
  });

  it("refuses playback when another tab owns the microphone lease", async () => {
    const locks = createFakeLockManager();
    locks.heldNames.add(MICROPHONE_LOCK_NAME);
    const { audio, network } = await renderPlayer({
      handler: () =>
        jsonResponse(manifest(["První sekce."])),
      playbackLocks: locks,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Zjistit rozsah a cenu" }),
    );
    await screen.findByTestId("tts-section-list");
    fireEvent.click(screen.getByTestId("tts-consent"));
    fireEvent.click(screen.getByRole("button", { name: "Přehrát" }));

    expect(
      await screen.findByText(/mikrofon právě používá jiná karta/i),
    ).toBeDefined();
    expect(audio.instances).toHaveLength(0);
    expect(network.calls).toHaveLength(1);
    expect(locks.heldNames.has(TTS_PLAYBACK_LOCK_NAME)).toBe(false);
  });

  it("shows a free cache replay without a provider cost", async () => {
    await prepareManifest(["První sekce."], {
      cacheHit: true,
      estimatedMaxCostUsd: "0.000000",
    });

    expect(screen.getByText(/0 USD \(vše z cache\)/)).toBeDefined();
    expect(
      screen.getByText(/Přehrání nevytvoří nový požadavek na poskytovatele/),
    ).toBeDefined();
  });
});
