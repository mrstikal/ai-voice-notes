"use client";

import { useEffect, useState } from "react";

import {
  NoteApiError,
  formatCzechDateTime,
  type NoteDetail,
} from "@/lib/notes/client";
import {
  changedSnapshotFields,
  computeRevisionDiff,
  fetchRevisions,
  restoreRevision,
  snapshotsEqual,
  type NoteRevision,
  type RevisionDiff,
  type RevisionHistory as RevisionHistoryData,
  type RevisionReason,
} from "@/lib/notes/revision-client";

const reasonLabels: Record<RevisionReason, string> = {
  initial: "Počáteční verze",
  manual: "Ruční úprava",
  voice: "Hlasová úprava",
  ai: "AI úprava",
  undo: "Vrácení změny",
  restore: "Obnovení verze",
  metadata: "Změna metadat",
};

interface DiffViewProps {
  readonly diff: RevisionDiff;
}

function DiffView({ diff }: DiffViewProps) {
  return (
    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-stone-200 bg-stone-50 p-3 font-mono text-xs leading-5 text-stone-800">
      {diff.prefix}
      <del className="bg-red-100 text-red-900">{diff.removed}</del>
      <ins className="bg-emerald-100 text-emerald-950 no-underline">
        {diff.inserted}
      </ins>
      {diff.suffix}
    </pre>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof NoteApiError) {
    return error.latestVersion === undefined
      ? error.message
      : `${error.message} Aktuální verze: ${error.latestVersion}.`;
  }

  return error instanceof Error
    ? error.message
    : "Historii poznámky se nepodařilo načíst.";
}

export interface RevisionHistoryProps {
  readonly noteId: string;
  readonly noteVersion: number;
  readonly disabled?: boolean;
  readonly onNoteUpdated: (note: NoteDetail) => void;
}

export function RevisionHistory({
  noteId,
  noteVersion,
  disabled = false,
  onNoteUpdated,
}: RevisionHistoryProps) {
  const [history, setHistory] = useState<RevisionHistoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [preview, setPreview] = useState<NoteRevision | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await fetchRevisions(noteId);

        if (!cancelled) {
          setHistory(data);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(errorMessage(loadError));
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
  }, [noteId, noteVersion]);

  async function applyRestore(
    revision: NoteRevision,
    mode: "undo" | "restore",
  ) {
    if (!history) {
      return;
    }

    setActing(true);
    setError(null);

    try {
      const updated = await restoreRevision(noteId, revision.id, {
        mode,
        expectedVersion: history.currentVersion,
      });
      setPreview(null);
      onNoteUpdated(updated);
    } catch (restoreError) {
      setError(errorMessage(restoreError));

      if (
        restoreError instanceof NoteApiError &&
        restoreError.status === 409
      ) {
        // A stale restore/undo must be previewed again against fresh history.
        setPreview(null);

        try {
          setHistory(await fetchRevisions(noteId));
        } catch {
          // Keep the conflict error; the user can reload explicitly.
        }
      }
    } finally {
      setActing(false);
    }
  }

  if (loading) {
    return (
      <section className="mt-6 rounded-2xl border border-stone-200 bg-white p-6">
        <h2 className="text-xl font-semibold text-stone-950">Historie</h2>
        <p className="mt-2 text-sm text-stone-600">Načítám historii…</p>
      </section>
    );
  }

  if (!history) {
    return (
      <section className="mt-6 rounded-2xl border border-stone-200 bg-white p-6">
        <h2 className="text-xl font-semibold text-stone-950">Historie</h2>
        <p className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          {error ?? "Historii poznámky se nepodařilo načíst."}
        </p>
      </section>
    );
  }

  const previewDiff =
    preview === null
      ? null
      : computeRevisionDiff(
          history.currentSnapshot.contentMd,
          preview.afterSnapshot.contentMd,
        );

  return (
    <section
      aria-labelledby="revision-history-heading"
      className="mt-6 rounded-2xl border border-stone-200 bg-white p-6"
      data-testid="revision-history"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2
            className="text-xl font-semibold text-stone-950"
            id="revision-history-heading"
          >
            Historie
          </h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            Uložené pojmenované změny. Běžné debouncované koncepty se sem
            neukládají. Undo je dostupné jen pro poslední změnu přesně ve
            verzi {history.currentVersion}.
          </p>
        </div>
        <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-700">
          Aktuální verze {history.currentVersion}
        </span>
      </div>

      {error ? (
        <p
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-900"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <ol className="mt-4 space-y-3">
        {history.revisions.map((revision) => {
          const afterCurrent = snapshotsEqual(
            revision.afterSnapshot,
            history.currentSnapshot,
          );
          const undoAvailable =
            history.canUndo && history.undoRevisionId === revision.id;

          return (
            <li
              className="rounded-xl border border-stone-200 bg-stone-50 p-4"
              data-testid={`revision-${revision.noteVersion}`}
              key={revision.id}
            >
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-stone-900">
                    {reasonLabels[revision.reason]} · verze{" "}
                    {revision.noteVersion}
                  </p>
                  <p className="mt-1 text-xs text-stone-500">
                    <time dateTime={revision.createdAt}>
                      {formatCzechDateTime(revision.createdAt)}
                    </time>
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {undoAvailable ? (
                    <button
                      className="rounded-lg bg-emerald-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
                      disabled={disabled || acting}
                      onClick={() => void applyRestore(revision, "undo")}
                      type="button"
                    >
                      Vrátit poslední změnu
                    </button>
                  ) : null}
                  {!afterCurrent ? (
                    <button
                      className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400"
                      disabled={disabled || acting}
                      onClick={() => {
                        setPreview(revision);
                        setError(null);
                      }}
                      type="button"
                    >
                      Obnovit tuto verzi
                    </button>
                  ) : null}
                </div>
              </div>

              <DiffView diff={revision.diff} />
            </li>
          );
        })}
      </ol>

      {preview && previewDiff ? (
        <div
          className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4"
          data-testid="revision-restore-preview"
        >
          <p className="text-sm font-semibold text-amber-950">
            Obnovit verzi {preview.noteVersion} jako novou revizi?
          </p>
          <p className="mt-1 text-xs leading-5 text-amber-950">
            Aktuální obsah se nahradí snapshotem „{reasonLabels[preview.reason]}“
            z verze {preview.noteVersion}. Vznikne nová revize s důvodem
            Obnovení verze; stará historie zůstane zachovaná.
          </p>
          {changedSnapshotFields(history.currentSnapshot, preview.afterSnapshot).map(
            (field) => (
              <p className="mt-1 text-sm text-amber-950" key={field}>
                {field}
              </p>
            ),
          )}
          <DiffView diff={previewDiff} />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="rounded-lg bg-amber-800 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-900 disabled:cursor-not-allowed disabled:bg-stone-300"
              disabled={disabled || acting}
              onClick={() => void applyRestore(preview, "restore")}
              type="button"
            >
              {acting ? "Obnovuji…" : "Potvrdit obnovení"}
            </button>
            <button
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100"
              disabled={disabled || acting}
              onClick={() => setPreview(null)}
              type="button"
            >
              Zrušit
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
