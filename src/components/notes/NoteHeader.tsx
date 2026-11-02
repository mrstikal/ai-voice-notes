"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  NoteApiError,
  deleteNote,
  formatCzechDateTime,
  type NoteDetail,
} from "@/lib/notes/client";

import { ExportMenu } from "./ExportMenu";

interface NoteHeaderProps {
  readonly note: NoteDetail;
}

function conflictMessage(error: NoteApiError): string {
  if (error.latestVersion === undefined) {
    return error.message;
  }

  return `${error.message} Aktuální verze: ${error.latestVersion}.`;
}

export function NoteHeader({ note }: NoteHeaderProps) {
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setError(null);
    setIsDeleting(true);

    try {
      await deleteNote(note.id, note.version);
      router.push("/notes");
      router.refresh();
    } catch (deleteError) {
      setError(
        deleteError instanceof NoteApiError
          ? conflictMessage(deleteError)
          : "Poznámku se nepodařilo smazat.",
      );
      setIsDeleting(false);
    }
  }

  return (
    <header>
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-800">
        Poznámka
      </p>
      <div className="mt-3 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight text-stone-950 sm:text-4xl">
            {note.title || "Bez názvu"}
          </h1>
          <p className="mt-3 text-sm text-stone-500">
            Vytvořeno{" "}
            <time dateTime={note.createdAt}>
              {formatCzechDateTime(note.createdAt)}
            </time>
            {" · "}Upraveno{" "}
            <time dateTime={note.updatedAt}>
              {formatCzechDateTime(note.updatedAt)}
            </time>
            {" · "}Verze {note.version}
          </p>
          {note.tags.length > 0 ? (
            <p className="mt-2 text-sm text-stone-600">
              Štítky: {note.tags.join(", ")}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          <ExportMenu noteId={note.id} />
          {!confirmingDelete ? (
            <button
              className="rounded-lg border border-red-300 px-3 py-2 text-sm font-semibold text-red-800 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
              onClick={() => {
                setError(null);
                setConfirmingDelete(true);
              }}
              type="button"
            >
              Smazat
            </button>
          ) : null}
        </div>
      </div>

      {confirmingDelete ? (
        <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="font-medium text-red-950" role="alert">
            Opravdu smazat poznámku „{note.title || "Bez názvu"}“?
          </p>
          <p className="mt-1 text-sm text-red-900">
            Poznámka se přesune do koše a můžete ji odtud obnovit.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="rounded-lg bg-red-800 px-4 py-2 text-sm font-semibold text-white hover:bg-red-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isDeleting}
              onClick={() => void handleDelete()}
              type="button"
            >
              {isDeleting ? "Mažu…" : "Potvrdit smazání"}
            </button>
            <button
              className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isDeleting}
              onClick={() => setConfirmingDelete(false)}
              type="button"
            >
              Zrušit
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p
          className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <p className="mt-6">
        <Link
          className="text-sm font-medium text-emerald-800 underline underline-offset-4 hover:text-emerald-950"
          href="/notes"
        >
          Zpět na poznámky
        </Link>
      </p>
    </header>
  );
}
