import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { NoteHeader } from "@/components/notes/NoteHeader";
import {
  InvalidNoteIdError,
  NoteNotFoundError,
  getNoteService,
} from "@/lib/notes/service";
import { toClientDetail } from "@/lib/notes/view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Detail poznámky",
};

interface NoteDetailPageProps {
  readonly params: Promise<{ id: string }>;
}

export default async function NoteDetailPage({ params }: NoteDetailPageProps) {
  const { id } = await params;

  let note;

  try {
    note = await getNoteService().getNote(id);
  } catch (error) {
    if (error instanceof NoteNotFoundError || error instanceof InvalidNoteIdError) {
      notFound();
    }

    throw error;
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <NoteHeader key={note.id} note={toClientDetail(note)} />

      <div className="mt-10 rounded-2xl border border-stone-200 bg-white p-6">
        {note.contentPlain ? (
          <div className="whitespace-pre-wrap text-base leading-8 text-stone-800">
            {note.contentPlain}
          </div>
        ) : (
          <p className="text-stone-500">Tato poznámka je prázdná.</p>
        )}
      </div>

      <details className="mt-6 rounded-xl border border-stone-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-stone-700">
          Zobrazit Markdown
        </summary>
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-sm leading-6 text-stone-700">
          {note.contentMd}
        </pre>
      </details>
    </div>
  );
}
