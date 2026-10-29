"use client";

import { useEffect, useRef, useState } from "react";

import { countGraphemes } from "@/lib/notes/limits";

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
  const abortRef = useRef<AbortController | null>(null);

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
  }

  const hasSpeakers = result?.diarization === "available";
  const editedGraphemes = hasSpeakers
    ? segments.reduce((total, segment) => total + countGraphemes(segment.text), 0)
    : countGraphemes(plainText);

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
            přepisu smaže. Přepis u nás zůstane jen v tomto prohlížeči a
            zatím se nikam neukládá.
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
            disabled={!approved || busy}
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
                můžete ručně upravit; přepis i názvy zůstanou pouze v tomto
                prohlížeči.
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
                      onChange={(event) => {
                        const value = event.target.value;

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
                        onChange={(event) => {
                          const value = event.target.value;

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
                  onChange={(event) => setPlainText(event.target.value)}
                  value={plainText}
                />
              </label>
            </>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100"
              data-testid="transcript-dismiss"
              onClick={dismiss}
              type="button"
            >
              Zahodit přepis
            </button>
            <span className="text-xs text-stone-500">
              Uložení zápisu ani vytvoření poznámky zatím není součástí této
              fáze.
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
