"use client";

import { useState } from "react";

import {
  NOTE_CATEGORIES,
  NOTE_TAGS_MAX,
  NOTE_TAG_MAX_GRAPHEMES,
  NoteMetadataError,
  normalizeNoteMetadata,
  normalizeTags,
} from "@/lib/notes/tags";
import {
  NoteApiError,
  updateNoteMetadata,
  type NoteDetail,
} from "@/lib/notes/client";

function tagsDiffer(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return true;
  }

  return left.some((tag, index) => tag !== right[index]);
}

export interface NoteTagsProps {
  readonly note: NoteDetail;
  readonly disabled?: boolean;
  readonly onNoteUpdated: (note: NoteDetail) => void;
  readonly onApplied?: (message: string | null) => void;
}

export function NoteTags({
  note,
  disabled = false,
  onNoteUpdated,
  onApplied,
}: NoteTagsProps) {
  const [category, setCategory] = useState(note.category ?? "");
  const [tags, setTags] = useState<string[]>([...note.tags]);
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const dirty =
    category !== (note.category ?? "") || tagsDiffer(tags, note.tags);

  function addTags(value: string) {
    const parts = value
      .split(/[,;\n]+/u)
      .map((part) => part.trim())
      .filter((part) => part !== "");

    if (parts.length === 0) {
      return;
    }

    try {
      setTags(normalizeTags([...tags, ...parts]));
      setTagInput("");
      setError(null);
    } catch (addError) {
      setError(
        addError instanceof NoteMetadataError
          ? addError.message
          : "Tag se nepodařilo přidat.",
      );
    }
  }

  function removeTag(tag: string) {
    setTags((current) => current.filter((item) => item !== tag));
    setError(null);
    setStatus(null);
  }

  function editTag(tag: string) {
    removeTag(tag);
    setTagInput(tag);
  }

  async function save() {
    setSaving(true);
    setError(null);
    setStatus(null);
    onApplied?.(null);

    try {
      const normalized = normalizeNoteMetadata(
        category === "" ? null : category,
        tags,
      );
      const updated = await updateNoteMetadata(note.id, {
        category: normalized.category,
        tags: normalized.tags,
        expectedVersion: note.version,
      });
      const changed = updated.version !== note.version;
      setCategory(updated.category ?? "");
      setTags([...updated.tags]);
      setTagInput("");
      setStatus(
        changed
          ? `Metadata uložena · verze ${updated.version}. Vznikla jedna revize „Změna metadat“.`
          : "Metadata jsou už ve stejném stavu; nová revize nevznikla.",
      );
      onNoteUpdated(updated);
      onApplied?.(
        changed
          ? `Metadata uložena · verze ${updated.version} · jedna revize „Změna metadat“.`
          : "Metadata jsou už ve stejném stavu; nová revize nevznikla.",
      );
    } catch (saveError) {
      if (saveError instanceof NoteApiError && saveError.status === 409) {
        setError(
          `${saveError.message} Načtěte poznámku znovu; vaše úpravy metadat zůstaly v panelu.`,
        );
      } else {
        setError(
          saveError instanceof Error
            ? saveError.message
            : "Metadata se nepodařilo uložit.",
        );
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      aria-labelledby="note-tags-heading"
      className="mt-6 rounded-2xl border border-stone-200 bg-white p-6"
      data-testid="note-tags"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-stone-950" id="note-tags-heading">
            Kategorie a tagy
          </h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            Ruční metadata. Uložení vytvoří právě jednu revizi typu „Změna
            metadat“; bez změny se verze nezvyšuje.
          </p>
        </div>
        <span className="text-xs font-medium text-stone-500">
          {tags.length}/{NOTE_TAGS_MAX} tagů
        </span>
      </div>

      {disabled ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          Nejprve uložte neuložené změny obsahu. Metadata vycházejí z uložené
          verze poznámky.
        </p>
      ) : null}

      <label className="mt-4 block text-sm font-medium text-stone-700">
        Kategorie
        <select
          className="mt-1 w-full rounded-lg border border-stone-300 bg-white p-3 text-sm disabled:bg-stone-100"
          data-testid="tag-category"
          disabled={disabled || saving}
          onChange={(event) => {
            setCategory(event.target.value);
            setStatus(null);
            setError(null);
          }}
          value={category}
        >
          <option value="">Bez kategorie</option>
          {NOTE_CATEGORIES.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>

      <div className="mt-4">
        <p className="text-sm font-medium text-stone-700">Tagy</p>
        {tags.length === 0 ? (
          <p className="mt-1 text-sm text-stone-500">Zatím žádné tagy.</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2" data-testid="tag-list">
            {tags.map((tag) => (
              <li
                className="flex items-center gap-1 rounded-full border border-stone-300 bg-stone-50 py-1 pl-3 pr-1 text-sm text-stone-900"
                data-testid={`tag-${tag}`}
                key={tag}
              >
                <span>{tag}</span>
                <button
                  aria-label={`Upravit tag ${tag}`}
                  className="rounded-full px-1.5 py-0.5 text-[11px] font-medium text-stone-600 hover:bg-stone-200 disabled:text-stone-400"
                  disabled={disabled || saving}
                  onClick={() => editTag(tag)}
                  type="button"
                >
                  Upravit
                </button>
                <button
                  aria-label={`Odebrat tag ${tag}`}
                  className="rounded-full px-2 py-0.5 text-xs font-semibold text-stone-600 hover:bg-red-100 hover:text-red-900 disabled:text-stone-400"
                  disabled={disabled || saving}
                  onClick={() => removeTag(tag)}
                  type="button"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="min-w-48 flex-1 text-sm font-medium text-stone-700">
          Přidat tag
          <input
            className="mt-1 w-full rounded-lg border border-stone-300 p-3 text-sm disabled:bg-stone-100"
            data-testid="tag-input"
            disabled={disabled || saving || tags.length >= NOTE_TAGS_MAX}
            onChange={(event) => setTagInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addTags(tagInput);
              }
            }}
            placeholder={`max. ${NOTE_TAG_MAX_GRAPHEMES} znaků, čárkou oddělte více`}
            type="text"
            value={tagInput}
          />
        </label>
        <button
          className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400"
          data-testid="tag-add"
          disabled={
            disabled ||
            saving ||
            tagInput.trim() === "" ||
            tags.length >= NOTE_TAGS_MAX
          }
          onClick={() => addTags(tagInput)}
          type="button"
        >
          Přidat
        </button>
      </div>

      {error ? (
        <p
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
          data-testid="tag-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {status ? (
        <p aria-live="polite" className="mt-3 text-sm text-stone-700">
          {status}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          className="rounded-lg bg-stone-800 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600"
          data-testid="tag-save"
          disabled={disabled || saving || !dirty}
          onClick={() => void save()}
          type="button"
        >
          {saving ? "Ukládám…" : "Uložit metadata"}
        </button>
        <span className="text-xs leading-5 text-stone-500">
          Tagy jsou bez ohledu na velikost písmen jedinečné; diakritika se
          zachovává.
        </span>
      </div>
    </section>
  );
}
