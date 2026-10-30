import type { LlmOperation } from "../ai/schemas";
import type { NoteDetail } from "./client";
import type { OperationCandidate } from "./operations";

export type EditProposalStatus =
  | "pending"
  | "rejected"
  | "applied"
  | "expired";

export interface EditProposalDiff {
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
  readonly removed: string;
  readonly inserted: string;
  readonly suffix: string;
}

const operationLabels: Record<LlmOperation["type"], string> = {
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

export function proposalOperationLabel(type: LlmOperation["type"]): string {
  return operationLabels[type];
}

export function proposalTargetLabel(proposal: {
  readonly operation: LlmOperation;
  readonly selectedCandidate: OperationCandidate | null;
}): string {
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

export interface EditProposal {
  readonly id: string;
  readonly noteId: string;
  readonly noteTitle: string;
  readonly expectedVersion: number;
  readonly originalHash: string;
  readonly operation: LlmOperation;
  readonly beforeMd: string;
  readonly afterMd: string;
  readonly selectedCandidate: OperationCandidate | null;
  readonly status: EditProposalStatus;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly diff: EditProposalDiff;
}

export interface CreatedEditProposal extends EditProposal {
  readonly confirmationNonce: string;
}

export interface ConfirmEditProposalRequest {
  readonly confirmationNonce: string;
  readonly expectedVersion: number;
}

export interface ConfirmedEditProposal {
  readonly proposal: EditProposal;
  readonly note: NoteDetail;
}

export interface CreateEditProposalRequest {
  readonly operation: LlmOperation;
  readonly candidateId?: string;
  readonly expectedVersion?: number;
  readonly expectedSourceHash?: string;
}

export class ProposalApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly candidates: readonly OperationCandidate[];
  readonly noteVersion: number | null;
  readonly sourceHash: string | null;

  constructor(
    status: number,
    code: string,
    message: string,
    details: {
      readonly candidates?: readonly OperationCandidate[];
      readonly noteVersion?: number;
      readonly sourceHash?: string;
    } = {},
  ) {
    super(message);
    this.name = "ProposalApiError";
    this.status = status;
    this.code = code;
    this.candidates = details.candidates ?? [];
    this.noteVersion = details.noteVersion ?? null;
    this.sourceHash = details.sourceHash ?? null;
  }
}

interface ApiErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly candidates?: readonly OperationCandidate[];
    readonly noteVersion?: number;
    readonly sourceHash?: string;
  };
}

async function readProposalError(
  response: Response,
): Promise<ProposalApiError> {
  let body: ApiErrorBody | null = null;

  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = null;
  }

  return new ProposalApiError(
    response.status,
    body?.error?.code ?? "request_failed",
    body?.error?.message ?? "Požadavek na návrh úpravy se nepodařilo dokončit.",
    {
      candidates: body?.error?.candidates,
      noteVersion: body?.error?.noteVersion,
      sourceHash: body?.error?.sourceHash,
    },
  );
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
    },
  });

  if (!response.ok) {
    throw await readProposalError(response);
  }

  return (await response.json()) as T;
}

export async function createEditProposal(
  noteId: string,
  input: CreateEditProposalRequest,
): Promise<CreatedEditProposal> {
  return requestJson<CreatedEditProposal>(
    `/api/notes/${noteId}/proposals`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function fetchEditProposal(
  noteId: string,
  proposalId: string,
): Promise<EditProposal> {
  return requestJson<EditProposal>(
    `/api/notes/${noteId}/proposals/${proposalId}`,
    { method: "GET" },
  );
}

export async function confirmEditProposal(
  noteId: string,
  proposalId: string,
  input: ConfirmEditProposalRequest,
): Promise<ConfirmedEditProposal> {
  return requestJson<ConfirmedEditProposal>(
    `/api/notes/${noteId}/proposals/${proposalId}/confirm`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function rejectEditProposal(
  noteId: string,
  proposalId: string,
): Promise<EditProposal> {
  return requestJson<EditProposal>(
    `/api/notes/${noteId}/proposals/${proposalId}/reject`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}
