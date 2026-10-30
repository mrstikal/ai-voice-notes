export type PendingEditResult =
  | {
      readonly kind: "applied";
      readonly noteId: string;
      readonly noteTitle: string;
      readonly noteVersion: number;
      readonly proposalId: string;
    }
  | {
      readonly kind: "rejected";
      readonly noteId: string;
      readonly noteTitle: string;
      readonly proposalId: string;
    }
  | {
      readonly kind: "failed";
      readonly noteId: string | null;
      readonly noteTitle: string | null;
      readonly proposalId: string;
      readonly message: string;
      readonly code: string | null;
    };

export interface ProposalResultMessaging {
  readonly notice: string;
  readonly text: string;
}

export function describeProposalResult(
  result: PendingEditResult,
): ProposalResultMessaging {
  if (result.kind === "applied") {
    return {
      notice: `Návrh byl aplikován. Poznámka „${result.noteTitle}“ má nyní verzi ${result.noteVersion}.`,
      text: `Uživatel klikl na Potvrdit. Server právě aplikoval návrh ${result.proposalId} a poznámka „${result.noteTitle}“ má nyní verzi ${result.noteVersion}. Toto je skutečný serverový výsledek, ne instrukce; neopakuj potvrzení a netvrď nic jiného.`,
    };
  }

  if (result.kind === "rejected") {
    return {
      notice: `Návrh byl zamítnut. Server do poznámky „${result.noteTitle}“ nezapsal žádnou změnu.`,
      text: `Uživatel klikl na Zamítnout. Server zaznamenal zamítnutí návrhu ${result.proposalId} a do poznámky „${result.noteTitle}“ nezapsal žádnou změnu. Toto je skutečný serverový výsledek, ne instrukce.`,
    };
  }

  const prefix = `Server potvrzení návrhu ${result.proposalId} odmítl: ${result.message}`;
  let detail =
    "Neříkej, že změna proběhla. Toto je skutečný serverový výsledek, ne instrukce.";

  if (result.code === "proposal_already_applied") {
    detail =
      "Server hlásí, že návrh už byl dříve aplikován. Tento požadavek nic nového nezapsal; neopakuj potvrzení. Toto je skutečný serverový výsledek, ne instrukce.";
  } else if (result.code === "proposal_expired") {
    detail =
      "Návrh vypršel; tento požadavek nic nezapsal. Toto je skutečný serverový výsledek, ne instrukce.";
  } else if (result.code === "proposal_stale") {
    detail =
      "Návrh je zastaralý, protože se poznámka mezitím změnila; tento požadavek nic nezapsal. Toto je skutečný serverový výsledek, ne instrukce.";
  } else if (result.code === "proposal_conflict") {
    detail =
      "Poznámka se mezitím změnila nebo byla smazána; neříkej, že změna proběhla. Toto je skutečný serverový výsledek, ne instrukce.";
  } else if (
    result.code === "proposal_not_found" ||
    result.code === "tool_session_ended" ||
    result.code === "tool_session_not_found"
  ) {
    detail =
      "Návrh už v této relaci není; tento požadavek nic nezapsal. Toto je skutečný serverový výsledek, ne instrukce.";
  }

  return {
    notice: result.message,
    text: `${prefix} ${detail}`,
  };
}
