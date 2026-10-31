"use client";

import { useState } from "react";

import type { LlmProviderStatus } from "@/lib/ai/structured";
import type { TagSuggestion } from "@/lib/ai/tag-suggestions";
import { formatUsdAmount } from "@/lib/ai/usage-format";
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

interface SuggestedTagItem {
  readonly key: string;
  readonly text: string;
  readonly selected: boolean;
}

export interface NoteTagsProps {
  readonly note: NoteDetail;
  readonly disabled?: boolean;
  readonly llmStatus: LlmProviderStatus | null;
  readonly llmError?: string | null;
  readonly onNoteUpdated: (note: NoteDetail) => void;
  readonly onApplied?: (message: string | null) => void;
}

export function NoteTags({
  note,
  disabled = false,
  llmStatus,
  llmError = null,
  onNoteUpdated,
  onApplied,
}: NoteTagsProps) {
  const [category, setCategory] = useState(note.category ?? "");
  const [tags, setTags] = useState<string[]>([...note.tags]);
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<TagSuggestion | null>(null);
  const [suggestionItems, setSuggestionItems] = useState<SuggestedTagItem[]>(
    [],
  );
  const [applySuggestedCategory, setApplySuggestedCategory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const providerBlocked = llmStatus === null || !llmStatus.configured;
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

  async function suggest() {
    if (providerBlocked || disabled || suggesting) {
      return;
    }

    setSuggesting(true);
    setSuggestionError(null);
    setStatus(null);
    setSuggestion(null);
    setSuggestionItems([]);
    setApplySuggestedCategory(false);

    try {
      const response = await fetch(`/api/notes/${note.id}/ai-suggest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "tag_suggestions",
          expectedVersion: note.version,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;

        throw new Error(
          body?.error?.message ??
            "AI návrh tagů není dostupný. Ruční tagy můžete upravovat dál.",
        );
      }

      const result = (await response.json()) as TagSuggestion;
      setSuggestion(result);
      setSuggestionItems(
        result.tags.map((tag, index) => ({
          key: `${index}:${tag}`,
          selected: true,
          text: tag,
        })),
      );
      setStatus(
        "AI návrh je připravený. Vyberte tagy a případně potvrďte kategorii; poznámka se změní až potvrzením.",
      );
    } catch (suggestError) {
      setSuggestionError(
        suggestError instanceof Error
          ? suggestError.message
          : "AI návrh tagů se nepodařilo načíst.",
      );
    } finally {
      setSuggesting(false);
    }
  }

  async function applySuggestion() {
    if (suggestion === null) {
      return;
    }

    if (Date.parse(suggestion.expiresAt) <= Date.now()) {
      setSuggestionError(
        "AI návrh vypršel. Vytvořte nový návrh; poznámka zůstala beze změny.",
      );
      return;
    }

    if (suggestion.noteVersion !== note.version) {
      setSuggestionError(
        "Poznámka se mezitím změnila. Vytvořte AI návrh znovu; nic nebylo použito.",
      );
      return;
    }

    if (dirty) {
      setSuggestionError(
        "Nejprve uložte ruční změny kategorie nebo tagů. AI návrh se aplikuje jen na uložená metadata. Uložení tento AI návrh odstraní a po uložení budete muset požádat o nový, což je další placené volání.",
      );
      return;
    }

    if (suggestionItems.every((item) => !item.selected) && !applySuggestedCategory) {
      setSuggestionError(
        "Vyberte alespoň jeden tag nebo zvolte použití navržené kategorie.",
      );
      return;
    }

    setSaving(true);
    setError(null);
    setSuggestionError(null);
    setStatus(null);
    onApplied?.(null);

    try {
      const selectedTags = suggestionItems
        .filter((item) => item.selected)
        .map((item) => item.text);
      const mergedTags = normalizeTags([...note.tags, ...selectedTags]);
      const nextCategory = applySuggestedCategory
        ? suggestion.category
        : note.category;
      const updated = await updateNoteMetadata(note.id, {
        category: nextCategory,
        tags: mergedTags,
        expectedVersion: suggestion.noteVersion,
      });
      const changed = updated.version !== suggestion.noteVersion;
      setCategory(updated.category ?? "");
      setTags([...updated.tags]);
      setSuggestion(null);
      setSuggestionItems([]);
      setApplySuggestedCategory(false);
      setStatus(
        changed
          ? `AI metadata uložena · verze ${updated.version}. Vznikla jedna revize „Změna metadat“.`
          : "AI návrh byl aplikován, ale metadata už byla stejná; nová revize nevznikla.",
      );
      onNoteUpdated(updated);
      onApplied?.(
        changed
          ? `AI metadata uložena · verze ${updated.version} · jedna revize „Změna metadat“.`
          : "Vybraná metadata už byla uložená; nová revize nevznikla.",
      );
    } catch (applyError) {
      setSuggestionError(
        applyError instanceof NoteApiError
          ? applyError.message
          : applyError instanceof Error
            ? applyError.message
            : "AI návrh se nepodařilo použít.",
      );
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

      <div className="mt-6 border-t border-stone-200 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400"
            data-testid="tag-ai-suggest"
            disabled={disabled || suggesting || providerBlocked}
            onClick={() => void suggest()}
            type="button"
          >
            {suggesting ? "Navrhuji…" : "Navrhnout tagy AI"}
          </button>
          <span className="text-xs leading-5 text-stone-500">
            Placená akce. Odesílá se titulek a obsah poznámky; výsledek se
            neuloží bez potvrzení. Kategorii nelze změnit bez samostatné volby.
          </span>
        </div>

        {llmStatus ? (
          <p className="mt-1 text-xs leading-5 text-stone-500">
            OpenRouter · {llmStatus.model} · odhad až{" "}
            {formatUsdAmount(String(llmStatus.estimatedMaxCostUsd))} na
            požadavek.
          </p>
        ) : null}

        {providerBlocked ? (
          <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
            {llmStatus?.blockedReason ??
              "AI návrh tagů není nakonfigurovaný. Ruční tagy můžete upravovat dál."}
          </p>
        ) : null}

        {llmError ? (
          <p className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            {llmError}
          </p>
        ) : null}

        {suggestionError ? (
          <p
            className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
            data-testid="tag-ai-error"
            role="alert"
          >
            {suggestionError}
          </p>
        ) : null}

        {suggestion ? (
          <div
            className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4"
            data-testid="tag-ai-suggestion"
          >
            <p className="text-sm font-semibold text-emerald-950">
              AI návrh · verze {suggestion.noteVersion}
            </p>
            {suggestionItems.length === 0 ? (
              <p className="mt-1 text-sm text-emerald-950">
                Model nenavrhl žádné tagy.
              </p>
            ) : (
              <fieldset className="mt-2">
                <legend className="text-xs font-semibold text-emerald-900">
                  Vyberte a případně upravte tagy k přidání
                </legend>
                <div className="mt-1 space-y-2">
                  {suggestionItems.map((item, index) => (
                    <div className="flex items-center gap-2" key={item.key}>
                      <input
                        checked={item.selected}
                        data-testid={`tag-ai-suggested-${item.text}`}
                        onChange={(event) =>
                          setSuggestionItems((current) =>
                            current.map((currentItem, currentIndex) =>
                              currentIndex === index
                                ? {
                                    ...currentItem,
                                    selected: event.target.checked,
                                  }
                                : currentItem,
                            ),
                          )
                        }
                        type="checkbox"
                      />
                      <input
                        aria-label={`Upravit navržený tag ${item.text}`}
                        className="min-w-40 flex-1 rounded-lg border border-emerald-300 bg-white px-2 py-1 text-sm text-emerald-950"
                        data-testid={`tag-ai-edit-${item.key}`}
                        onChange={(event) =>
                          setSuggestionItems((current) =>
                            current.map((currentItem, currentIndex) =>
                              currentIndex === index
                                ? {
                                    ...currentItem,
                                    text: event.target.value,
                                  }
                                : currentItem,
                            ),
                          )
                        }
                        type="text"
                        value={item.text}
                      />
                    </div>
                  ))}
                </div>
              </fieldset>
            )}

            <label className="mt-3 flex items-start gap-2 text-sm text-emerald-950">
              <input
                checked={applySuggestedCategory}
                data-testid="tag-ai-apply-category"
                onChange={(event) =>
                  setApplySuggestedCategory(event.target.checked)
                }
                type="checkbox"
              />
              <span>
                Použít navrženou kategorii:{" "}
                <strong>{suggestion.category ?? "bez kategorie"}</strong>. Bez
                zaškrtnutí zůstane stávající kategorie.
              </span>
            </label>

            <p className="mt-2 text-xs text-emerald-900">
              Návrh platí do{" "}
              {new Date(suggestion.expiresAt).toLocaleTimeString("cs-CZ")}.
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="rounded-lg bg-emerald-800 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
                data-testid="tag-ai-apply"
                disabled={
                  disabled ||
                  saving ||
                  (suggestionItems.every((item) => !item.selected) &&
                    !applySuggestedCategory)
                }
                onClick={() => void applySuggestion()}
                type="button"
              >
                Použít vybrané
              </button>
              <button
                className="rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-100"
                data-testid="tag-ai-reject"
                disabled={disabled || saving}
                onClick={() => {
                  setSuggestion(null);
                  setSuggestionItems([]);
                  setApplySuggestedCategory(false);
                  setSuggestionError(null);
                  setStatus("AI návrh byl zamítnut. Poznámka zůstala beze změny.");
                }}
                type="button"
              >
                Zamítnout návrh
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
