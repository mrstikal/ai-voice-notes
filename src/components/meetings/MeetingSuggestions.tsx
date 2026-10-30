"use client";

import { useEffect, useRef, useState } from "react";

import { ChangePreview } from "@/components/ai/ChangePreview";
import { SUMMARY_MAX_SOURCE_GRAPHEMES } from "@/lib/ai/summary-types";
import type { LlmProviderStatus } from "@/lib/ai/structured";
import {
  TASK_SUGGESTION_MAX_SOURCE_GRAPHEMES,
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

export interface MeetingSuggestionLink {
  readonly noteId: string;
  readonly title?: string;
  readonly label?: string;
}

export interface MeetingSuggestionsProps {
  readonly savedNotes: readonly MeetingSuggestionLink[];
  readonly llmStatus: LlmProviderStatus | null;
  readonly llmError?: string | null;
}

interface SummaryArtifact {
  readonly noteVersion: number;
  readonly text: string;
  readonly sourceGraphemes: number;
}

interface DecisionsArtifact {
  readonly noteVersion: number;
  readonly text: string;
  readonly sourceGraphemes: number;
}

interface EditableTask {
  readonly key: string;
  readonly text: string;
  readonly selected: boolean;
  readonly duplicate: boolean;
}

interface SummaryDecisionsResponse {
  readonly kind: "meeting_summary_decisions";
  readonly noteId: string;
  readonly noteVersion: number;
  readonly summaryText: string;
  readonly summarySourceGraphemes: number;
  readonly decisionsText: string | null;
  readonly decisionsSourceGraphemes: number;
  readonly decisionsError: {
    readonly code: string;
    readonly message: string;
  } | null;
}

interface TaskApplyResponse {
  readonly kind: "task_apply";
  readonly operation: {
    readonly type: "append_bounded_section";
    readonly text: string;
  };
  readonly noteVersion: number;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function noteLabel(link: MeetingSuggestionLink): string {
  return link.label ?? link.title ?? "Uložená schůzka";
}

export function MeetingSuggestions({
  savedNotes,
  llmStatus,
  llmError = null,
}: MeetingSuggestionsProps) {
  const unique = savedNotes.filter(
    (link, index) =>
      savedNotes.findIndex((candidate) => candidate.noteId === link.noteId) ===
      index,
  );
  const [selectedNoteId, setSelectedNoteId] = useState(unique[0]?.noteId ?? "");
  const activeNoteId = unique.some((link) => link.noteId === selectedNoteId)
    ? selectedNoteId
    : (unique[0]?.noteId ?? "");
  const [loaded, setLoaded] = useState<{
    readonly noteId: string;
    readonly note: NoteDetail;
  } | null>(null);
  const [loadError, setLoadError] = useState<{
    readonly noteId: string;
    readonly message: string;
  } | null>(null);

  useEffect(() => {
    if (activeNoteId === "") {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(`/api/notes/${activeNoteId}`, {
          cache: "no-store",
        });

        if (cancelled) {
          return;
        }

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;

          setLoadError({
            noteId: activeNoteId,
            message:
              body?.error?.message ?? "Uložený zápis se nepodařilo načíst.",
          });
          return;
        }

        setLoaded({
          noteId: activeNoteId,
          note: (await response.json()) as NoteDetail,
        });
        setLoadError(null);
      } catch {
        if (!cancelled) {
          setLoadError({
            noteId: activeNoteId,
            message: "Uložený zápis se nepodařilo načíst. Zkontrolujte připojení.",
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeNoteId]);

  if (unique.length === 0) {
    return null;
  }

  const note = loaded?.noteId === activeNoteId ? loaded.note : null;
  const noteError =
    loadError?.noteId === activeNoteId ? loadError.message : null;

  return (
    <section
      aria-labelledby="meeting-suggestions-heading"
      className="mt-6 rounded-2xl border border-stone-200 bg-white p-5"
      data-testid="meeting-suggestions"
    >
      <h2
        className="text-xl font-semibold text-stone-950"
        id="meeting-suggestions-heading"
      >
        Shrnutí, rozhodnutí a úkoly schůzky
      </h2>
      <p className="mt-2 text-sm leading-6 text-stone-600">
        Návrhy vznikají jen na výslovný požadavek a jsou odvozené, neuložené
        artefakty. Do OpenRouteru se odešle pouze vybraná pasáž zdrojového
        přepisu. Do poznámky se návrhy dostanou až přes viditelný P22/P23 diff
        a samostatné potvrzení; zdrojový přepis zůstává beze změny a je stále
        čitelný v poznámce i její historii.
      </p>

      {unique.length > 1 ? (
        <label className="mt-3 block text-sm font-medium text-stone-700">
          Uložený zápis
          <select
            className="mt-1 w-full rounded-lg border border-stone-300 bg-white p-2 text-sm"
            data-testid="meeting-suggestion-note"
            onChange={(event) => setSelectedNoteId(event.target.value)}
            value={activeNoteId}
          >
            {unique.map((link) => (
              <option key={link.noteId} value={link.noteId}>
                {noteLabel(link)}
              </option>
            ))}
          </select>
        </label>
      ) : noteError === null ? (
        <p
          className="mt-2 text-sm text-stone-700"
          data-testid="meeting-suggestion-note-label"
        >
          Uložený zápis: {note?.title ?? "Načítám…"}
        </p>
      ) : null}

      {unique.length > 1 && note ? (
        <p
          className="mt-1 text-sm text-stone-700"
          data-testid="meeting-suggestion-selected-note"
        >
          Vybraný zápis: {note.title}
        </p>
      ) : null}

      {activeNoteId !== "" ? (
        <a
          className="mt-1 inline-block text-sm text-sky-800 underline"
          data-testid="meeting-suggestion-open-note"
          href={`/notes/${activeNoteId}`}
        >
          Otevřít poznámku
        </a>
      ) : null}

      {llmError ? (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          {llmError}
        </p>
      ) : null}

      {llmStatus === null || !llmStatus.configured ? (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          {llmStatus?.blockedReason ??
            "Návrhy nejsou nakonfigurované. Uložený přepis můžete dál číst a upravovat ručně."}
        </p>
      ) : (
        <p className="mt-2 text-xs leading-5 text-stone-500">
          OpenRouter · {llmStatus.model} · shrnutí a rozhodnutí = 2 placené
          požadavky, odhad až{" "}
          {formatUsdAmount(String(llmStatus.estimatedMaxCostUsd * 2))}; úkoly =
          1 požadavek, odhad až{" "}
          {formatUsdAmount(String(llmStatus.estimatedMaxCostUsd))}.
        </p>
      )}

      {noteError ? (
        <p
          className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
          role="alert"
        >
          {noteError}
        </p>
      ) : null}

      {note === null && noteError === null ? (
        <p className="mt-3 text-sm text-stone-600">Načítám uložený zápis…</p>
      ) : null}

      {note ? (
        <MeetingSuggestionEditor
          key={note.id}
          llmStatus={llmStatus}
          note={note}
          onNoteUpdated={(updated) =>
            setLoaded({ noteId: updated.id, note: updated })
          }
        />
      ) : null}
    </section>
  );
}

function MeetingSuggestionEditor({
  note,
  llmStatus,
  onNoteUpdated,
}: {
  readonly note: NoteDetail;
  readonly llmStatus: LlmProviderStatus | null;
  readonly onNoteUpdated: (note: NoteDetail) => void;
}) {
  const [scope, setScope] = useState<"full" | "range">("full");
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [summary, setSummary] = useState<SummaryArtifact | null>(null);
  const [decisions, setDecisions] = useState<DecisionsArtifact | null>(null);
  const [decisionsDraft, setDecisionsDraft] = useState("");
  const [tasks, setTasks] = useState<TaskSuggestion | null>(null);
  const [taskItems, setTaskItems] = useState<EditableTask[]>([]);
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const [proposalKind, setProposalKind] = useState<
    "summary" | "decisions" | "tasks" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<"summary" | "tasks" | null>(null);
  const [preparing, setPreparing] = useState<
    "summary" | "decisions" | "tasks" | null
  >(null);
  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const nonceRef = useRef<string | null>(null);
  const providerBlocked = llmStatus === null || !llmStatus.configured;
  const fullGraphemes = countGraphemes(note.contentPlain);
  const selectedText =
    scope === "full"
      ? note.contentPlain
      : note.contentPlain.slice(selection.start, selection.end);
  const selectedGraphemes = countGraphemes(selectedText);
  const summaryRangeValid =
    scope === "full"
      ? fullGraphemes <= SUMMARY_MAX_SOURCE_GRAPHEMES
      : selection.end > selection.start &&
        selectedGraphemes <= SUMMARY_MAX_SOURCE_GRAPHEMES;
  const taskRangeValid =
    scope === "full"
      ? fullGraphemes <= TASK_SUGGESTION_MAX_SOURCE_GRAPHEMES
      : selection.end > selection.start &&
        selectedGraphemes <= TASK_SUGGESTION_MAX_SOURCE_GRAPHEMES;
  const summaryStale = summary !== null && summary.noteVersion !== note.version;
  const decisionsStale =
    decisions !== null && decisions.noteVersion !== note.version;
  const tasksStale = tasks !== null && tasks.noteVersion !== note.version;

  function clearProposal(): void {
    setProposal(null);
    setProposalKind(null);
    nonceRef.current = null;
  }

  function resetArtifacts(): void {
    setSummary(null);
    setDecisions(null);
    setDecisionsDraft("");
    setTasks(null);
    setTaskItems([]);
    clearProposal();
    setError(null);
    setStatus(null);
  }

  function requestRange(): { start: number; end: number } {
    return scope === "full"
      ? { start: 0, end: note.contentPlain.length }
      : { start: selection.start, end: selection.end };
  }

  async function generateSummaryDecisions(): Promise<void> {
    if (busy !== null || !summaryRangeValid) {
      return;
    }

    setBusy("summary");
    resetArtifacts();

    try {
      const response = await fetch(`/api/notes/${note.id}/ai-suggest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "meeting_summary_decisions",
          ...requestRange(),
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | SummaryDecisionsResponse
        | { error?: { message?: string } }
        | null;

      if (!response.ok) {
        throw new Error(
          (body as { error?: { message?: string } } | null)?.error?.message ??
            "Shrnutí a rozhodnutí se nepodařilo připravit.",
        );
      }

      const result = body as SummaryDecisionsResponse;

      setSummary({
        noteVersion: result.noteVersion,
        text: result.summaryText,
        sourceGraphemes: result.summarySourceGraphemes,
      });

      if (result.decisionsText !== null) {
        setDecisions({
          noteVersion: result.noteVersion,
          text: result.decisionsText,
          sourceGraphemes: result.decisionsSourceGraphemes,
        });
        setDecisionsDraft(result.decisionsText);
        setStatus(
          "Shrnutí a rozhodnutí jsou odvozené náhledy. Zkontrolujte zdroj i navržené sekce; nic se nezmění bez potvrzení difflu.",
        );
      } else {
        setDecisions(null);
        setDecisionsDraft("");
        setStatus(
          "Shrnutí je připravené. Rozhodnutí se nepodařilo vytvořit; shrnutí můžete přesto zkontrolovat a vložit.",
        );
        setError(
          result.decisionsError?.message ??
            "Rozhodnutí se nepodařilo vytvořit. Shrnutí zůstává k dispozici.",
        );
      }
    } catch (generateError) {
      setError(
        errorMessage(
          generateError,
          "Shrnutí a rozhodnutí se nepodařilo připravit.",
        ),
      );
    } finally {
      setBusy(null);
    }
  }

  async function generateTasks(): Promise<void> {
    if (busy !== null || !taskRangeValid) {
      return;
    }

    setBusy("tasks");
    setTasks(null);
    setTaskItems([]);
    clearProposal();
    setError(null);
    setStatus(null);

    try {
      const response = await fetch(`/api/notes/${note.id}/ai-suggest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "meeting_tasks", ...requestRange() }),
      });
      const body = (await response.json().catch(() => null)) as
        | TaskSuggestion
        | { error?: { message?: string } }
        | null;

      if (!response.ok) {
        throw new Error(
          (body as { error?: { message?: string } } | null)?.error?.message ??
            "Úkoly se nepodařilo připravit.",
        );
      }

      const result = body as TaskSuggestion;

      setTasks(result);
      setTaskItems(
        result.tasks.map((task, index) => ({
          duplicate: task.duplicate,
          key: `${index}:${task.normalized}`,
          selected: !task.duplicate,
          text: task.text,
        })),
      );
      setStatus(
        "Návrh úkolů je připravený. Duplicity jsou označené; do poznámky se nic nezapíše bez potvrzení.",
      );
    } catch (generateError) {
      setError(errorMessage(generateError, "Úkoly se nepodařilo připravit."));
    } finally {
      setBusy(null);
    }
  }

  async function prepareSummaryProposal(): Promise<void> {
    if (preparing !== null) {
      return;
    }

    if (summary === null || summaryStale) {
      setError("Shrnutí je zastaralé. Vytvořte ho znovu.");
      return;
    }

    clearProposal();
    setError(null);
    setStatus(null);
    setPreparing("summary");

    try {
      const created = await createEditProposal(note.id, {
        operation: {
          type: "append_bounded_section",
          text: summary.text,
        },
        expectedVersion: summary.noteVersion,
      });
      const { confirmationNonce, ...preview } = created;

      nonceRef.current = confirmationNonce;
      setProposal(preview);
      setProposalKind("summary");
      setStatus(
        "Návrh vložení shrnutí je připravený. Poznámka se změní až po potvrzení.",
      );
    } catch (proposalError) {
      setError(
        proposalError instanceof ProposalApiError
          ? proposalError.message
          : errorMessage(proposalError, "Vložení shrnutí se nepodařilo připravit."),
      );
    } finally {
      setPreparing(null);
    }
  }

  async function prepareDecisionsProposal(): Promise<void> {
    if (preparing !== null) {
      return;
    }

    if (decisions === null || decisionsStale) {
      setError("Rozhodnutí jsou zastaralá. Vytvořte je znovu.");
      return;
    }

    const text = decisionsDraft.trim();

    if (text === "") {
      setError("Sekce rozhodnutí je prázdná.");
      return;
    }

    clearProposal();
    setError(null);
    setStatus(null);
    setPreparing("decisions");

    try {
      const created = await createEditProposal(note.id, {
        operation: { type: "append_bounded_section", text },
        expectedVersion: decisions.noteVersion,
      });
      const { confirmationNonce, ...preview } = created;

      nonceRef.current = confirmationNonce;
      setProposal(preview);
      setProposalKind("decisions");
      setStatus(
        "Návrh vložení rozhodnutí je připravený. Poznámka se změní až po potvrzení.",
      );
    } catch (proposalError) {
      setError(
        proposalError instanceof ProposalApiError
          ? proposalError.message
          : errorMessage(
              proposalError,
              "Vložení rozhodnutí se nepodařilo připravit.",
            ),
      );
    } finally {
      setPreparing(null);
    }
  }

  async function prepareTasksProposal(): Promise<void> {
    if (preparing !== null) {
      return;
    }

    if (tasks === null || tasksStale) {
      setError("Návrh úkolů je zastaralý. Vytvořte ho znovu.");
      return;
    }

    if (Date.parse(tasks.expiresAt) <= Date.now()) {
      setError("Návrh úkolů vypršel. Vytvořte nový; poznámka zůstala beze změny.");
      return;
    }

    const selectedTasks = taskItems
      .filter((item) => item.selected)
      .map((item) => item.text.trim())
      .filter((text) => text !== "");

    if (selectedTasks.length === 0) {
      setError("Vyberte alespoň jeden úkol.");
      return;
    }

    clearProposal();
    setError(null);
    setStatus(null);
    setPreparing("tasks");

    try {
      const taskApply = await fetch(`/api/notes/${note.id}/ai-suggest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "task_apply",
          expectedVersion: tasks.noteVersion,
          tasks: selectedTasks,
        }),
      });
      const preparedBody = (await taskApply.json().catch(() => null)) as
        | TaskApplyResponse
        | { error?: { message?: string } }
        | null;

      if (!taskApply.ok) {
        throw new Error(
          (preparedBody as { error?: { message?: string } } | null)?.error
            ?.message ?? "Vybrané úkoly se nepodařilo připravit k vložení.",
        );
      }

      const prepared = preparedBody as TaskApplyResponse;
      const created = await createEditProposal(note.id, {
        operation: prepared.operation,
        expectedVersion: prepared.noteVersion,
      });
      const { confirmationNonce, ...preview } = created;

      nonceRef.current = confirmationNonce;
      setProposal(preview);
      setProposalKind("tasks");
      setStatus(
        "Návrh vložení úkolů je připravený. Poznámka se změní až po potvrzení.",
      );
    } catch (proposalError) {
      setError(
        proposalError instanceof ProposalApiError
          ? proposalError.message
          : errorMessage(
              proposalError,
              "Vložení úkolů se nepodařilo připravit.",
            ),
      );
    } finally {
      setPreparing(null);
    }
  }

  async function confirm(current: EditProposal): Promise<void> {
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
      onNoteUpdated(confirmed.note);

      if (proposalKind === "summary") {
        setSummary(null);
        setStatus("Shrnutí bylo vloženo jako nová revize.");
      } else if (proposalKind === "decisions") {
        setDecisions(null);
        setDecisionsDraft("");
        setStatus("Rozhodnutí byla vložena jako nová revize.");
      } else if (proposalKind === "tasks") {
        setTasks(null);
        setTaskItems([]);
        setStatus("Úkoly byly vloženy jako nová revize.");
      }
    } catch (confirmError) {
      setError(errorMessage(confirmError, "Potvrzení se nepodařilo."));
    } finally {
      setConfirming(false);
    }
  }

  async function reject(current: EditProposal): Promise<void> {
    setRejecting(true);
    setError(null);

    try {
      setProposal(await rejectEditProposal(note.id, current.id));
      nonceRef.current = null;
      setStatus("Návrh byl zamítnut. Poznámka zůstala beze změny.");
    } catch (rejectError) {
      setError(errorMessage(rejectError, "Zamítnutí se nepodařilo."));
    } finally {
      setRejecting(false);
    }
  }

  return (
    <>
      <label className="mt-4 block text-sm font-medium text-stone-700">
        Rozsah zdroje
        <select
          className="mt-1 w-full rounded-lg border border-stone-300 bg-white p-2 text-sm disabled:bg-stone-100"
          data-testid="meeting-suggestion-scope"
          disabled={busy !== null}
          onChange={(event) => {
            setScope(event.target.value as "full" | "range");
            resetArtifacts();
          }}
          value={scope}
        >
          <option value="full">Celý uložený zápis</option>
          <option value="range">Vybraný text</option>
        </select>
      </label>

      <label className="mt-3 block text-sm font-medium text-stone-700">
        Zdrojový přepis pro výběr pasáže
        <textarea
          aria-label="Zdrojový přepis schůzky"
          className="mt-1 h-32 w-full resize-y rounded-lg border border-stone-300 bg-stone-50 p-3 font-mono text-xs leading-5 text-stone-800"
          data-testid="meeting-suggestion-source"
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
        {scope === "full"
          ? `Celý zápis: ${fullGraphemes.toLocaleString("cs-CZ")} znaků.`
          : `Vybraná pasáž: ${selectedGraphemes.toLocaleString("cs-CZ")} znaků.`}{" "}
        Shrnutí a rozhodnutí mají limit{" "}
        {SUMMARY_MAX_SOURCE_GRAPHEMES.toLocaleString("cs-CZ")} znaků, úkoly{" "}
        {TASK_SUGGESTION_MAX_SOURCE_GRAPHEMES.toLocaleString("cs-CZ")} znaků.
      </p>

      {!summaryRangeValid ? (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          {scope === "full"
            ? "Zápis je pro shrnutí příliš dlouhý. Vyberte prosím kratší pasáž; text se nezkracuje automaticky."
            : "Vyberte neprázdnou pasáž do 8 000 znaků."}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className="rounded-lg bg-stone-800 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600"
          data-testid="meeting-summary-generate"
          disabled={
            busy !== null || providerBlocked || !summaryRangeValid
          }
          onClick={() => void generateSummaryDecisions()}
          type="button"
        >
          {busy === "summary"
            ? "Připravuji shrnutí a rozhodnutí…"
            : "Získat shrnutí a rozhodnutí"}
        </button>
        <button
          className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-400"
          data-testid="meeting-tasks-generate"
          disabled={busy !== null || providerBlocked || !taskRangeValid}
          onClick={() => void generateTasks()}
          type="button"
        >
          {busy === "tasks" ? "Připravuji úkoly…" : "Získat úkoly"}
        </button>
      </div>

      {!taskRangeValid ? (
        <p className="mt-2 text-xs text-stone-600">
          Pro úkoly vyberte pasáž do{" "}
          {TASK_SUGGESTION_MAX_SOURCE_GRAPHEMES.toLocaleString("cs-CZ")} znaků.
        </p>
      ) : null}

      {summary ? (
        <div
          className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4"
          data-testid="meeting-summary-artifact"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-900">
            Odvozené shrnutí · neuloženo · verze {summary.noteVersion}
          </p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-emerald-950">
            {summary.text}
          </p>
          <p className="mt-2 text-xs text-emerald-900">
            Zdroj: {summary.sourceGraphemes.toLocaleString("cs-CZ")} znaků.
          </p>
          <button
            className="mt-3 rounded-lg bg-emerald-800 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
            data-testid="meeting-summary-propose"
            disabled={summaryStale || confirming || preparing !== null}
            onClick={() => void prepareSummaryProposal()}
            type="button"
          >
            Připravit vložení shrnutí
          </button>
          {summaryStale ? (
            <p className="mt-2 text-sm text-amber-950">
              Poznámka se mezitím změnila. Vytvořte shrnutí znovu.
            </p>
          ) : null}
        </div>
      ) : null}

      {decisions ? (
        <div
          className="mt-4 rounded-xl border border-sky-200 bg-sky-50 p-4"
          data-testid="meeting-decisions-artifact"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-sky-900">
            Navržená rozhodnutí · neuloženo · verze {decisions.noteVersion}
          </p>
          <label className="mt-2 block text-sm font-medium text-stone-800">
            Sekce rozhodnutí (můžete upravit)
            <textarea
              className="mt-1 min-h-32 w-full rounded-lg border border-stone-300 p-2 font-mono text-xs leading-5"
              data-testid="meeting-decisions-text"
              disabled={decisionsStale || confirming}
              onChange={(event) => setDecisionsDraft(event.target.value)}
              value={decisionsDraft}
            />
          </label>
          <p className="mt-2 text-xs text-sky-900">
            Zdroj: {decisions.sourceGraphemes.toLocaleString("cs-CZ")} znaků.
            Zkontrolujte, že každé rozhodnutí je výslovně ve zdrojovém přepisu a
            že neobsahuje přiřazení mluvčího.
          </p>
          <button
            className="mt-3 rounded-lg bg-sky-800 px-3 py-2 text-sm font-semibold text-white hover:bg-sky-900 disabled:cursor-not-allowed disabled:bg-stone-300"
            data-testid="meeting-decisions-propose"
            disabled={
              decisionsStale ||
              confirming ||
              preparing !== null ||
              decisionsDraft.trim() === ""
            }
            onClick={() => void prepareDecisionsProposal()}
            type="button"
          >
            Připravit vložení rozhodnutí
          </button>
          {decisionsStale ? (
            <p className="mt-2 text-sm text-amber-950">
              Poznámka se mezitím změnila. Vytvořte rozhodnutí znovu.
            </p>
          ) : null}
        </div>
      ) : null}

      {tasks ? (
        <div
          className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-4"
          data-testid="meeting-tasks-artifact"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-stone-700">
            Navržené úkoly · neuloženo · verze {tasks.noteVersion}
          </p>
          <ul className="mt-2 space-y-2">
            {taskItems.map((item, index) => (
              <li className="flex items-start gap-2" key={item.key}>
                <input
                  checked={item.selected}
                  className="mt-1"
                  data-testid={`meeting-task-${index}`}
                  disabled={tasksStale || confirming}
                  onChange={(event) => {
                    const selected = event.target.checked;

                    setTaskItems((current) =>
                      current.map((candidate, itemIndex) =>
                        itemIndex === index
                          ? { ...candidate, selected }
                          : candidate,
                      ),
                    );
                  }}
                  type="checkbox"
                />
                <input
                  className="min-w-0 flex-1 rounded-lg border border-stone-300 px-2 py-1 text-sm"
                  data-testid={`meeting-task-text-${index}`}
                  disabled={tasksStale || confirming}
                  maxLength={TASK_SUGGESTION_MAX_TEXT_GRAPHEMES}
                  onChange={(event) => {
                    const text = event.target.value;

                    setTaskItems((current) =>
                      current.map((candidate, itemIndex) =>
                        itemIndex === index
                          ? { ...candidate, text }
                          : candidate,
                      ),
                    );
                  }}
                  value={item.text}
                />
                {item.duplicate ? (
                  <span className="mt-1 text-xs font-medium text-amber-800">
                    duplicita
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <button
            className="mt-3 rounded-lg bg-stone-800 px-3 py-2 text-sm font-semibold text-white hover:bg-stone-900 disabled:cursor-not-allowed disabled:bg-stone-300"
            data-testid="meeting-tasks-propose"
            disabled={
              tasksStale ||
              confirming ||
              preparing !== null ||
              taskItems.every((item) => !item.selected)
            }
            onClick={() => void prepareTasksProposal()}
            type="button"
          >
            Připravit vložení úkolů
          </button>
          {tasksStale ? (
            <p className="mt-2 text-sm text-amber-950">
              Poznámka se mezitím změnila. Vytvořte úkoly znovu.
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
          data-testid="meeting-suggestions-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {status ? (
        <p
          aria-live="polite"
          className="mt-3 text-sm text-stone-700"
          data-testid="meeting-suggestions-status"
        >
          {status}
        </p>
      ) : null}

      {proposal ? (
        <ChangePreview
          confirming={confirming}
          onConfirm={(current) => void confirm(current)}
          onReject={(current) => void reject(current)}
          proposal={proposal}
          rejecting={rejecting}
        />
      ) : null}
    </>
  );
}
