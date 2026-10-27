"use client";

import { formatCzechDateTime } from "@/lib/notes/client";
import type {
  EditProposal,
  EditProposalStatus,
} from "@/lib/notes/proposal-client";

const operationLabels: Record<EditProposal["operation"]["type"], string> = {
  replace_sentence: "Nahradit větu",
  insert_before_sentence: "Vložit před větu",
  insert_after_sentence: "Vložit za větu",
  delete_sentence: "Smazat větu",
  insert_heading_before_sentence: "Vložit nadpis před větu",
  replace_last_sentence: "Nahradit poslední větu",
  set_task_checked: "Změnit stav úkolu",
  replace_paragraph: "Nahradit odstavec",
  append_bounded_section: "Připojit omezenou sekci",
};

const statusLabels: Record<EditProposalStatus, string> = {
  pending: "Čeká na potvrzení",
  rejected: "Zamítnuto",
  applied: "Aplikováno",
  expired: "Vypršelo",
};

function operationTarget(proposal: EditProposal): string {
  if (proposal.selectedCandidate) {
    return proposal.selectedCandidate.snippet;
  }

  const operation = proposal.operation;

  switch (operation.type) {
    case "set_task_checked":
      return `Úkol: ${operation.taskText}`;
    case "replace_last_sentence":
      return "Poslední věta poznámky";
    case "append_bounded_section":
      return "Konec poznámky";
    default:
      return `„${operation.target.startPhrase}“ … „${operation.target.endPhrase}“`;
  }
}

export interface ChangePreviewProps {
  readonly proposal: EditProposal;
  readonly disabled?: boolean;
  readonly confirming?: boolean;
  readonly rejecting?: boolean;
  readonly onConfirm?: (proposal: EditProposal) => void;
  readonly onReject?: (proposal: EditProposal) => void;
}

export function ChangePreview({
  proposal,
  disabled = false,
  confirming = false,
  rejecting = false,
  onConfirm,
  onReject,
}: ChangePreviewProps) {
  const diff = proposal.diff;

  return (
    <section
      aria-labelledby="proposal-preview-heading"
      className="mt-6 rounded-2xl border border-stone-300 bg-white p-6"
      data-testid="proposal-preview"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3
            className="text-lg font-semibold text-stone-950"
            id="proposal-preview-heading"
          >
            Navržená úprava: {operationLabels[proposal.operation.type]}
          </h3>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            Poznámka: <strong>{proposal.noteTitle}</strong> · verze{" "}
            {proposal.expectedVersion} · cíl: {operationTarget(proposal)}
          </p>
        </div>
        <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-700">
          {statusLabels[proposal.status]}
        </span>
      </div>

      <p className="mt-2 text-xs leading-5 text-stone-500">
        Návrh je uložený bez změny poznámky. Platí do{" "}
        {formatCzechDateTime(proposal.expiresAt)}.
      </p>

      <p className="mt-4 text-sm font-medium text-stone-700">
        Textový diff (původní Markdown; nic se zatím neaplikovalo)
      </p>
      <pre
        className="mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-stone-200 bg-stone-50 p-4 font-mono text-xs leading-6 text-stone-800"
        data-testid="proposal-diff"
      >
        {diff.prefix}
        <del className="bg-red-100 text-red-900 decoration-red-700">
          {diff.removed}
        </del>
        <ins className="bg-emerald-100 text-emerald-950 no-underline">
          {diff.inserted}
        </ins>
        {diff.suffix}
      </pre>

      {proposal.status === "pending" && (onConfirm || onReject) ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {onConfirm ? (
            <button
              className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
              disabled={disabled || confirming || rejecting}
              onClick={() => onConfirm(proposal)}
              type="button"
            >
              {confirming ? "Ukládám…" : "Potvrdit"}
            </button>
          ) : null}
          {onReject ? (
            <button
              className="rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-800 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-stone-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
              disabled={disabled || confirming || rejecting}
              onClick={() => onReject(proposal)}
              type="button"
            >
              {rejecting ? "Zamítám…" : "Zamítnout návrh"}
            </button>
          ) : null}
          <span className="text-xs leading-5 text-stone-500">
            Potvrzení zapíše jednu revizi <code>ai</code> a spotřebuje
            jednorázové potvrzení. Zamítnutí pouze změní stav návrhu; obsah
            poznámky zůstane stejný.
          </span>
        </div>
      ) : null}
    </section>
  );
}
