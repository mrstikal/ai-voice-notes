"use client";

import { useEffect, useRef, useState } from "react";

import { countGraphemes } from "@/lib/notes/limits";
import {
  MEETING_SAVE_DEFAULT_TITLE,
  MEETING_SAVE_LABEL_MAX_GRAPHEMES,
  MEETING_SAVE_MAX_BYTES,
  MEETING_SAVE_TITLE_MAX_GRAPHEMES,
  meetingSavePayloadBytes,
} from "@/lib/meetings/save-shared";

export interface TranscriptPreviewSource {
  readonly blob: Blob;
  readonly bytes: number;
  readonly name: string | null;
}

interface TranscriptReviewProps {
  readonly preview: TranscriptPreviewSource;
  readonly durationSeconds: number;
  readonly onBusyChange?: (busy: boolean) => void;
}

interface TranscriptionOffer {
  readonly provider: string;
  readonly model: string;
  readonly operation: string;
  readonly languageCode: string;
  readonly maxMinutes: number;
  readonly maxBytes: number;
  readonly estimatedMaxCostUsd: number;
  readonly transcriptMaxGraphemes: number;
  readonly testMode: boolean;
}

interface TranscriptionSpeakerSegment {
  readonly speakerId: string;
  readonly text: string;
}

interface TranscriptionResponse {
  readonly text: string;
  readonly languageCode: string | null;
  readonly audioDurationSeconds: number | null;
  readonly transcriptGraphemes: number;
  readonly speakers: readonly string[] | null;
  readonly segments: readonly TranscriptionSpeakerSegment[] | null;
  readonly diarization: "available" | "unavailable";
  readonly model: string;
  readonly provider: string;
  readonly durationSeconds: number;
  readonly testMode: boolean;
}

interface SegmentDraft {
  readonly speakerId: string;
  readonly text: string;
}

interface SavePayload {
  readonly requestId: string;
  readonly title: string;
  readonly segments?: readonly { readonly label: string; readonly text: string }[];
  readonly text?: string;
}

interface SavedMeeting {
  readonly noteIds: readonly string[];
  readonly count: number;
  readonly duplicate: boolean;
}

function errorMessage(payload: unknown, fallback: string): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error?: { message?: unknown } }).error?.message ===
      "string"
  ) {
    return (payload as { error: { message: string } }).error.message;
  }

  return fallback;
}

function formatUsd(value: number): string {
  return `${new Intl.NumberFormat("cs-CZ", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 6,
  }).format(value)} USD`;
}

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  if (typeof crypto === "undefined") {
    throw new Error("Prohlížeč nepodporuje bezpečné generování ID.");
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function formatSeconds(value: number): string {
  return `${new Intl.NumberFormat("cs-CZ", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value)} s`;
}

function parseOffer(value: unknown): TranscriptionOffer | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.provider !== "string" ||
    typeof candidate.model !== "string" ||
    typeof candidate.operation !== "string" ||
    typeof candidate.languageCode !== "string" ||
    typeof candidate.maxMinutes !== "number" ||
    !Number.isFinite(candidate.maxMinutes) ||
    candidate.maxMinutes <= 0 ||
    typeof candidate.maxBytes !== "number" ||
    !Number.isFinite(candidate.maxBytes) ||
    typeof candidate.estimatedMaxCostUsd !== "number" ||
    !Number.isFinite(candidate.estimatedMaxCostUsd) ||
    candidate.estimatedMaxCostUsd < 0 ||
    typeof candidate.transcriptMaxGraphemes !== "number" ||
    !Number.isInteger(candidate.transcriptMaxGraphemes) ||
    candidate.transcriptMaxGraphemes <= 0 ||
    typeof candidate.testMode !== "boolean"
  ) {
    return null;
  }

  return candidate as unknown as TranscriptionOffer;
}

export function TranscriptReview({
  preview,
  durationSeconds,
  onBusyChange,
}: TranscriptReviewProps) {
  const [offer, setOffer] = useState<TranscriptionOffer | null>(null);
  const [offerError, setOfferError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TranscriptionResponse | null>(null);
  const [labels, setLabels] = useState<readonly string[]>([]);
  const [segments, setSegments] = useState<readonly SegmentDraft[]>([]);
  const [plainText, setPlainText] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [title, setTitle] = useState(MEETING_SAVE_DEFAULT_TITLE);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedMeeting | null>(null);
  const [downloadRequired, setDownloadRequired] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const saveInFlightRef = useRef(false);

  useEffect(
    () => () => {
      onBusyChange?.(false);
    },
    [onBusyChange],
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch("/api/meetings/transcribe", {
          method: "GET",
          cache: "no-store",
        });

        if (cancelled) {
          return;
        }

        if (!response.ok) {
          setOfferError(
            errorMessage(
              await response.json().catch(() => null),
              "Nabídku přepisu se nepodařilo načíst.",
            ),
          );
          return;
        }

        const parsedOffer = parseOffer(await response.json().catch(() => null));

        if (parsedOffer === null) {
          setOfferError("Nabídku přepisu se nepodařilo načíst.");
          return;
        }

        setOffer(parsedOffer);
      } catch {
        if (!cancelled) {
          setOfferError(
            "Nabídku přepisu se nepodařilo načíst. Zkontrolujte připojení.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [preview.blob]);

  async function transcribe(): Promise<void> {
    if (!offer || !approved) {
      return;
    }

    const controller = new AbortController();

    abortRef.current?.abort();
    abortRef.current = controller;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    setResult(null);
    setLabels([]);
    setSegments([]);
    setPlainText("");
    setRequestId(null);
    saveInFlightRef.current = false;
    setSaving(false);
    setSaveError(null);
    setSaved(null);
    setDownloadRequired(false);
    setTitle(MEETING_SAVE_DEFAULT_TITLE);

    try {
      const response = await fetch(
        `/api/meetings/transcribe?approveCostUsd=${encodeURIComponent(
          String(offer.estimatedMaxCostUsd),
        )}`,
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: preview.blob,
          signal: controller.signal,
        },
      );

      if (abortRef.current !== controller) {
        return;
      }

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as unknown;

        setError(errorMessage(payload, "Přepis se nepodařilo vytvořit."));
        return;
      }

      const payload = (await response.json()) as TranscriptionResponse;

      if (abortRef.current !== controller) {
        return;
      }

      setResult(payload);
      setRequestId(newRequestId());

      if (
        payload.diarization === "available" &&
        payload.speakers !== null &&
        payload.segments !== null
      ) {
        const speakerLabels = payload.speakers.map(
          (_speaker, index) => `Mluvčí ${index + 1}`,
        );

        setLabels(speakerLabels);
        setSegments(
          payload.segments.map((segment) => ({
            speakerId: segment.speakerId,
            text: segment.text,
          })),
        );
      } else {
        setPlainText(payload.text);
      }
    } catch (caught) {
      if (
        abortRef.current === controller &&
        !(caught instanceof DOMException && caught.name === "AbortError")
      ) {
        setError("Přepis se nepodařilo vytvořit. Zkontrolujte připojení.");
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  }

  function dismiss(): void {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    onBusyChange?.(false);
    setResult(null);
    setError(null);
    setLabels([]);
    setSegments([]);
    setPlainText("");
    setRequestId(null);
    saveInFlightRef.current = false;
    setSaving(false);
    setSaveError(null);
    setSaved(null);
    setDownloadRequired(false);
    setTitle(MEETING_SAVE_DEFAULT_TITLE);
  }

  const hasSpeakers = result?.diarization === "available";
  const speakerLabelAt = (speakerId: string): string => {
    const index = result?.speakers?.indexOf(speakerId) ?? -1;

    return index >= 0
      ? (labels[index] ?? `Mluvčí ${index + 1}`)
      : speakerId;
  };
  const reviewedBlocks = hasSpeakers
    ? segments.map((segment) => ({
        label: speakerLabelAt(segment.speakerId),
        text: segment.text,
      }))
    : [{ label: "", text: plainText }];
  const reviewedPlainText = reviewedBlocks
    .map((block) =>
      block.label.trim() === ""
        ? block.text
        : `${block.label.trim()}: ${block.text}`,
    )
    .join("\n\n");
  const editedGraphemes = hasSpeakers
    ? reviewedBlocks.reduce(
        (total, block) =>
          total +
          countGraphemes(
            block.label.trim() === ""
              ? block.text
              : `${block.label.trim()}: ${block.text}`,
          ),
        0,
      ) + Math.max(0, reviewedBlocks.length - 1) * 2
    : countGraphemes(plainText);

  function resetSaveOutcome(): void {
    setSaveError(null);
    setDownloadRequired(false);
  }

  function buildSavePayload(): SavePayload | null {
    if (requestId === null) {
      return null;
    }

    const normalizedTitle = title.trim();

    if (normalizedTitle === "") {
      setSaveError("Zadejte název zápisu.");
      return null;
    }

    if (countGraphemes(normalizedTitle) > MEETING_SAVE_TITLE_MAX_GRAPHEMES) {
      setSaveError(
        `Název může mít nejvýše ${MEETING_SAVE_TITLE_MAX_GRAPHEMES} znaků.`,
      );
      return null;
    }

    return hasSpeakers
      ? {
          requestId,
          title: normalizedTitle,
          segments: reviewedBlocks.map((block) => ({
            label: block.label,
            text: block.text,
          })),
        }
      : { requestId, title: normalizedTitle, text: plainText };
  }

  async function saveMeeting(): Promise<void> {
    if (saveInFlightRef.current || saved !== null) {
      return;
    }

    const payload = buildSavePayload();

    if (payload === null) {
      return;
    }

    const byteLength = meetingSavePayloadBytes(payload);

    if (byteLength > MEETING_SAVE_MAX_BYTES) {
      setDownloadRequired(true);
      setSaveError(
        `Přepis má ${byteLength.toLocaleString("cs-CZ")} bajtů, ale uložit lze nejvýše ${MEETING_SAVE_MAX_BYTES.toLocaleString("cs-CZ")} bajtů. Stáhněte si přepis jako soubor.`,
      );
      return;
    }

    saveInFlightRef.current = true;
    setSaving(true);
    onBusyChange?.(true);
    resetSaveOutcome();

    try {
      const response = await fetch("/api/meetings/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => null)) as unknown;

      if (!response.ok) {
        const code =
          typeof body === "object" && body !== null && "error" in body
            ? (body as { error?: { code?: unknown } }).error?.code
            : null;

        if (code === "meeting_transcript_too_long") {
          setDownloadRequired(true);
        }

        setSaveError(
          errorMessage(body, "Zápis se nepodařilo uložit."),
        );
        return;
      }

      if (
        typeof body !== "object" ||
        body === null ||
        !Array.isArray((body as { noteIds?: unknown }).noteIds)
      ) {
        setSaveError("Server vrátil neplatné potvrzení uložení.");
        return;
      }

      const confirmation = body as {
        noteIds: string[];
        count?: number;
        duplicate?: boolean;
      };

      setSaved({
        noteIds: confirmation.noteIds,
        count:
          typeof confirmation.count === "number"
            ? confirmation.count
            : confirmation.noteIds.length,
        duplicate: confirmation.duplicate === true,
      });
    } catch {
      setSaveError("Zápis se nepodařilo uložit. Zkontrolujte připojení.");
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
      onBusyChange?.(false);
    }
  }

  function downloadTranscript(): void {
    if (typeof URL.createObjectURL !== "function") {
      setSaveError(
        "Prohlížeč neumožňuje stažení souboru. Zkopírujte přepis ručně.",
      );
      return;
    }

    const blob = new Blob([reviewedPlainText], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = "zapis-ze-schuzky.txt";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  return (
    <section
      className="mt-4 rounded-xl border border-sky-200 bg-sky-50/60 p-4"
      data-testid="transcript-review"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-stone-950">
            Přepis nahrávky
          </h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-stone-700">
            Přepis je placená operace u ElevenLabs (Scribe v2, batch). Nahrávka
            se jednou odešle do ElevenLabs, kde se zpracuje podle zásad
            poskytovatele; výchozí nastavení může ukládat logy a přepisy a
            režim bez ukládání závisí na tarifu. Náš server dočasný soubor po
            přepisu smaže. Přepis zůstane v tomto prohlížeči, dokud jej
            neuložíte jako poznámku.
          </p>
        </div>
        <span className="rounded-full border border-sky-200 bg-white px-3 py-1 text-xs text-stone-600">
          Ověřeno {formatSeconds(durationSeconds)}
        </span>
      </div>

      {offerError ? (
        <p
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
          data-testid="transcript-error"
          role="alert"
        >
          {offerError}
        </p>
      ) : null}

      {offer ? (
        <div className="mt-3 rounded-lg border border-sky-200 bg-white p-3 text-sm text-stone-700">
          <p data-testid="transcript-offer">
            {offer.provider} · {offer.model} · jazyk {offer.languageCode} ·
            nejvýše {offer.maxMinutes} min · odhad ceny{" "}
            <strong>{formatUsd(offer.estimatedMaxCostUsd)}</strong> · přepis
            nejvýše {offer.transcriptMaxGraphemes.toLocaleString("cs-CZ")} znaků
          </p>
          {offer.testMode ? (
            <p className="mt-1 text-xs font-medium text-amber-800">
              Testovací režim: přepis je mock a neodpovídá skutečné nahrávce.
            </p>
          ) : null}
          <p className="mt-1 text-xs text-stone-500">
            Cena je horní odhad pro maximální délku; skutečná cena závisí na
            délce nahrávky a může zůstat neznámá.
          </p>
          <label className="mt-3 flex items-start gap-2 text-sm text-stone-800">
            <input
              checked={approved}
              className="mt-1"
              data-testid="transcript-approve"
              onChange={(event) => setApproved(event.target.checked)}
              type="checkbox"
            />
            <span>
              Souhlasím s odesláním nahrávky ElevenLabs a s odhadem ceny{" "}
              {formatUsd(offer.estimatedMaxCostUsd)}.
            </span>
          </label>
          <button
            className="mt-3 rounded-lg bg-sky-800 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-900 disabled:cursor-not-allowed disabled:bg-stone-300"
            data-testid="transcript-start"
            disabled={!approved || busy || saving}
            onClick={() => void transcribe()}
            type="button"
          >
            {busy ? "Přepisuji…" : result ? "Přepsat znovu" : "Přepsat nahrávku"}
          </button>
        </div>
      ) : null}

      {error ? (
        <p
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
          data-testid="transcript-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="mt-4" data-testid="transcript-preview">
          <p className="text-sm font-semibold text-stone-900">
            Neuložený přepis
          </p>
          <p className="mt-1 text-xs text-stone-600">
            {result.provider} · {result.model} ·{" "}
            {result.languageCode ?? "jazyk neurčen"} ·{" "}
            {formatSeconds(result.durationSeconds)} ·{" "}
            {editedGraphemes.toLocaleString("cs-CZ")} znaků
            {result.testMode ? " · mock" : ""}
          </p>

          {hasSpeakers && result.speakers ? (
            <>
              <p className="mt-2 text-xs text-stone-600">
                Mluvčí jsou označeni poskytovatelem přepisu. Názvy mluvčích
                můžete ručně upravit; do poznámky se uloží jako text.
              </p>
              <div className="mt-2 flex flex-wrap gap-3">
                {result.speakers.map((speakerId, index) => (
                  <label
                    className="text-xs font-medium text-stone-700"
                    key={speakerId}
                  >
                    {speakerId}
                    <input
                      className="mt-1 block rounded-lg border border-stone-300 px-2 py-1 text-sm"
                      data-testid={`transcript-speaker-${index}`}
                      disabled={saving || saved !== null}
                      maxLength={MEETING_SAVE_LABEL_MAX_GRAPHEMES}
                      onChange={(event) => {
                        const value = event.target.value;

                        resetSaveOutcome();
                        setLabels((current) =>
                          current.map((label, labelIndex) =>
                            labelIndex === index ? value : label,
                          ),
                        );
                      }}
                      value={labels[index] ?? `Mluvčí ${index + 1}`}
                    />
                  </label>
                ))}
              </div>
              <div className="mt-3 space-y-3">
                {segments.map((segment, index) => {
                  const speakerIndex = result.speakers?.indexOf(
                    segment.speakerId,
                  );

                  return (
                    <label
                      className="block text-sm font-medium text-stone-800"
                      key={`${segment.speakerId}-${index}`}
                    >
                      {speakerIndex !== undefined && speakerIndex >= 0
                        ? (labels[speakerIndex] ??
                          `Mluvčí ${speakerIndex + 1}`)
                        : segment.speakerId}
                      <textarea
                        className="mt-1 block min-h-20 w-full rounded-lg border border-stone-300 p-2 text-sm text-stone-900"
                        data-testid={`transcript-segment-${index}`}
                        disabled={saving || saved !== null}
                        onChange={(event) => {
                          const value = event.target.value;

                          resetSaveOutcome();
                          setSegments((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, text: value }
                                : item,
                            ),
                          );
                        }}
                        value={segment.text}
                      />
                    </label>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <p
                className="mt-2 rounded-lg border border-stone-200 bg-white p-2 text-sm text-stone-700"
                data-testid="transcript-unavailable"
              >
                Rozlišení mluvčích není pro tento režim dostupné
              </p>
              <label className="mt-2 block text-sm font-medium text-stone-800">
                Přepis
                <textarea
                  className="mt-1 block min-h-40 w-full rounded-lg border border-stone-300 p-2 text-sm text-stone-900"
                  data-testid="transcript-text"
                  disabled={saving || saved !== null}
                  onChange={(event) => {
                    resetSaveOutcome();
                    setPlainText(event.target.value);
                  }}
                  value={plainText}
                />
              </label>
            </>
          )}

          <div className="mt-4 rounded-lg border border-stone-200 bg-white p-3">
            <label className="block text-sm font-medium text-stone-800">
              Název zápisu
              <span className="ml-1 text-xs font-normal text-stone-500">
                (u více částí se doplní číslování)
              </span>
              <input
                className="mt-1 block w-full rounded-lg border border-stone-300 px-2 py-1 text-sm"
                data-testid="transcript-title"
                disabled={saving || saved !== null}
                maxLength={MEETING_SAVE_TITLE_MAX_GRAPHEMES}
                onChange={(event) => {
                  resetSaveOutcome();
                  setTitle(event.target.value);
                }}
                value={title}
              />
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
                data-testid="transcript-save"
                disabled={
                  saving ||
                  saved !== null ||
                  downloadRequired ||
                  title.trim() === ""
                }
                onClick={() => void saveMeeting()}
                type="button"
              >
                {saving ? "Ukládám…" : "Uložit zápis"}
              </button>
              <button
                className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100"
                data-testid="transcript-download"
                onClick={downloadTranscript}
                type="button"
              >
                Stáhnout přepis (.txt)
              </button>
              <button
                className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-400"
                data-testid="transcript-dismiss"
                disabled={saving}
                onClick={dismiss}
                type="button"
              >
                Zahodit přepis
              </button>
            </div>
            {saveError ? (
              <p
                className="mt-2 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-900"
                data-testid="transcript-save-error"
                role="alert"
              >
                {saveError}
              </p>
            ) : null}
            {downloadRequired ? (
              <p
                className="mt-2 text-sm text-stone-700"
                data-testid="transcript-download-required"
              >
                Přepis je pro uložení příliš velký a nebyl odeslán. Stáhněte si
                jej jako textový soubor; aplikace jej nezkracuje.
              </p>
            ) : null}
            {saved ? (
              <div className="mt-2" data-testid="transcript-saved">
                <p className="text-sm font-medium text-emerald-900">
                  {saved.duplicate
                    ? "Tento přepis už byl uložen."
                    : `Uloženo do ${saved.count} ${saved.count === 1 ? "poznámky" : "poznámek"}.`}
                </p>
                <ul className="mt-1 flex flex-wrap gap-2 text-sm">
                  {saved.noteIds.map((noteId, index) => (
                    <li key={noteId}>
                      <a
                        className="text-sky-800 underline"
                        href={`/notes/${noteId}`}
                      >
                        Poznámka {index + 1}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
