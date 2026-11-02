import type { Metadata } from "next";
import Link from "next/link";

import { checkHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Stav aplikace",
};

export default async function StatusPage() {
  const result = await checkHealth();

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-800">
        Stav aplikace
      </p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-stone-950">
        Stav aplikace
      </h1>

      <section
        aria-live="polite"
        className={
          result.ok
            ? "mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-6"
            : "mt-6 rounded-2xl border border-red-200 bg-red-50 p-6"
        }
      >
        <h2
          className={
            result.ok
              ? "text-lg font-semibold text-emerald-950"
              : "text-lg font-semibold text-red-950"
          }
        >
          {result.ok ? "Aplikace je v pořádku" : "Aplikace hlásí problém"}
        </h2>
        <p
          className={
            result.ok
              ? "mt-2 text-sm leading-6 text-emerald-900"
              : "mt-2 text-sm leading-6 text-red-900"
          }
        >
          {result.message}
        </p>
      </section>

      <p className="mt-6 text-sm leading-6 text-stone-600">
        Pro monitoring zůstává strojově čitelný endpoint{" "}
        <code className="rounded bg-stone-100 px-1.5 py-0.5">/api/health</code>.
      </p>

      <Link
        className="mt-6 inline-block rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
        href="/notes"
      >
        Zpět na poznámky
      </Link>
    </div>
  );
}
