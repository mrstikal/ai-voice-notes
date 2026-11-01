import { publicEnvInt } from "../env-limits.ts";

export const TASK_SUGGESTION_MAX_TASKS = publicEnvInt(
  process.env.NEXT_PUBLIC_TASK_SUGGESTION_MAX_TASKS,
  "NEXT_PUBLIC_TASK_SUGGESTION_MAX_TASKS",
  10,
);
export const TASK_SUGGESTION_MAX_TEXT_GRAPHEMES = publicEnvInt(
  process.env.NEXT_PUBLIC_TASK_SUGGESTION_MAX_TEXT_GRAPHEMES,
  "NEXT_PUBLIC_TASK_SUGGESTION_MAX_TEXT_GRAPHEMES",
  160,
);
export const TASK_SUGGESTION_MAX_SOURCE_GRAPHEMES = publicEnvInt(
  process.env.NEXT_PUBLIC_TASK_SUGGESTION_MAX_SOURCE_GRAPHEMES,
  "NEXT_PUBLIC_TASK_SUGGESTION_MAX_SOURCE_GRAPHEMES",
  4_000,
);
export const TASK_SUGGESTION_TTL_MS = publicEnvInt(
  process.env.NEXT_PUBLIC_TASK_SUGGESTION_TTL_MS,
  "NEXT_PUBLIC_TASK_SUGGESTION_TTL_MS",
  5 * 60 * 1_000,
);

export interface SuggestedTask {
  readonly text: string;
  readonly normalized: string;
  readonly duplicate: boolean;
}

export interface TaskSuggestion {
  readonly noteId: string;
  readonly noteVersion: number;
  readonly tasks: readonly SuggestedTask[];
  readonly rejectedCount: number;
  readonly sourceGraphemes: number;
  readonly expiresAt: string;
}
