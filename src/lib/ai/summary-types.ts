export const SUMMARY_MAX_SOURCE_GRAPHEMES = 8_000;
export const SUMMARY_MAX_GRAPHEMES = 2_000;
export const SUMMARY_MAX_TTS_CODE_UNITS = 3_500;

export interface SummaryArtifact {
  readonly noteId: string;
  readonly noteVersion: number;
  readonly summaryText: string;
  readonly sourceGraphemes: number;
}
