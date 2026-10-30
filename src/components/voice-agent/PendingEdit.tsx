"use client";

import { useEffect, useState } from "react";

import type { LlmOperation } from "@/lib/ai/schemas";
import { formatCzechDateTime } from "@/lib/notes/client";
import type { OperationCandidate } from "@/lib/notes/operations";
import {
  proposalOperationLabel,
  proposalTargetLabel,
  type EditProposalDiff,
  type EditProposalStatus,
} from "@/lib/notes/proposal-client";

interface PendingProposal {
  readonly proposalId: string;
  readonly noteId: string;
  readonly noteTitle: string;
  readonly expectedVersion: number;
  readonly operation: LlmOperation;
  readonly selectedCandidate: OperationCandidate | null;
  readonly status: EditProposalStatus;
  readonly diff: EditProposalDiff;
  readonly expiresAt: string;
  readonly confirmationNonce: string | null;
}

const statusLabels: Record<EditProposalStatus, string> = {
  pending: "Čeká na potvrzení",
  rejected: "Zamítnuto",
  applied: "Aplikováno",
  expired: "Vypršelo",
};

function readError(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const error = (value as { error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return null;
  }

  const message = (error as { message?: unknown }).message;

  return typeof message === "string" && message.trim() !== ""
    ? message
    : null;
}

function readProposal(value: unknown): PendingProposal | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const proposal = (value as { proposal?: unknown }).proposal;

  if (typeof proposal !== "object" || proposal === null) {
    return null;
  }

  const candidate = proposal as Record<string, unknown>;

  if (
    typeof candidate.proposalId !== "string" ||
    typeof candidate.noteId !== "string" ||
    typeof candidate.noteTitle !== "string" ||
    typeof candidate.expectedVersion !== "number" ||
    typeof candidate.operation !== "object" ||
    candidate.operation === null ||
    (candidate.status !== "pending" &&
      candidate.status !== "rejected" &&
      candidate.status !== "applied" &&
      candidate.status !== "expired") ||
    typeof candidate.diff !== "object" ||
    candidate.diff === null ||
    typeof candidate.expiresAt !== "string"
  ) {
    return null;
  }

  return candidate as unknown as PendingProposal;
}

export interface PendingEditProps {
  readonly proposalId: string;
  readonly sessionId: string;
  readonly onClose: () => void;
}

export function PendingEdit({
  proposalId,
  sessionId,
  onClose,
}: PendingEditProps) {
  const [proposal, setProposal] = useState<PendingProposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      setLoading(true);
      setError(null);
      setProposal(null);

      try {
        const response = await fetch(
          `/api/voice-agent/pending/${encodeURIComponent(proposalId)}`,
          {
            body: JSON.stringify({ sessionId }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
        const payload: unknown = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(
            readError(payload) ?? "Návrh se nepodařilo načíst.",
          );
        }

        const next = readProposal(payload);

        if (!next) {
          throw new Error("Server vrátil neplatný návrh.");
        }

        if (!cancelled) {
          setProposal(next);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Návrh se nepodařilo načíst.",
          );
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
  }, [proposalId, sessionId]);

  async function reject(): Promise<void> {
    if (!proposal || rejecting) {
      return;
    }

    setRejecting(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/voice-agent/pending/${encodeURIComponent(proposal.proposalId)}`,
        {
          body: JSON.stringify({ action: "reject", sessionId }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          readError(payload) ?? "Návrh se nepodařilo zamítnout.",
        );
      }

      const status =
        typeof payload === "object" && payload !== null
          ? (payload as { status?: unknown }).status
          : null;

      if (
        status !== "rejected" &&
        status !== "expired" &&
        status !== "applied"
      ) {
        throw new Error("Server nepotvrdil zamítnutí návrhu.");
      }

      setProposal({
        ...proposal,
        confirmationNonce: null,
        status,
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Návrh se nepodařilo zamítnout.",
      );
    } finally {
      setRejecting(false);
    }
  }

  return (
    <section
      aria-labelledby="voice-agent-pending-title"
      className="mt-4 rounded-2xl border border-stone-300 bg-white p-4"
      data-testid="voice-agent-pending-edit"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3
            className="text-sm font-semibold text-stone-900"
            id="voice-agent-pending-title"
          >
            Navržená úprava:{" "}
            {proposal
              ? proposalOperationLabel(proposal.operation.type)
              : "načítám…"}
          </h3>
          {proposal ? (
            <p className="mt-1 text-xs leading-5 text-stone-600">
              Poznámka: <strong>{proposal.noteTitle}</strong> · verze{" "}
              {proposal.expectedVersion} · cíl:{" "}
              {proposalTargetLabel(proposal)}
            </p>
          ) : null}
        </div>
        {proposal ? (
          <span className="w-fit rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-700">
            {statusLabels[proposal.status]}
          </span>
        ) : null}
      </div>

      {loading ? (
        <p className="mt-3 text-sm text-stone-600">Načítám náhled…</p>
      ) : null}

      {error !== null ? (
        <p
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2 text-xs leading-5 text-red-900"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {proposal ? (
        <>
          <p className="mt-2 text-xs leading-5 text-stone-500">
            Návrh je uložený bez změny poznámky. Platí do{" "}
            {formatCzechDateTime(proposal.expiresAt)}.
          </p>

          <p className="mt-3 text-xs font-medium text-stone-700">
            Úplná navržená změna (původní Markdown; nic se zatím neaplikovalo)
          </p>
          <pre
            className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-stone-200 bg-stone-50 p-3 font-mono text-xs leading-6 text-stone-800"
            data-testid="voice-agent-pending-diff"
          >
            {proposal.diff.prefix}
            <del className="bg-red-100 text-red-900 decoration-red-700">
              {proposal.diff.removed}
            </del>
            <ins className="bg-emerald-100 text-emerald-950 no-underline">
              {proposal.diff.inserted}
            </ins>
            {proposal.diff.suffix}
          </pre>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600"
              disabled
              title="Potvrzení bude dostupné v P50"
              type="button"
            >
              Potvrdit
            </button>
            <button
              className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-semibold text-red-800 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-stone-400"
              data-testid="voice-agent-pending-reject"
              disabled={rejecting || proposal.status !== "pending"}
              onClick={() => {
                void reject();
              }}
              type="button"
            >
              {rejecting ? "Zamítám…" : "Zamítnout"}
            </button>
            {proposal.status === "pending" ? null : (
              <button
                className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-semibold text-stone-700 hover:bg-stone-100"
                onClick={onClose}
                type="button"
              >
                Zavřít
              </button>
            )}
          </div>
          <p className="mt-2 text-xs leading-5 text-stone-500">
            Potvrzení a zápis revize přinese až P50. Tento panel teď umí jen
            zamítnout; obsah poznámky zůstává beze změny.
          </p>
        </>
      ) : null}
    </section>
  );
}
