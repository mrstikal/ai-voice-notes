import Link from "next/link";

export default function HomePage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-14">
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-800">
        Lokální aplikace pro české poznámky
      </p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight text-stone-950 sm:text-5xl">
        AI hlasové poznámky
      </h1>
      <p className="mt-5 max-w-2xl text-lg leading-8 text-stone-700">
        Vítejte v lokální aplikaci pro poznámky. Vytvářejte, upravujte a spravujte
        poznámky; hlasové a AI funkce přijdou v dalších fázích.
      </p>

      <section
        aria-labelledby="otevrit-poznamky"
        className="mt-10 rounded-2xl border border-stone-200 bg-white p-8"
      >
        <h2 id="otevrit-poznamky" className="text-xl font-semibold text-stone-950">
          Vaše poznámky
        </h2>
        <p className="mt-3 max-w-xl leading-7 text-stone-600">
          Aktivní poznámky jsou dostupné po deseti na stránce. Smazané poznámky
          zůstávají v koši, odkud je můžete obnovit. Pro práci s poznámkami
          nejsou potřeba žádné API klíče ani placené služby.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link
            className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            href="/notes"
          >
            Otevřít poznámky
          </Link>
          <Link
            className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            href="/notes/trash"
          >
            Koš
          </Link>
        </div>
      </section>

      <section
        aria-labelledby="jak-zacit-nadpis"
        className="mt-12 scroll-mt-8"
        id="jak-zacit"
      >
        <h2 id="jak-zacit-nadpis" className="text-2xl font-semibold text-stone-950">
          Jak začít
        </h2>
        <ol className="mt-5 space-y-4 text-stone-700">
          <li className="flex gap-3">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-semibold text-emerald-900"
            >
              1
            </span>
            <span>
              Spusťte databázi příkazem{" "}
              <code className="rounded bg-stone-200 px-1.5 py-0.5 text-sm text-stone-900">
                docker compose up -d db
              </code>
              .
            </span>
          </li>
          <li className="flex gap-3">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-semibold text-emerald-900"
            >
              2
            </span>
            <span>
              Ověřte stav na adrese{" "}
              <a
                className="font-medium text-emerald-800 underline underline-offset-4 hover:text-emerald-950"
                href="/api/health"
              >
                /api/health
              </a>
              . Odpověď má být 200, pokud databáze běží.
            </span>
          </li>
          <li className="flex gap-3">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-semibold text-emerald-900"
            >
              3
            </span>
            <span>
              Aplikace poslouchá pouze na adrese{" "}
              <code className="rounded bg-stone-200 px-1.5 py-0.5 text-sm text-stone-900">
                127.0.0.1
              </code>
              , takže k ní jiný počítač v síti nemá přístup.
            </span>
          </li>
        </ol>
      </section>
    </div>
  );
}
