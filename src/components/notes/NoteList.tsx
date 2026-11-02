"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  NoteApiError,
  createNote,
  formatCzechDateTime,
  restoreNote,
  type NoteSummary,
} from "@/lib/notes/client";

interface NoteListProps {
  readonly mode: "active" | "trash";
  readonly items: NoteSummary[];
  readonly page: number;
  readonly hasNext: boolean;
}

function pageHref(mode: NoteListProps["mode"], page: number): string {
  const basePath = mode === "trash" ? "/notes/trash" : "/notes";
  return page === 1 ? basePath : `${basePath}?page=${page}`;
}

export function NoteList({ mode, items, page, hasNext }: NoteListProps) {
  const router = useRouter();
  const [isCreating, setIsCreating] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function handleCreate() {
    setError(null);
    setStatus(null);
    setIsCreating(true);

    try {
      const created = await createNote({ title: "", contentMd: "" });
      router.push(`/notes/${created.id}`);
    } catch (createError) {
      setError(
        createError instanceof NoteApiError
          ? createError.message
          : "Poznámku se nepodařilo vytvořit.",
      );
      setIsCreating(false);
    }
  }

  async function handleRestore(note: NoteSummary) {
    setError(null);
    setStatus(null);
    setRestoringId(note.id);

    try {
      await restoreNote(note.id, note.version);
      setStatus("Poznámka byla obnovena.");
      router.refresh();
    } catch (restoreError) {
      setError(
        restoreError instanceof NoteApiError
          ? restoreError.message
          : "Poznámku se nepodařilo obnovit.",
      );
    } finally {
      setRestoringId(null);
    }
  }

  const listLabel = mode === "trash" ? "Smazané poznámky" : "Poznámky";
  const isLaterPage = page > 1;
  const emptyTitle = isLaterPage
    ? mode === "trash"
      ? "Na této stránce nejsou smazané poznámky"
      : "Na této stránce nejsou poznámky"
    : mode === "trash"
      ? "Koš je prázdný"
      : "Zatím žádné poznámky";
  const emptyText = isLaterPage
    ? "Zkuste předchozí stránku."
    : mode === "trash"
      ? "Smazané poznámky se zde objeví a můžete je obnovit."
      : "Vytvořte první poznámku tlačítkem Nová poznámka.";

  return (
    <div className="space-y-8">
      {mode === "active" ? (
        <button
          className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={isCreating}
          onClick={() => void handleCreate()}
          type="button"
        >
          {isCreating ? "Vytvářím…" : "Nová poznámka"}
        </button>
      ) : null}

      {error ? (
        <p
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {status ? (
        <p
          aria-live="polite"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
          role="status"
        >
          {status}
        </p>
      ) : null}

      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-white p-8 text-center">
          <p className="text-lg font-semibold text-stone-950">{emptyTitle}</p>
          <p className="mt-2 text-stone-600">{emptyText}</p>
          {isLaterPage ? (
            <p className="mt-4">
              <Link
                className="text-sm font-medium text-emerald-800 underline underline-offset-4 hover:text-emerald-950"
                href={pageHref(mode, 1)}
              >
                Zpět na první stránku
              </Link>
            </p>
          ) : null}
        </div>
      ) : (
        <ul aria-label={listLabel} className="divide-y divide-stone-200 rounded-2xl border border-stone-200 bg-white">
          {items.map((note) => (
            <li
              className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between"
              key={note.id}
            >
              <div className="min-w-0">
                {mode === "trash" ? (
                  <p className="font-medium text-stone-950">
                    {note.title || "Bez názvu"}
                  </p>
                ) : (
                  <Link
                    className="font-medium text-stone-950 underline-offset-4 hover:text-emerald-800 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-700"
                    href={`/notes/${note.id}`}
                  >
                    {note.title || "Bez názvu"}
                  </Link>
                )}
                {mode === "trash" ? (
                  <p className="mt-1 text-sm text-stone-500">
                    Smazáno{" "}
                    <time dateTime={note.deletedAt ?? note.updatedAt}>
                      {formatCzechDateTime(note.deletedAt ?? note.updatedAt)}
                    </time>
                  </p>
                ) : (
                  <p className="mt-1 text-sm text-stone-500">
                    Vytvořeno{" "}
                    <time dateTime={note.createdAt}>
                      {formatCzechDateTime(note.createdAt)}
                    </time>
                    {" · "}Upraveno{" "}
                    <time dateTime={note.updatedAt}>
                      {formatCzechDateTime(note.updatedAt)}
                    </time>
                  </p>
                )}
              </div>

              {mode === "trash" ? (
                <button
                  aria-label={`Obnovit poznámku ${note.title || "Bez názvu"}`}
                  className="self-start rounded-lg border border-emerald-700 px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-60 sm:self-auto"
                  disabled={restoringId === note.id}
                  onClick={() => void handleRestore(note)}
                  type="button"
                >
                  {restoringId === note.id ? "Obnovuji…" : "Obnovit"}
                </button>
              ) : (
                <span className="text-xs font-medium uppercase tracking-wide text-stone-400">
                  verze {note.version}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <nav
        aria-label="Stránkování poznámek"
        className="flex items-center justify-between gap-4 text-sm font-medium"
      >
        {page > 1 ? (
          <Link
            className="text-emerald-800 underline underline-offset-4 hover:text-emerald-950"
            href={pageHref(mode, page - 1)}
          >
            Předchozí
          </Link>
        ) : (
          <span aria-hidden="true" />
        )}
        <span>Strana {page}</span>
        {hasNext ? (
          <Link
            className="text-emerald-800 underline underline-offset-4 hover:text-emerald-950"
            href={pageHref(mode, page + 1)}
          >
            Další
          </Link>
        ) : (
          <span aria-hidden="true" />
        )}
      </nav>

      {mode === "trash" ? (
        <p>
          <Link
            className="text-sm font-medium text-emerald-800 underline underline-offset-4 hover:text-emerald-950"
            href="/notes"
          >
            Zpět na poznámky
          </Link>
        </p>
      ) : null}
    </div>
  );
}
