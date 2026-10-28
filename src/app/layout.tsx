import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "AI hlasové poznámky",
    template: "%s | AI hlasové poznámky",
  },
  description: "Lokální aplikace pro české hlasové poznámky.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="cs">
      <body className="min-h-screen bg-stone-50 text-stone-900 antialiased">
        <header className="border-b border-stone-200 bg-white">
          <div className="mx-auto flex max-w-5xl flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
            <Link
              className="text-lg font-semibold tracking-tight text-stone-950 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-700"
              href="/"
            >
              AI hlasové poznámky
            </Link>
            <nav aria-label="Hlavní navigace">
              <ul className="flex flex-wrap items-center gap-5 text-sm font-medium">
                <li>
                  <Link
                    className="rounded-sm text-stone-700 hover:text-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-700"
                    href="/"
                  >
                    Domů
                  </Link>
                </li>
                <li>
                  <Link
                    className="rounded-sm text-stone-700 hover:text-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-700"
                    href="/notes"
                  >
                    Poznámky
                  </Link>
                </li>
                <li>
                  <Link
                    className="rounded-sm text-stone-700 hover:text-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-700"
                    href="/search"
                  >
                    Vyhledávání
                  </Link>
                </li>
                <li>
                  <Link
                    className="rounded-sm text-stone-700 hover:text-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-700"
                    href="/notes/trash"
                  >
                    Koš
                  </Link>
                </li>
                <li>
                  <Link
                    className="rounded-sm text-stone-700 hover:text-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-700"
                    href="/settings"
                  >
                    Nastavení
                  </Link>
                </li>
                <li>
                  <Link
                    className="rounded-sm text-stone-700 hover:text-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-700"
                    href="/#jak-zacit"
                  >
                    Jak začít
                  </Link>
                </li>
                <li>
                  <a
                    className="rounded-sm text-stone-700 hover:text-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-700"
                    href="/api/health"
                  >
                    Stav aplikace
                  </a>
                </li>
              </ul>
            </nav>
          </div>
        </header>

        <main>{children}</main>

        <footer className="mx-auto max-w-5xl px-6 pb-10 pt-16 text-sm text-stone-500">
          <p>Lokální aplikace. Data zůstávají ve vašem počítači.</p>
        </footer>
      </body>
    </html>
  );
}
