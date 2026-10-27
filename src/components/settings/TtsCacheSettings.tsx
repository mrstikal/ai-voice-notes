"use client";

import { useEffect, useState } from "react";

interface TtsCacheStats {
  readonly entries: number;
  readonly bytes: number;
  readonly maxBytes: number;
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { message?: unknown };
    };

    return typeof body.error?.message === "string"
      ? body.error.message
      : fallback;
  } catch {
    return fallback;
  }
}

function formatBytes(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);

  return `${mebibytes.toLocaleString("cs-CZ", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  })} MiB`;
}

export function TtsCacheSettings() {
  const [stats, setStats] = useState<TtsCacheStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch("/api/tts/cache", {
          headers: { accept: "application/json" },
        });

        if (!response.ok) {
          throw new Error(
            await readError(
              response,
              "Stav cache čtení nahlas se nepodařilo načíst.",
            ),
          );
        }

        if (!cancelled) {
          setStats((await response.json()) as TtsCacheStats);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Stav cache čtení nahlas se nepodařilo načíst.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  async function clearCache() {
    setClearing(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/tts/cache", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "clear" }),
      });

      if (!response.ok) {
        throw new Error(
          await readError(
            response,
            "Cache čtení nahlas se nepodařilo vymazat.",
          ),
        );
      }

      const result = (await response.json()) as TtsCacheStats & {
        affected: number;
      };
      setStats({
        entries: result.entries,
        bytes: result.bytes,
        maxBytes: result.maxBytes,
      });
      setMessage(
        `Cache byla vymazána (${result.affected.toLocaleString("cs-CZ")} položek).`,
      );
    } catch (clearError) {
      setError(
        clearError instanceof Error
          ? clearError.message
          : "Cache čtení nahlas se nepodařilo vymazat.",
      );
    } finally {
      setClearing(false);
    }
  }

  return (
    <section
      aria-labelledby="tts-cache-heading"
      className="rounded-2xl border border-stone-200 bg-white p-6"
    >
      <h2
        className="text-xl font-semibold text-stone-950"
        id="tts-cache-heading"
      >
        Cache čtení nahlas
      </h2>
      <p className="mt-2 text-sm leading-6 text-stone-600">
        Serverová cache ukládá pouze ověřené MP3 a technická metadata pod
        gitignored <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">.data/tts</code>.
        Manifest neobsahuje přepis ani API klíč. Limit je 200 MiB a nejstarší
        položky se průběžně odstraňují. Změna hlasu nebo modelu se v P19B
        propíše do cíleného purge; tento panel maže celou cache ručně.
      </p>

      {loading ? (
        <p className="mt-4 text-sm text-stone-600">Načítám stav cache…</p>
      ) : null}

      {stats ? (
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
            <dt className="font-medium text-stone-700">Položky</dt>
            <dd className="mt-1 text-stone-950">
              {stats.entries.toLocaleString("cs-CZ")}
            </dd>
          </div>
          <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
            <dt className="font-medium text-stone-700">Využito</dt>
            <dd className="mt-1 text-stone-950">{formatBytes(stats.bytes)}</dd>
          </div>
          <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
            <dt className="font-medium text-stone-700">Limit</dt>
            <dd className="mt-1 text-stone-950">
              {formatBytes(stats.maxBytes)}
            </dd>
          </div>
        </dl>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          type="button"
          onClick={clearCache}
          disabled={loading || clearing}
        >
          {clearing ? "Mažu cache…" : "Vymazat cache"}
        </button>
        <span className="text-xs text-stone-500">
          Vymazání je ruční a nevztahuje se na poznámky.
        </span>
      </div>

      {message ? (
        <p className="mt-3 text-sm text-emerald-800" role="status">
          {message}
        </p>
      ) : null}

      {error ? (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-900" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
