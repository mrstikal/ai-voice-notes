"use client";

import { useRef, useState } from "react";

import type { LlmProviderStatus } from "@/lib/ai/structured";
import {
  TASK_SUGGESTION_MAX_SOURCE_GRAPHEMES,
  TASK_SUGGESTION_MAX_TASKS,
  TASK_SUGGESTION_MAX_TEXT_GRAPHEMES,
  type TaskSuggestion,
} from "@/lib/ai/task-suggestion-types";
import { formatUsdAmount } from "@/lib/ai/usage-format";
import type { NoteDetail } from "@/lib/notes/client";
import { countGraphemes } from "@/lib/notes/limits";
import {
  ProposalApiError,
  confirmEditProposal,
  createEditProposal,
  rejectEditProposal,
  type EditProposal,
} from "@/lib/notes/proposal-client";

import { ChangePreview } from "./ChangePreview";

interface TaskApplyResponse {
  readonly kind: "task_apply";
  readonly operation: {
    readonly type: "append_bounded_section";
    readonly text: string;
  };
  readonly noteVersion: number;
}

interface EditableTask {
  readonly key: string;
  readonly text: string;
  readonly selected: boolean;
  readonly duplicate: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Extrakci úkolů se nepodařilo připravit.";
}

export interface TaskSuggestionsProps {
  readonly note: NoteDetail;
  readonly disabled?: boolean;
  readonly llmStatus: LlmProviderStatus | null;
  readonly llmError?: string | null;
  readonly onNoteUpdated: (note: NoteDetail) => void;
}

export function TaskSuggestions({
  note,
  disabled = false,
  llmStatus,
  llmError = null,
  onNoteUpdated,
}: TaskSuggestionsProps) {
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [suggestion, setSuggestion] = useState<TaskSuggestion | null>(null);
  const [items, setItems] = useState<EditableTask[]>([]);
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const nonceRef = useRef<string | null>(null);
  const providerBlocked = llmStatus === null || !llmStatus.configured;
  const selectedText = note.contentPlain.slice(selection.start, selection.end);
  const selectedGraphemes = countGraphemes(selectedText);
  const stale =
    suggestion !== null && suggestion.noteVersion !== note.version;
  const canGenerate =
    !busy &&
    !disabled &&
    !providerBlocked &&
    selection.end > selection.start &&
    selectedGraphemes <= TASK_SUGGESTION_MAX_SOURCE_GRAPHEMES;

  async function generate() {
    if (!canGenerate) {
      return;
    }

    setBusy(true);
    setError(null);
    setStatus(null);
    setSuggestion(null);
    setItems([]);
    setProposal(null);
    nonceRef.current = null;

    try {
      const response = await fetch(`/api/notes/${note.id}/ai-suggest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "task_suggestions",
          expectedVersion: note.version,
          start: selection.start,
          end: selection.end,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;

        throw new Error(
          body?.error?.message ??
            "Extrakce úkolů není dostupná. Úkoly lze dál upravovat ručně.",
        );
      }

      const result = (await response.json()) as TaskSuggestion;
      setSuggestion(result);
      setItems(
        result.tasks.map((task, index) => ({
          duplicate: task.duplicate,
          key: `${index}:${task.normalized}`,
          selected: !task.duplicate,
          text: task.text,
        })),
      );
      setStatus(
        "Návrh úkolů je připravený. Zkontrolujte duplicity a text; do poznámky se nic nezapíše bez potvrzení.",
      );
    } catch (generateError) {
      setError(errorMessage(generateError));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (suggestion === null) {
      return;
    }

    if (Date.parse(suggestion.expiresAt) <= Date.now()) {
      setError("Návrh úkolů vypršel. Vytvořte nový; poznámka zůstala beze změny.");
      return;
    }

    if (stale) {
      setError("Poznámka se mezitím změnila. Vytvořte návrh znovu.");
      return;
    }

    const selectedTasks = items
      .filter((item) => item.selected)
      .map((item) => item.text.trim())
      .filter((text) => text !== "");

    if (selectedTasks.length === 0) {
      setError("Vyberte alespoň jeden úkol.");
      return;
    }

    setBusy(true);
    setError(null);
    setStatus(null);
    setProposal(null);
    nonceRef.current = null;

    try {
      const taskApply = await fetch(`/api/notes/${note.id}/ai-suggest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "task_apply",
          expectedVersion: suggestion.noteVersion,
          tasks: selectedTasks,
        }),
      });

      if (!taskApply.ok) {
        const body = (await taskApply.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;

        throw new Error(
          body?.error?.message ??
            "Vybrané úkoly se nepodařilo připravit k vložení.",
        );
      }

      const prepared = (await taskApply.json()) as TaskApplyResponse;
      const created = await createEditProposal(note.id, {
        operation: prepared.operation,
        expectedVersion: prepared.noteVersion,
      });
      const { confirmationNonce, ...preview } = created;
      nonceRef.current = confirmationNonce;
      setProposal(preview);
      setStatus(
        "Návrh vložení úkolů je připravený. Poznámka se změní až po potvrzení.",
      );
    } catch (applyError) {
      setError(
        applyError instanceof ProposalApiError
          ? applyError.message
          : errorMessage(applyError),
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirm(current: EditProposal) {
    const nonce = nonceRef.current;

    if (nonce === null) {
      setError("Potvrzovací údaj není k dispozici. Připravte návrh znovu.");
      return;
    }

    setConfirming(true);
    setError(null);

    try {
      const confirmed = await confirmEditProposal(note.id, current.id, {
        confirmationNonce: nonce,
        expectedVersion: current.expectedVersion,
      });
      nonceRef.current = null;
      setProposal(confirmed.proposal);
      setSuggestion(null);
      setItems([]);
      setStatus("Úkoly byly vloženy jako nová revize.");
      onNoteUpdated(confirmed.note);
    } catch (confirmError) {
      setError(errorMessage(confirmError));
    } finally {
      setConfirming(false);
    }
  }

  async function reject(current: EditProposal) {
    setRejecting(true);
    setError(null);

    try {
      setProposal(await rejectEditProposal(note.id, current.id));
      nonceRef.current = null;
      setStatus("Vložení úkolů bylo zamítnuto. Poznámka zůstala beze změny.");
    } catch (rejectError) {
      setError(errorMessage(rejectError));
    } finally {
      setRejecting(false);
    }
  }

  return (
    <section
      aria-labelledby="task-suggestions-heading"
      className="mt-6 rounded-2xl border border-stone-200 bg-white p-6"
    >
      <h2
        className="text-xl font-semibold text-stone-950"
        id="task-suggestions-heading"
      >
        Získat úkoly z pasáže
      </h2>
      <p className="mt-2 text-sm leading-6 text-stone-600">
        Vyberte pasáž do{" "}
        {TASK_SUGGESTION_MAX_SOURCE_GRAPHEMES.toLocaleString("cs-CZ")} znaků.
        Model vrátí nejvýše {TASK_SUGGESTION_MAX_TASKS} úkolů do{" "}
        {TASK_SUGGESTION_MAX_TEXT_GRAPHEMES} znaků; duplicity vůči existujícím
        GFM úkolům budou označené. Vložení vyžaduje P22/P23 diff a samostatné
        potvrzení.
      </p>

      {llmStatus ? (
        <p className="mt-2 text-xs leading-5 text-stone-500">
          OpenRouter · {llmStatus.model} · odhad až{" "}
          {formatUsdAmount(String(llmStatus.estimatedMaxCostUsd))} na požadavek.
          Odesílá se jen vybraná pasáž.
        </p>
      ) : null}

      {llmError ? (
        <p className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          {llmError}
        </p>
      ) : null}

      {providerBlocked ? (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          {llmStatus?.blockedReason ??
            "Extrakce úkolů není nakonfigurovaná. Úkoly lze dál upravovat ručně."}
        </p>
      ) : null}

      {disabled ? (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          Nejprve uložte neuložené změny. Extrakce musí vycházet z uložené
          verze poznámky.
        </p>
      ) : null}

      <label className="mt-4 block text-sm font-medium text-stone-700">
        Text poznámky pro výběr pasáže
        <textarea
          aria-label="Text poznámky pro výběr úkolů"
          className="mt-1 h-32 w-full resize-y rounded-lg border border-stone-300 bg-stone-50 p-3 font-mono text-xs leading-5 text-stone-800"
          data-testid="task-source"
          onSelect={(event) => {
            const target = event.currentTarget;
            setSelection({
              start: target.selectionStart,
              end: target.selectionEnd,
            });
          }}
          readOnly
          value={note.contentPlain}
        />
      </label>
      <p className="mt-1 text-xs leading-5 text-stone-500">
        Vybraná pasáž: {selectedGraphemes.toLocaleString("cs-CZ")} znaků. Limit
        je{" "}
        {TASK_SUGGESTION_MAX_SOURCE_GRAPHEMES.toLocaleString("cs-CZ")} znaků.
      </p>
      {selection.end > selection.start &&
      selectedGraphemes > TASK_SUGGESTION_MAX_SOURCE_GRAPHEMES ? (
        <p className="mt-1 text-xs font-medium text-amber-900">
          Vybraná pasáž je delší než limit. Vyberte kratší část.
        </p>
      ) : null}
      <button
        className="mt-2 rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-800 hover:bg-stone-100"
        data-testid="task-select-all"
        onClick={() =>
          setSelection({ end: note.contentPlain.length, start: 0 })
        }
        type="button"
      >
        Vybrat celou poznámku
      </button>

      <div className="mt-3">
        <button
          className="rounded-lg bg-stone-800 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600"
          data-testid="task-suggest"
          disabled={!canGenerate}
          onClick={() => void generate()}
          type="button"
        >
          {busy ? "Zpracovávám…" : "Získat úkoly"}
        </button>
      </div>

      {suggestion ? (
        <div
          className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4"
          data-testid="task-suggestion"
        >
          <p className="text-sm font-semibold text-emerald-950">
            Návrh úkolů · verze {suggestion.noteVersion}
          </p>
          <p className="mt-1 text-xs leading-5 text-emerald-900">
            Model mohl úkoly přeformulovat. Zkontrolujte text; duplicity jsou
            ve výchozím stavu nevybrané.
          </p>
          {suggestion.rejectedCount > 0 ? (
            <p className="mt-1 text-xs font-medium text-amber-900">
              Model vrátil {suggestion.rejectedCount} neplatných úkolů; byly
              vynechány. Ostatní níže můžete zkontrolovat.
            </p>
          ) : null}

          {items.length === 0 ? (
            <p className="mt-2 text-sm text-emerald-950">
              Model nevrátil žádné úkoly.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {items.map((item, index) => (
                <li className="flex flex-wrap items-center gap-2" key={item.key}>
                  <input
                    checked={item.selected}
                    data-testid={`task-suggested-${item.key}`}
                    onChange={(event) =>
                      setItems((current) =>
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
                    aria-label={`Upravit navržený úkol ${item.text}`}
                    className="min-w-52 flex-1 rounded-lg border border-emerald-300 bg-white px-2 py-1 text-sm text-emerald-950"
                    data-testid={`task-edit-${item.key}`}
                    onChange={(event) =>
                      setItems((current) =>
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
                  {item.duplicate ? (
                    <span className="text-xs font-semibold text-amber-900">
                      Už existuje
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              className="rounded-lg bg-emerald-800 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
              data-testid="task-suggestion-apply"
              disabled={disabled || busy}
              onClick={() => void apply()}
              type="button"
            >
              Vložit vybrané
            </button>
            <button
              className="rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-100"
              data-testid="task-suggestion-reject"
              disabled={disabled || busy}
              onClick={() => {
                setSuggestion(null);
                setItems([]);
                setError(null);
                setStatus("Návrh úkolů byl zamítnut. Poznámka zůstala beze změny.");
              }}
              type="button"
            >
              Zamítnout návrh
            </button>
          </div>

          {stale ? (
            <p className="mt-2 text-sm text-amber-950">
              Poznámka se mezitím změnila. Vytvořte návrh znovu; vložení není
              povolené.
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
          data-testid="task-suggestion-error"
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

      {proposal ? (
        <ChangePreview
          confirming={confirming}
          disabled={disabled}
          onConfirm={(current) => void confirm(current)}
          onReject={(current) => void reject(current)}
          proposal={proposal}
          rejecting={rejecting}
        />
      ) : null}
    </section>
  );
}
