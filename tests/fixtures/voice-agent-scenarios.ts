import type { ProposalMetricOutcome, VoiceMode } from "../../src/lib/voice-agent/metrics";

export interface VoiceScenario {
  readonly id: string;
  readonly mode: VoiceMode;
  readonly utterance: string;
  readonly expectedAction:
    | "select_note"
    | "summarize_note"
    | "read_last_paragraph"
    | "propose_todo"
    | "reject_todo"
    | "approve_todo_and_undo"
    | "interrupt_output"
    | "stop";
  readonly expectedNoteTitle: string | null;
  readonly proposalOutcome?: ProposalMetricOutcome;
  readonly bargeIn?: boolean;
}

export const MIGRATION_NOTE_TITLES = [
  "Migrace databáze",
  "Migrace API",
] as const;

export const VOICE_SCENARIOS: readonly VoiceScenario[] = [
  {
    expectedAction: "select_note",
    expectedNoteTitle: "Migrace API",
    id: "select-one-of-two-migration-notes",
    mode: "gemini",
    utterance: "Vyber druhou poznámku o migraci API.",
  },
  {
    expectedAction: "summarize_note",
    expectedNoteTitle: "Migrace API",
    id: "summarize-selected-note",
    mode: "gemini",
    utterance: "Shrň vybranou poznámku.",
  },
  {
    expectedAction: "read_last_paragraph",
    expectedNoteTitle: "Migrace API",
    id: "read-last-paragraph",
    mode: "gemini",
    utterance: "Přečti poslední odstavec.",
  },
  {
    expectedAction: "propose_todo",
    expectedNoteTitle: "Migrace API",
    id: "propose-todo",
    mode: "chained",
    proposalOutcome: "pending",
    utterance: "Přidej úkol ověřit migraci API.",
  },
  {
    expectedAction: "reject_todo",
    expectedNoteTitle: "Migrace API",
    id: "reject-todo",
    mode: "chained",
    proposalOutcome: "rejected",
    utterance: "Zamítni návrh úkolu.",
  },
  {
    expectedAction: "approve_todo_and_undo",
    expectedNoteTitle: "Migrace API",
    id: "approve-todo-and-undo",
    mode: "chained",
    proposalOutcome: "applied",
    utterance: "Potvrď úkol a potom změnu vrať.",
  },
  {
    bargeIn: true,
    expectedAction: "interrupt_output",
    expectedNoteTitle: null,
    id: "interrupt-output",
    mode: "gemini",
    utterance: "Počkej, přerušuji tě.",
  },
  {
    expectedAction: "stop",
    expectedNoteTitle: null,
    id: "stop-session",
    mode: "gemini",
    utterance: "Ukonči relaci.",
  },
];
