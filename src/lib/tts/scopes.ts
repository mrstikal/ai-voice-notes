export const TTS_SCOPES = ["full", "range", "paragraph", "tasks"] as const;

export type TtsScope = (typeof TTS_SCOPES)[number];

export const TTS_SCOPE_LABELS: Record<TtsScope, string> = {
  full: "Celá poznámka",
  range: "Vybraný text",
  paragraph: "Jeden odstavec",
  tasks: "Úkoly",
};
