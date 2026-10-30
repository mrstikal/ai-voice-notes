"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { LlmProviderStatus } from "@/lib/ai/structured";
import { setMicrophoneOwnerActive } from "@/lib/media/activity";
import {
  MicrophoneLeaseError,
  acquireMicrophoneLease,
  type MicrophoneLease,
} from "@/lib/voice/microphone";

import { TranscriptReview } from "./TranscriptReview";

const RECORDING_MIME_TYPE = "audio/webm;codecs=opus";

interface MeetingRecorderProps {
  readonly maxMinutes: number;
  readonly maxBytes: number;
  readonly llmStatus?: LlmProviderStatus | null;
  readonly llmError?: string | null;
}

interface MeetingPreview {
  readonly id: number;
  readonly blob: Blob;
  readonly bytes: number;
  readonly mimeType: string;
  readonly name: string | null;
  readonly source: "recording" | "file";
}

interface InspectResponse {
  readonly bytes: number;
  readonly format: "mp3" | "wav" | "webm";
  readonly codec: string;
  readonly durationSeconds: number;
  readonly inspection: "validated";
  readonly message: string;
}

type RecorderState = "idle" | "starting" | "recording" | "stopping" | "error";

function formatBytes(bytes: number): string {
  return `${new Intl.NumberFormat("cs-CZ").format(bytes)} B`;
}

function formatClock(seconds: number): string {
  const bounded = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(bounded / 60);
  const rest = bounded % 60;

  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function recorderErrorMessage(error: unknown): string {
  if (error instanceof MicrophoneLeaseError) {
    return error.message;
  }

  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "Přístup k mikrofonu byl zamítnut. Povolte jej v prohlížeči, nebo vyberte soubor.";
    }

    if (error.name === "NotFoundError") {
      return "Mikrofon nebyl nalezen. Vyberte lokální audio soubor.";
    }
  }

  return "Nahrávání se nepodařilo spustit. Zkuste to znovu nebo vyberte soubor.";
}

export function MeetingRecorder({
  maxMinutes,
  maxBytes,
  llmStatus = null,
  llmError = null,
}: MeetingRecorderProps) {
  const ownerId = useId();
  const [supported, setSupported] = useState<boolean | null>(null);
  const [state, setState] = useState<RecorderState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(maxMinutes * 60);
  const [recordedBytes, setRecordedBytes] = useState(0);
  const [preview, setPreview] = useState<MeetingPreview | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [inspected, setInspected] = useState<InspectResponse | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const previewRef = useRef<MeetingPreview | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const leaseRef = useRef<MicrophoneLease | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const bytesRef = useRef(0);
  const cancelledRef = useRef(false);
  const sizeExceededRef = useRef(false);
  const previewSequenceRef = useRef(0);
  const autoStopRef = useRef(false);
  const mountedRef = useRef(true);
  const intervalRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    const recorderSupported =
      typeof MediaRecorder !== "undefined" &&
      typeof MediaRecorder.isTypeSupported === "function" &&
      MediaRecorder.isTypeSupported(RECORDING_MIME_TYPE) &&
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function";

    void (async () => {
      await Promise.resolve();

      if (mountedRef.current) {
        setSupported(recorderSupported);
      }
    })();

    return () => {
      mountedRef.current = false;
      cancelledRef.current = true;

      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
      }

      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }

      const recorder = recorderRef.current;

      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // Ignore a recorder already closed by the browser.
        }
      }

      streamRef.current?.getTracks().forEach((track) => track.stop());
      setMicrophoneOwnerActive(ownerId, false);
      const lease = leaseRef.current;

      leaseRef.current = null;

      if (lease) {
        void lease.release();
      }
    };
  }, [ownerId]);

  function clearTimers(): void {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }

  function finishCancelledStart(): void {
    releaseLease();
    stopTracks();

    if (mountedRef.current) {
      setState("idle");
      setNotice("Nahrávání bylo zrušeno. Nic se neodeslalo.");
    }
  }

  function updatePreview(next: MeetingPreview | null): void {
    previewRef.current = next;
    setPreview(next);
  }

  function stopTracks(): void {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  function releaseLease(): void {
    const lease = leaseRef.current;

    leaseRef.current = null;
    setMicrophoneOwnerActive(ownerId, false);

    if (lease) {
      void lease.release();
    }
  }

  function finalizeRecording(): void {
    clearTimers();
    stopTracks();
    releaseLease();

    if (!mountedRef.current) {
      return;
    }

    setState("idle");

    if (cancelledRef.current) {
      chunksRef.current = [];
      setRecordedBytes(0);
      return;
    }

    if (sizeExceededRef.current) {
      chunksRef.current = [];
      setRecordedBytes(0);
      setError(
        `Nahrávka překročila limit ${formatBytes(maxBytes)} a nebyla přijata.`,
      );
      return;
    }

    const bytes = bytesRef.current;
    const chunks = chunksRef.current;

    chunksRef.current = [];
    setRecordedBytes(0);

    if (bytes === 0 || chunks.length === 0) {
      setError("Nahrávka je prázdná. Zkuste to znovu.");
      return;
    }

    previewSequenceRef.current += 1;
    updatePreview({
      id: previewSequenceRef.current,
      blob: new Blob(chunks, { type: RECORDING_MIME_TYPE }),
      bytes,
      mimeType: RECORDING_MIME_TYPE,
      name: null,
      source: "recording",
    });
    setInspected(null);
    setNotice(
      autoStopRef.current
        ? `Nahrávání bylo automaticky zastaveno po ${maxMinutes} minutách a nahrávka je připravená v tomto prohlížeči.`
        : "Nahrávka je připravená v tomto prohlížeči.",
    );
    autoStopRef.current = false;
  }

  function stopRecording(): void {
    clearTimers();
    const recorder = recorderRef.current;

    if (!recorder || recorder.state === "inactive") {
      finalizeRecording();
      return;
    }

    setState("stopping");

    try {
      recorder.stop();
    } catch {
      finalizeRecording();
    }
  }

  async function startRecording(): Promise<void> {
    cancelledRef.current = false;
    autoStopRef.current = false;
    setError(null);
    setNotice(null);
    updatePreview(null);
    setInspected(null);
    setRecordedBytes(0);
    setState("starting");

    try {
      const lease = await acquireMicrophoneLease();
      leaseRef.current = lease;

      if (cancelledRef.current) {
        finishCancelledStart();
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      streamRef.current = stream;

      if (cancelledRef.current) {
        finishCancelledStart();
        return;
      }

      const recorder = new MediaRecorder(stream, {
        mimeType: RECORDING_MIME_TYPE,
      });
      recorderRef.current = recorder;
      chunksRef.current = [];
      bytesRef.current = 0;
      cancelledRef.current = false;
      sizeExceededRef.current = false;

      recorder.ondataavailable = (event) => {
        if (cancelledRef.current || event.data.size === 0) {
          return;
        }

        chunksRef.current.push(event.data);
        bytesRef.current += event.data.size;

        if (mountedRef.current) {
          setRecordedBytes(bytesRef.current);
        }

        if (bytesRef.current > maxBytes) {
          sizeExceededRef.current = true;
          stopRecording();
        }
      };

      recorder.onstop = () => {
        finalizeRecording();
      };

      recorder.onerror = () => {
        cancelledRef.current = true;
        setError("Nahrávání selhalo. Zkuste to znovu.");
        stopRecording();
      };

      setMicrophoneOwnerActive(ownerId, true, "meeting");
      recorder.start(1_000);
      setState("recording");
      setRemainingSeconds(maxMinutes * 60);

      intervalRef.current = window.setInterval(() => {
        if (!mountedRef.current) {
          return;
        }

        setRemainingSeconds((current) => Math.max(0, current - 1));
      }, 1_000);

      timeoutRef.current = window.setTimeout(() => {
        if (!mountedRef.current) {
          return;
        }

        autoStopRef.current = true;
        stopRecording();
      }, maxMinutes * 60 * 1_000);
    } catch (caught) {
      if (cancelledRef.current) {
        finishCancelledStart();
        return;
      }

      releaseLease();
      stopTracks();
      setState("error");
      setError(recorderErrorMessage(caught));
    }
  }

  function cancelRecording(): void {
    if (state === "starting") {
      cancelledRef.current = true;
      autoStopRef.current = false;
      setNotice(
        "Ruším spouštění. Pokud je otevřený dialog prohlížeče pro přístup k mikrofonu, dokončete jej nebo zavřete; Start a výběr souboru budou do té doby uzamčené.",
      );
      return;
    }

    cancelledRef.current = true;
    autoStopRef.current = false;
    chunksRef.current = [];
    bytesRef.current = 0;
    setRecordedBytes(0);
    updatePreview(null);
    setInspected(null);
    setNotice("Nahrávání bylo zrušeno. Nic se neodeslalo.");
    stopRecording();
  }

  function chooseFile(file: File | undefined): void {
    if (!file) {
      return;
    }

    setError(null);
    setNotice(null);
    setInspected(null);

    if (file.size === 0) {
      updatePreview(null);
      setError("Vybraný soubor je prázdný.");
      return;
    }

    if (file.size > maxBytes) {
      updatePreview(null);
      setError(
        `Soubor překračuje limit ${formatBytes(maxBytes)}. Vyberte menší nahrávku.`,
      );
      return;
    }

    previewSequenceRef.current += 1;
    updatePreview({
      id: previewSequenceRef.current,
      blob: file,
      bytes: file.size,
      mimeType: file.type || "application/octet-stream",
      name: file.name,
      source: "file",
    });
    setNotice(
      "Soubor zůstává v tomto prohlížeči. Ověření na serveru je samostatný krok.",
    );
  }

  async function inspectPreview(): Promise<void> {
    const inspectedPreview = preview;

    if (!inspectedPreview) {
      return;
    }

    setInspecting(true);
    setError(null);
    setInspected(null);

    try {
      const response = await fetch("/api/meetings/inspect", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: inspectedPreview.blob,
      });

      if (previewRef.current !== inspectedPreview) {
        return;
      }

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: unknown };
        } | null;
        const message =
          typeof payload?.error?.message === "string"
            ? payload.error.message
            : "Nahrávku se nepodařilo ověřit.";

        setError(message);
        return;
      }

      setInspected((await response.json()) as InspectResponse);
    } catch {
      if (previewRef.current === inspectedPreview) {
        setError("Nahrávku se nepodařilo ověřit. Zkontrolujte připojení.");
      }
    } finally {
      setInspecting(false);
    }
  }

  const recording = state === "recording" || state === "stopping";
  const busy = state === "starting" || recording;
  const controlsLocked = busy || transcribing;

  return (
    <section
      className="mt-6 rounded-2xl border border-stone-200 bg-white p-5"
      data-testid="meeting-recorder"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-stone-950">
            Nahrání nahrávky schůzky
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-stone-600">
            Nahrávka zůstává v tomto prohlížeči. Server ji při ověření
            a přepisu uloží pouze do dočasného soukromého souboru a hned jej
            smaže. Přepis se spouští až po výslovném potvrzení ceny níže; po
            kontrole jej můžete uložit jako poznámku.
          </p>
        </div>
        <span className="rounded-full border border-stone-200 bg-stone-50 px-3 py-1 text-xs text-stone-600">
          Max. {maxMinutes} min · {formatBytes(maxBytes)}
        </span>
      </div>

      {supported === false ? (
        <p
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"
          data-testid="meeting-unsupported"
        >
          Tento prohlížeč neumí nahrávat WebM/Opus. Nahrávání je vypnuté;
          lokální audio soubor ale vybrat můžete.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
          data-testid="meeting-start"
          disabled={supported !== true || controlsLocked}
          onClick={() => void startRecording()}
          type="button"
        >
          {state === "starting" ? "Spouštím…" : "Start nahrávání"}
        </button>
        <button
          className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="meeting-stop"
          disabled={state !== "recording"}
          onClick={stopRecording}
          type="button"
        >
          Stop
        </button>
        <button
          className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="meeting-cancel"
          disabled={transcribing || (!busy && !preview)}
          onClick={cancelRecording}
          type="button"
        >
          Zrušit
        </button>
        <span
          className="text-sm font-medium tabular-nums text-stone-700"
          data-testid="meeting-timer"
        >
          {formatClock(remainingSeconds)} · {formatBytes(recordedBytes)}
        </span>
      </div>

      <label className="mt-4 block text-sm font-medium text-stone-700">
        Nebo vyberte lokální audio soubor
        <input
          accept="audio/*"
          className="mt-1 block w-full text-sm text-stone-700"
          data-testid="meeting-file"
          disabled={controlsLocked || inspecting}
          onChange={(event) => {
            chooseFile(event.target.files?.[0]);
            event.target.value = "";
          }}
          type="file"
        />
      </label>

      {error ? (
        <p
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
          data-testid="meeting-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {notice ? (
        <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950">
          {notice}
        </p>
      ) : null}

      {preview ? (
        <div
          className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-4"
          data-testid="meeting-preview"
        >
          <p className="text-sm font-semibold text-stone-900">
            Připravená nahrávka
          </p>
          <p className="mt-1 text-sm text-stone-700">
            {preview.name ? `${preview.name} · ` : ""}
            {formatBytes(preview.bytes)} · {preview.mimeType}
          </p>
          <p className="mt-1 text-xs font-medium text-amber-800">
            {inspected
              ? "Typ a délka ověřeny"
              : "Typ a délka dosud neověřeny"}
          </p>
          <button
            className="mt-3 rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
            data-testid="meeting-inspect"
            disabled={inspecting || transcribing}
            onClick={() => void inspectPreview()}
            type="button"
          >
            {inspecting ? "Ověřuji…" : "Ověřit nahrávku"}
          </button>
        </div>
      ) : null}

      {inspected ? (
        <p
          className="mt-3 rounded-lg border border-stone-200 bg-white p-3 text-sm text-stone-700"
          data-testid="meeting-inspected"
        >
          Server ověřil {inspected.format.toUpperCase()} / {inspected.codec},{" "}
          {inspected.durationSeconds.toFixed(1)} s,{" "}
          {formatBytes(inspected.bytes)}. {inspected.message}. Nahrávka byla ze
          serveru smazána.
        </p>
      ) : null}

      {preview && inspected ? (
        <TranscriptReview
          durationSeconds={inspected.durationSeconds}
          key={preview.id}
          llmError={llmError}
          llmStatus={llmStatus}
          onBusyChange={setTranscribing}
          preview={preview}
        />
      ) : null}
    </section>
  );
}
