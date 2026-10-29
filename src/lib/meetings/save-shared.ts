export const MEETING_SAVE_MAX_BYTES = 3 * 1024 * 1024;
export const MEETING_SAVE_MAX_PARTS = 3;
export const MEETING_SAVE_DEFAULT_TITLE = "Zápis ze schůzky";
export const MEETING_SAVE_TITLE_MAX_GRAPHEMES = 100;
export const MEETING_SAVE_LABEL_MAX_GRAPHEMES = 160;

export function meetingSavePayloadBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
