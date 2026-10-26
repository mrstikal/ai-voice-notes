"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import {
  NoteApiError,
  deleteNote,
  formatCzechDateTime,
  updateNote,
  type NoteDetail,
} from "@/lib/notes/client";
import {
  TITLE_MAX_GRAPHEMES,
  countGraphemes,
} from "@/lib/notes/limits";

import { ExportMenu } from "./ExportMenu";

interface NoteHeaderProps {
  readonly note: NoteDetail;
  readonly onNoteUpdated?: (note: NoteDetail) => void;
}

function conflictMessage(error: NoteApiError): string {
  if (error.latestVersion === undefined) {
    return error.message;
  }

  return `${error.message} Aktuální verze: ${error.latestVersion}.`;
}

export function NoteHeader({ note, onNoteUpdated }: NoteHeaderProps) {
  const router = useRouter();
  const [isRenaming, setIsRenaming] = useState(false);
  const [newTitle, setNewTitle] = useState(note.title);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  function openRename() {
    setNewTitle(note.title);
    setError(null);
    setStatus(null);
    setIsRenaming(true);
  }

  async function handleRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setStatus(null);

    const trimmedTitle = newTitle.trim();
    if (!trimmedTitle) {
      setError("Zadejte název poznámky.");
      return;
    }

    if (countGraphemes(trimmedTitle) > TITLE_MAX_GRAPHEMES) {
      setError(
        `Název může mít nejvýše ${TITLE_MAX_GRAPHEMES} viditelných znaků.`,
      );
      return;
    }

    if (trimmedTitle === note.title) {
      setIsRenaming(false);
      return;
    }

    setIsSaving(true);

    try {
      const updated = await updateNote(note.id, {
        title: trimmedTitle,
        contentMd: note.contentMd,
        expectedVersion: note.version,
      });

      setNewTitle(updated.title);
      setIsRenaming(false);
      setStatus("Název byl uložen.");
      onNoteUpdated?.(updated);
      router.refresh();
    } catch (renameError) {
      setError(
        renameError instanceof NoteApiError
          ? conflictMessage(renameError)
          : "Název se nepodařilo uložit.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    setError(null);
    setStatus(null);
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
          {!isRenaming ? (
            <button
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
              onClick={openRename}
              type="button"
            >
              Přejmenovat
            </button>
          ) : null}
          {!confirmingDelete ? (
            <button
              className="rounded-lg border border-red-300 px-3 py-2 text-sm font-semibold text-red-800 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
              onClick={() => {
                setError(null);
                setStatus(null);
                setConfirmingDelete(true);
              }}
              type="button"
            >
              Smazat
            </button>
          ) : null}
        </div>
      </div>

      {isRenaming ? (
        <form
          className="mt-5 flex flex-col gap-3 rounded-xl border border-stone-200 bg-white p-4 sm:flex-row sm:items-end"
          onSubmit={handleRename}
        >
          <div className="flex-1 space-y-2">
            <label
              className="block text-sm font-medium text-stone-800"
              htmlFor="rename-note-title"
            >
              Nový název
            </label>
            <input
              autoFocus
              className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
              id="rename-note-title"
              onChange={(event) => setNewTitle(event.target.value)}
              required
              type="text"
              value={newTitle}
            />
            <p className="text-xs text-stone-500">
              Nejvýše {TITLE_MAX_GRAPHEMES} viditelných znaků.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isSaving}
              type="submit"
            >
              {isSaving ? "Ukládám…" : "Uložit název"}
            </button>
            <button
              className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isSaving}
              onClick={() => setIsRenaming(false)}
              type="button"
            >
              Zrušit
            </button>
          </div>
        </form>
      ) : null}

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

      {status ? (
        <p
          aria-live="polite"
          className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
          role="status"
        >
          {status}
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
