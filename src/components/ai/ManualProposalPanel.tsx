"use client";

import { useRef, useState } from "react";

import type { LlmOperation } from "@/lib/ai/schemas";
import type { OperationCandidate } from "@/lib/notes/operations";
import {
  ProposalApiError,
  createEditProposal,
  rejectEditProposal,
  type EditProposal,
} from "@/lib/notes/proposal-client";

import { ChangePreview } from "./ChangePreview";

type OperationType = LlmOperation["type"];

const operationOptions: { value: OperationType; label: string }[] = [
  { value: "replace_sentence", label: "Nahradit větu" },
  { value: "insert_before_sentence", label: "Vložit před větu" },
  { value: "insert_after_sentence", label: "Vložit za větu" },
  { value: "delete_sentence", label: "Smazat větu" },
  {
    value: "insert_heading_before_sentence",
    label: "Vložit nadpis před větu",
  },
  { value: "replace_last_sentence", label: "Nahradit poslední větu" },
  { value: "set_task_checked", label: "Změnit stav úkolu" },
  { value: "replace_paragraph", label: "Nahradit odstavec" },
  { value: "append_bounded_section", label: "Připojit omezenou sekci" },
];

const targetTypes = new Set<OperationType>([
  "replace_sentence",
  "insert_before_sentence",
  "insert_after_sentence",
  "delete_sentence",
  "insert_heading_before_sentence",
  "replace_paragraph",
]);

const textTypes = new Set<OperationType>([
  "replace_sentence",
  "insert_before_sentence",
  "insert_after_sentence",
  "insert_heading_before_sentence",
  "replace_last_sentence",
  "replace_paragraph",
  "append_bounded_section",
]);

interface AmbiguousProposal {
  readonly operation: LlmOperation;
  readonly candidates: readonly OperationCandidate[];
  readonly noteVersion: number | null;
  readonly sourceHash: string | null;
}

export interface ManualProposalPanelProps {
  readonly noteId: string;
  readonly noteTitle: string;
  readonly noteVersion: number;
  readonly disabled?: boolean;
}

export function ManualProposalPanel({
  noteId,
  noteTitle,
  noteVersion,
  disabled = false,
}: ManualProposalPanelProps) {
  const [operationType, setOperationType] =
    useState<OperationType>("replace_sentence");
  const [startPhrase, setStartPhrase] = useState("");
  const [endPhrase, setEndPhrase] = useState("");
  const [text, setText] = useState("");
  const [headingDepth, setHeadingDepth] = useState(2);
  const [taskText, setTaskText] = useState("");
  const [checked, setChecked] = useState(true);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const [ambiguous, setAmbiguous] = useState<AmbiguousProposal | null>(null);
  const confirmationNonceRef = useRef<string | null>(null);

  function buildOperation(): LlmOperation | null {
    if (targetTypes.has(operationType)) {
      if (startPhrase.trim() === "" || endPhrase.trim() === "") {
        setError("Zadejte začátek i konec cílové fráze.");
        return null;
      }
    }

    if (textTypes.has(operationType) && text.trim() === "") {
      setError("Zadejte text operace.");
      return null;
    }

    const target = { startPhrase, endPhrase };

    switch (operationType) {
      case "replace_sentence":
        return { type: operationType, target, text };
      case "insert_before_sentence":
        return { type: operationType, target, text };
      case "insert_after_sentence":
        return { type: operationType, target, text };
      case "delete_sentence":
        return { type: operationType, target };
      case "insert_heading_before_sentence":
        return {
          type: operationType,
          target,
          depth: headingDepth,
          text,
        };
      case "replace_last_sentence":
        return { type: operationType, text };
      case "set_task_checked":
        if (taskText.trim() === "") {
          setError("Zadejte text úkolu.");
          return null;
        }
        return { type: operationType, taskText, checked };
      case "replace_paragraph":
        return { type: operationType, target, text };
      case "append_bounded_section":
        return { type: operationType, text };
    }
  }

  function acceptCreated(created: {
    readonly confirmationNonce: string;
    readonly proposal: EditProposal;
  }) {
    confirmationNonceRef.current = created.confirmationNonce;
    setProposal(created.proposal);
    setAmbiguous(null);
    setError(null);
  }

  async function submitOperation(operation: LlmOperation) {
    setBusy(true);
    setError(null);

    try {
      const created = await createEditProposal(noteId, {
        operation,
        expectedVersion: noteVersion,
      });

      const { confirmationNonce, ...preview } = created;
      acceptCreated({ confirmationNonce, proposal: preview });
    } catch (submitError) {
      if (
        submitError instanceof ProposalApiError &&
        submitError.code === "proposal_ambiguous" &&
        submitError.candidates.length > 0
      ) {
        setAmbiguous({
          operation,
          candidates: submitError.candidates,
          noteVersion: submitError.noteVersion,
          sourceHash: submitError.sourceHash,
        });
        setError(null);
      } else {
        setError(
          submitError instanceof Error
            ? submitError.message
            : "Návrh se nepodařilo vytvořit.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate() {
    const operation = buildOperation();
    if (operation !== null) {
      await submitOperation(operation);
    }
  }

  async function selectCandidate(candidate: OperationCandidate) {
    if (
      ambiguous === null ||
      ambiguous.noteVersion === null ||
      ambiguous.sourceHash === null
    ) {
      setError("Kandidát není svázán s verzí a hashem poznámky.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const created = await createEditProposal(noteId, {
        operation: ambiguous.operation,
        candidateId: candidate.id,
        expectedVersion: ambiguous.noteVersion,
        expectedSourceHash: ambiguous.sourceHash,
      });
      const { confirmationNonce, ...preview } = created;
      acceptCreated({ confirmationNonce, proposal: preview });
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Vybraný kandidát se nepodařilo použít.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleReject(current: EditProposal) {
    setRejecting(true);
    setError(null);

    try {
      const rejected = await rejectEditProposal(noteId, current.id);
      setProposal(rejected);
      confirmationNonceRef.current = null;
    } catch (rejectError) {
      setError(
        rejectError instanceof Error
          ? rejectError.message
          : "Návrh se nepodařilo zamítnout.",
      );
    } finally {
      setRejecting(false);
    }
  }

  function handleTypeChange(next: OperationType) {
    setOperationType(next);
    setAmbiguous(null);
    setError(null);
  }

  return (
    <section
      aria-labelledby="manual-proposal-heading"
      className="mt-6 rounded-2xl border border-stone-200 bg-white p-6"
    >
      <h2
        className="text-xl font-semibold text-stone-950"
        id="manual-proposal-heading"
      >
        Ruční strukturovaný návrh úpravy
      </h2>
      <p className="mt-2 text-sm leading-6 text-stone-600">
        Poznámka: <strong>{noteTitle}</strong>. Tento panel vytváří uložený
        návrh bez volání LLM. Server použije P22 resolver, zobrazí přesný diff a
        poznámku nezmění. Potvrzení a aplikace přijdou v navazující fázi.
      </p>

      {disabled ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
          Nejprve uložte neuložené změny. Návrh musí vycházet z uložené verze
          poznámky.
        </p>
      ) : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium text-stone-700">
          Operace
          <select
            className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm disabled:bg-stone-100"
            disabled={busy || disabled}
            onChange={(event) =>
              handleTypeChange(event.target.value as OperationType)
            }
            value={operationType}
          >
            {operationOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {targetTypes.has(operationType) ? (
          <>
            <label className="text-sm font-medium text-stone-700">
              Začátek cíle
              <input
                className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm disabled:bg-stone-100"
                disabled={busy || disabled}
                onChange={(event) => setStartPhrase(event.target.value)}
                value={startPhrase}
              />
            </label>
            <label className="text-sm font-medium text-stone-700">
              Konec cíle
              <input
                className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm disabled:bg-stone-100"
                disabled={busy || disabled}
                onChange={(event) => setEndPhrase(event.target.value)}
                value={endPhrase}
              />
            </label>
          </>
        ) : null}

        {operationType === "insert_heading_before_sentence" ? (
          <label className="text-sm font-medium text-stone-700">
            Úroveň nadpisu
            <input
              className="mt-1 w-24 rounded-lg border border-stone-300 px-3 py-2 text-sm"
              disabled={busy || disabled}
              max={3}
              min={1}
              onChange={(event) => setHeadingDepth(Number(event.target.value))}
              type="number"
              value={headingDepth}
            />
          </label>
        ) : null}

        {operationType === "set_task_checked" ? (
          <>
            <label className="text-sm font-medium text-stone-700">
              Text úkolu
              <input
                className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
                disabled={busy || disabled}
                onChange={(event) => setTaskText(event.target.value)}
                value={taskText}
              />
            </label>
            <label className="mt-6 flex items-center gap-2 text-sm text-stone-700">
              <input
                checked={checked}
                disabled={busy || disabled}
                onChange={(event) => setChecked(event.target.checked)}
                type="checkbox"
              />
              Označit jako hotové
            </label>
          </>
        ) : null}
      </div>

      {textTypes.has(operationType) ? (
        <label className="mt-4 block text-sm font-medium text-stone-700">
          {operationType === "append_bounded_section"
            ? "Text nové sekce"
            : "Text operace"}
          <textarea
            className="mt-1 min-h-28 w-full rounded-lg border border-stone-300 p-3 font-mono text-sm"
            disabled={busy || disabled}
            onChange={(event) => setText(event.target.value)}
            value={text}
          />
        </label>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          className="rounded-lg bg-stone-800 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          disabled={busy || disabled}
          onClick={() => void handleCreate()}
          type="button"
        >
          {busy ? "Vytvářím návrh…" : "Vytvořit návrh a zobrazit diff"}
        </button>
        <span className="text-xs leading-5 text-stone-500">
          Návrh platí 5 minut. Vytvoření, zobrazení ani zamítnutí nemění
          poznámku.
        </span>
      </div>

      {ambiguous ? (
        <fieldset className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <legend className="text-sm font-semibold text-amber-950">
            Cíl odpovídá více místům
          </legend>
          <div className="mt-2 space-y-2">
            {ambiguous.candidates.map((candidate) => (
              <button
                className="block w-full rounded-lg border border-amber-300 bg-white p-3 text-left text-sm text-stone-800 hover:bg-amber-100 disabled:opacity-50"
                disabled={busy || disabled}
                key={candidate.id}
                onClick={() => void selectCandidate(candidate)}
                type="button"
              >
                <strong>{candidate.ordinal}.</strong> {candidate.snippet}
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}

      {error ? (
        <p
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-900"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {proposal ? (
        <ChangePreview
          onReject={(current) => void handleReject(current)}
          proposal={proposal}
          rejecting={rejecting}
        />
      ) : null}
    </section>
  );
}
