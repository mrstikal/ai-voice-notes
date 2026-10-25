"use client";

import Link from "next/link";

export default function NotesError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight text-stone-950">
        Poznámky se nepodařilo načíst
      </h1>
      <p className="mt-3 leading-7 text-stone-600">
        Zkuste to prosím znovu. Pokud problém přetrvává, zkontrolujte databázi.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <button
          className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          onClick={() => reset()}
          type="button"
        >
          Zkusit znovu
        </button>
        <Link
          className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          href="/"
        >
          Domů
        </Link>
      </div>
    </div>
  );
}
