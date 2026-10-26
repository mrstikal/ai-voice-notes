export interface CommittedTranscriptEvent {
  readonly text: string;
  readonly providerId?: string | null;
}

export interface AcceptedTranscriptSegment {
  readonly sequence: number;
  readonly text: string;
  readonly providerId: string | null;
}

export class TranscriptSession {
  private readonly seenProviderIds = new Set<string>();
  private sequence = 0;
  private closed = false;

  accept(
    event: CommittedTranscriptEvent,
  ): AcceptedTranscriptSegment | null {
    if (this.closed || event.text.trim() === "") {
      return null;
    }

    const providerId = event.providerId?.trim() ?? "";

    if (providerId !== "") {
      if (this.seenProviderIds.has(providerId)) {
        return null;
      }

      this.seenProviderIds.add(providerId);
    }

    this.sequence += 1;

    return {
      sequence: this.sequence,
      text: event.text,
      providerId: providerId === "" ? null : providerId,
    };
  }

  close(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export interface InsertResult {
  readonly content: string;
  readonly cursor: number;
}

export function insertCommittedTextAtCursor(
  content: string,
  text: string,
  cursor: number,
): InsertResult {
  const safeCursor = Math.max(0, Math.min(cursor, content.length));

  if (text === "") {
    return { content, cursor: safeCursor };
  }

  const before = content.slice(0, safeCursor);
  const after = content.slice(safeCursor);
  const leading =
    before.length > 0 && !/\s$/u.test(before) && !/^\s/u.test(text)
      ? " "
      : "";
  const trailing =
    after.length > 0 && !/^\s/u.test(after) && !/\s$/u.test(text) ? " " : "";
  const inserted = `${leading}${text}${trailing}`;

  return {
    content: `${before}${inserted}${after}`,
    cursor: safeCursor + inserted.length,
  };
}

export function appendCommittedText(content: string, text: string): string {
  if (text === "") {
    return content;
  }

  const separator =
    content.length > 0 && !/\s$/u.test(content) && !/^\s/u.test(text)
      ? " "
      : "";

  return `${content}${separator}${text}`;
}
