import type { Metadata } from "next";
import Link from "next/link";

import { NoteList } from "@/components/notes/NoteList";
import {
  InvalidPageError,
  getNoteService,
  parsePageParam,
} from "@/lib/notes/service";
import { toClientSummary } from "@/lib/notes/view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Poznámky",
};

interface NotesPageProps {
  readonly searchParams: Promise<{ page?: string | string[] }>;
}

export default async function NotesPage({ searchParams }: NotesPageProps) {
  const params = await searchParams;

  let data;

  try {
    const page = parsePageParam(params.page);
    data = await getNoteService().listActiveNotes(page);
  } catch (error) {
    if (error instanceof InvalidPageError) {
      return (
        <div className="mx-auto max-w-3xl px-6 py-12">
          <h1 className="text-3xl font-semibold tracking-tight text-stone-950">
            Poznámky
          </h1>
          <p
            className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
            role="alert"
          >
            {error.message}
          </p>
          <p className="mt-4">
            <Link
              className="text-sm font-medium text-emerald-800 underline underline-offset-4 hover:text-emerald-950"
              href="/notes"
            >
              Zpět na první stránku
            </Link>
          </p>
        </div>
      );
    }

    throw error;
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-800">
            Knihovna
          </p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-stone-950">
            Poznámky
          </h1>
          <p className="mt-3 max-w-xl leading-7 text-stone-600">
            Aktivní poznámky jsou řazené od nejnovější. Na stránku se vejde deset
            poznámek.
          </p>
        </div>
        <Link
          className="self-start rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 sm:self-auto"
          href="/notes/trash"
        >
          Otevřít koš
        </Link>
      </div>

      <div className="mt-8">
        <NoteList
          hasNext={data.hasNext}
          items={data.items.map(toClientSummary)}
          mode="active"
          page={data.page}
        />
      </div>
    </div>
  );
}
