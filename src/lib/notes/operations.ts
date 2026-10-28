import { createHash } from "node:crypto";

import type { ListItem, Root } from "mdast";
import { visit } from "unist-util-visit";

import {
  llmOperationSchema,
  type LlmOperation,
} from "../ai/schemas.ts";
import { countGraphemes } from "./limits.ts";
import { parseNoteMarkdown, renderMarkdownBlock } from "./markdown.ts";
import {
  collectProseBlocks,
  matchesPhrases,
  normalizeMatchText,
  sentenceCandidates,
  type ProseBlock,
  type ProseCollection,
  type SentenceSpan,
} from "./sentences.ts";

export const OPERATION_TEXT_MAX_GRAPHEMES = 2_000;
export const OPERATION_HEADING_MAX_GRAPHEMES = 160;
export const OPERATION_TASK_MAX_GRAPHEMES = 200;

export interface ResolveOperationInput {
  readonly contentMd: string;
  readonly operation: LlmOperation;
  readonly noteVersion?: number;
  readonly deletedAt?: Date | string | null;
  readonly expectedVersion?: number;
  readonly expectedSourceHash?: string;
  readonly candidateId?: string;
}

export interface OperationCandidate {
  readonly id: string;
  readonly ordinal: number;
  readonly text: string;
  readonly snippet: string;
  readonly blockIndex: number;
  readonly sentenceIndex?: number;
  readonly checked?: boolean;
}

export interface OperationDiff {
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
  readonly removed: string;
  readonly inserted: string;
  readonly suffix: string;
}

export interface OperationResolutionBase {
  readonly sourceHash: string;
  readonly noteVersion: number | null;
  readonly message: string;
}

export interface ResolvedOperation extends OperationResolutionBase {
  readonly status: "resolved";
  readonly code: "ok";
  readonly operation: LlmOperation;
  readonly candidate: OperationCandidate | null;
  readonly beforeMd: string;
  readonly afterMd: string;
  readonly diff: OperationDiff;
  readonly changed: boolean;
}

export interface AmbiguousOperation extends OperationResolutionBase {
  readonly status: "ambiguous";
  readonly code: "operation_ambiguous";
  readonly candidates: readonly OperationCandidate[];
}

export interface NoMatchOperation extends OperationResolutionBase {
  readonly status: "no_match";
  readonly code: "operation_no_match";
}

export interface StaleOperation extends OperationResolutionBase {
  readonly status: "stale";
  readonly code: "version_mismatch" | "source_mismatch";
  readonly expectedVersion: number | null;
  readonly actualVersion: number | null;
  readonly expectedSourceHash: string | null;
  readonly actualSourceHash: string;
}

export interface InvalidOperation extends OperationResolutionBase {
  readonly status: "invalid";
  readonly code:
    | "note_deleted"
    | "operation_invalid"
    | "unsupported_inline_markup"
    | "unsupported_task"
    | "text_too_large"
    | "heading_invalid"
    | "paragraph_too_large"
    | "invalid_target"
    | "candidate_binding_required";
  readonly details?: Readonly<Record<string, unknown>>;
}

export type OperationResolution =
  | ResolvedOperation
  | AmbiguousOperation
  | NoMatchOperation
  | StaleOperation
  | InvalidOperation;

export function hashNoteSource(contentMd: string): string {
  return createHash("sha256").update(contentMd, "utf8").digest("hex");
}

function base(
  input: ResolveOperationInput,
  message: string,
): OperationResolutionBase {
  return {
    sourceHash: hashNoteSource(input.contentMd),
    noteVersion: input.noteVersion ?? null,
    message,
  };
}

function invalid(
  input: ResolveOperationInput,
  code: InvalidOperation["code"],
  message: string,
  details?: Readonly<Record<string, unknown>>,
): InvalidOperation {
  return {
    ...base(input, message),
    status: "invalid",
    code,
    ...(details === undefined ? {} : { details }),
  };
}

function noMatch(
  input: ResolveOperationInput,
  message = "V poznámce se nepodařilo najít jednoznačný cíl operace.",
): NoMatchOperation {
  return {
    ...base(input, message),
    status: "no_match",
    code: "operation_no_match",
  };
}

function ambiguous(
  input: ResolveOperationInput,
  candidates: readonly OperationCandidate[],
): AmbiguousOperation {
  return {
    ...base(
      input,
      `Cíl operace odpovídá ${candidates.length} místům. Vyberte konkrétní kandidát.`,
    ),
    status: "ambiguous",
    code: "operation_ambiguous",
    candidates,
  };
}

function stale(
  input: ResolveOperationInput,
  code: StaleOperation["code"],
  message: string,
  expectedVersion: number | null,
  expectedSourceHash: string | null,
  actualSourceHash: string,
): StaleOperation {
  return {
    ...base(input, message),
    status: "stale",
    code,
    expectedVersion,
    actualVersion: input.noteVersion ?? null,
    expectedSourceHash,
    actualSourceHash,
  };
}

function resolved(
  input: ResolveOperationInput,
  operation: LlmOperation,
  start: number,
  end: number,
  inserted: string,
  candidate: OperationCandidate | null = null,
): ResolvedOperation {
  const prefix = input.contentMd.slice(0, start);
  const removed = input.contentMd.slice(start, end);
  const suffix = input.contentMd.slice(end);

  return {
    ...base(input, "Operace je připravená k náhledu."),
    status: "resolved",
    code: "ok",
    operation,
    candidate,
    beforeMd: input.contentMd,
    afterMd: prefix + inserted + suffix,
    diff: { start, end, prefix, removed, inserted, suffix },
    changed: removed !== inserted,
  };
}

function snippet(text: string): string {
  const graphemes = Array.from(text);

  return graphemes.length <= 160
    ? text
    : `${graphemes.slice(0, 157).join("")}…`;
}

function sentenceCandidate(
  match: ReturnType<typeof sentenceCandidates>["matches"][number],
): OperationCandidate {
  return {
    id: match.id,
    ordinal: match.ordinal,
    text: match.sentence.text,
    snippet: snippet(match.sentence.text),
    blockIndex: match.block.blockIndex,
    sentenceIndex: match.sentence.sentenceIndex,
  };
}

function selectCandidate(
  candidates: readonly OperationCandidate[],
  candidateId: string | undefined,
):
  | { readonly kind: "selected"; readonly candidate: OperationCandidate }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "missing" } {
  if (candidates.length === 0) {
    return { kind: "missing" };
  }

  if (candidates.length === 1) {
    if (candidateId !== undefined && candidates[0]!.id !== candidateId) {
      return { kind: "missing" };
    }

    return { kind: "selected", candidate: candidates[0]! };
  }

  if (candidateId === undefined) {
    return { kind: "ambiguous" };
  }

  const selected = candidates.find((candidate) => candidate.id === candidateId);

  return selected === undefined
    ? { kind: "missing" }
    : { kind: "selected", candidate: selected };
}

function validateText(
  input: ResolveOperationInput,
  text: string,
  maxGraphemes: number,
  code: InvalidOperation["code"] = "text_too_large",
): InvalidOperation | null {
  if (text.trim() === "" || countGraphemes(text) > maxGraphemes) {
    return invalid(
      input,
      code,
      `Text operace musí být neprázdný a mít nejvýše ${maxGraphemes.toLocaleString("cs-CZ")} znaků.`,
    );
  }

  return null;
}

function targetIsEmpty(startPhrase: string, endPhrase: string): boolean {
  return (
    normalizeMatchText(startPhrase) === "" ||
    normalizeMatchText(endPhrase) === ""
  );
}

function sentenceResolution(
  input: ResolveOperationInput,
  operation: Extract<LlmOperation, { readonly target: { readonly startPhrase: string } }>,
  prose: ProseCollection,
  apply: (
    block: ProseBlock,
    sentence: SentenceSpan,
    candidate: OperationCandidate,
  ) => ResolvedOperation,
): OperationResolution {
  if (
    targetIsEmpty(
      operation.target.startPhrase,
      operation.target.endPhrase,
    )
  ) {
    return invalid(
      input,
      "invalid_target",
      "Cílový text neobsahuje žádné rozpoznatelné znaky.",
    );
  }

  const result = sentenceCandidates(
    prose,
    operation.target.startPhrase,
    operation.target.endPhrase,
  );
  const candidates = result.matches.map(sentenceCandidate);
  const selection = selectCandidate(candidates, input.candidateId);

  if (
    result.unsupported.length > 0 &&
    input.candidateId === undefined
  ) {
    return invalid(
      input,
      "unsupported_inline_markup",
      "Stejný cíl se vyskytuje i v odstavci s nepodporovaným inline Markdownem. Zpřesněte cíl nebo jej upravte ve zdrojovém režimu.",
    );
  }

  if (selection.kind === "missing") {
    return result.unsupported.length > 0
      ? invalid(
          input,
          "unsupported_inline_markup",
          "Cíl leží v odstavci s nepodporovaným inline Markdownem. Upravte jej ve zdrojovém režimu.",
        )
      : noMatch(input);
  }

  if (selection.kind === "ambiguous") {
    return ambiguous(input, candidates);
  }

  const match = result.matches.find(
    (candidate) => candidate.id === selection.candidate.id,
  )!;

  return apply(match.block, match.sentence, selection.candidate);
}

function replaceSentence(
  input: ResolveOperationInput,
  operation: Extract<LlmOperation, { readonly type: "replace_sentence" }>,
  prose: ProseCollection,
): OperationResolution {
  const textError = validateText(
    input,
    operation.text,
    OPERATION_TEXT_MAX_GRAPHEMES,
  );
  if (textError !== null) {
    return textError;
  }

  return sentenceResolution(input, operation, prose, (block, sentence, candidate) =>
    resolved(input, operation, sentence.start, sentence.end, operation.text, candidate),
  );
}

function insertBeforeSentence(
  input: ResolveOperationInput,
  operation: Extract<LlmOperation, { readonly type: "insert_before_sentence" }>,
  prose: ProseCollection,
): OperationResolution {
  const textError = validateText(
    input,
    operation.text,
    OPERATION_TEXT_MAX_GRAPHEMES,
  );
  if (textError !== null) {
    return textError;
  }

  return sentenceResolution(input, operation, prose, (block, sentence, candidate) =>
    resolved(
      input,
      operation,
      sentence.start,
      sentence.start,
      `${operation.text} `,
      candidate,
    ),
  );
}

function insertAfterSentence(
  input: ResolveOperationInput,
  operation: Extract<LlmOperation, { readonly type: "insert_after_sentence" }>,
  prose: ProseCollection,
): OperationResolution {
  const textError = validateText(
    input,
    operation.text,
    OPERATION_TEXT_MAX_GRAPHEMES,
  );
  if (textError !== null) {
    return textError;
  }

  return sentenceResolution(input, operation, prose, (block, sentence, candidate) => {
    const next = input.contentMd.slice(sentence.end);
    const trailingSpace = next === "" || /^\s/u.test(next) ? "" : " ";

    return resolved(
      input,
      operation,
      sentence.end,
      sentence.end,
      ` ${operation.text}${trailingSpace}`,
      candidate,
    );
  });
}

function deleteSentence(
  input: ResolveOperationInput,
  operation: Extract<LlmOperation, { readonly type: "delete_sentence" }>,
  prose: ProseCollection,
): OperationResolution {
  return sentenceResolution(input, operation, prose, (block, sentence, candidate) => {
    let start = sentence.start;
    let end = sentence.end;

    const hasFollowingSpace =
      end < input.contentMd.length &&
      /\s/u.test(input.contentMd.charAt(end));
    const hasPrecedingSpace =
      start > 0 && /\s/u.test(input.contentMd.charAt(start - 1));

    if (hasFollowingSpace && hasPrecedingSpace) {
      start -= 1;
    } else if (hasFollowingSpace) {
      end += 1;
    } else if (hasPrecedingSpace) {
      start -= 1;
    }

    return resolved(input, operation, start, end, "", candidate);
  });
}

function replaceLastSentence(
  input: ResolveOperationInput,
  operation: Extract<LlmOperation, { readonly type: "replace_last_sentence" }>,
  prose: ProseCollection,
): OperationResolution {
  const textError = validateText(
    input,
    operation.text,
    OPERATION_TEXT_MAX_GRAPHEMES,
  );
  if (textError !== null) {
    return textError;
  }

  const lastPlain = prose.plain.at(-1);
  const lastUnsupported = prose.unsupported.at(-1);

  if (
    lastPlain === undefined ||
    (lastUnsupported !== undefined &&
      lastUnsupported.blockIndex > lastPlain.blockIndex)
  ) {
    return lastUnsupported === undefined
      ? noMatch(input, "V poznámce není žádná bezpečná věta k nahrazení.")
      : invalid(
          input,
          "unsupported_inline_markup",
          "Poslední odstavec obsahuje nepodporovaný inline Markdown.",
        );
  }

  const sentence = lastPlain.sentences.at(-1);

  if (sentence === undefined) {
    return noMatch(input, "Poslední odstavec neobsahuje žádnou větu.");
  }

  const candidate: OperationCandidate = {
    id: `p${lastPlain.blockIndex}:s${sentence.sentenceIndex}`,
    ordinal: 1,
    text: sentence.text,
    snippet: snippet(sentence.text),
    blockIndex: lastPlain.blockIndex,
    sentenceIndex: sentence.sentenceIndex,
  };

  return resolved(
    input,
    operation,
    sentence.start,
    sentence.end,
    operation.text,
    candidate,
  );
}

function insertHeading(
  input: ResolveOperationInput,
  operation: Extract<
    LlmOperation,
    { readonly type: "insert_heading_before_sentence" }
  >,
  prose: ProseCollection,
): OperationResolution {
  if (
    operation.depth < 1 ||
    operation.depth > 3 ||
    operation.text.trim() === "" ||
    /[\r\n]/u.test(operation.text) ||
    countGraphemes(operation.text) > OPERATION_HEADING_MAX_GRAPHEMES
  ) {
    return invalid(
      input,
      "heading_invalid",
      `Nadpis musí mít úroveň 1 až 3 a nejvýše ${OPERATION_HEADING_MAX_GRAPHEMES} znaků bez zalomení řádku.`,
    );
  }

  return sentenceResolution(input, operation, prose, (block, sentence, candidate) => {
    const lineStart =
      sentence.start === 0 ||
      input.contentMd.charAt(sentence.start - 1) === "\n";
    const heading = `${"#".repeat(operation.depth)} ${operation.text.trim()}`;
    const inserted = lineStart ? `${heading}\n\n` : `\n\n${heading}\n\n`;

    return resolved(input, operation, sentence.start, sentence.start, inserted, candidate);
  });
}

function replaceParagraph(
  input: ResolveOperationInput,
  operation: Extract<LlmOperation, { readonly type: "replace_paragraph" }>,
  prose: ProseCollection,
): OperationResolution {
  const textError = validateText(
    input,
    operation.text,
    OPERATION_TEXT_MAX_GRAPHEMES,
  );
  if (textError !== null) {
    return textError;
  }

  if (
    targetIsEmpty(
      operation.target.startPhrase,
      operation.target.endPhrase,
    )
  ) {
    return invalid(
      input,
      "invalid_target",
      "Cílový text neobsahuje žádné rozpoznatelné znaky.",
    );
  }

  const candidates = prose.plain
    .filter((block) =>
      matchesPhrases(block.text, operation.target.startPhrase, operation.target.endPhrase),
    )
    .map<OperationCandidate>((block, index) => ({
      id: `p${block.blockIndex}`,
      ordinal: index + 1,
      text: block.text,
      snippet: snippet(block.text),
      blockIndex: block.blockIndex,
    }));
  const selection = selectCandidate(candidates, input.candidateId);
  const unsafe = prose.unsupported.some((block) =>
    matchesPhrases(block.text, operation.target.startPhrase, operation.target.endPhrase),
  );

  if (unsafe && input.candidateId === undefined) {
    return invalid(
      input,
      "unsupported_inline_markup",
      "Stejný cíl se vyskytuje i v odstavci s nepodporovaným inline Markdownem. Zpřesněte cíl nebo jej upravte ve zdrojovém režimu.",
    );
  }

  if (selection.kind === "missing") {
    return unsafe
      ? invalid(
          input,
          "unsupported_inline_markup",
          "Cílový odstavec obsahuje nepodporovaný inline Markdown.",
        )
      : noMatch(input);
  }

  if (selection.kind === "ambiguous") {
    return ambiguous(input, candidates);
  }

  const block = prose.plain.find(
    (candidate) => `p${candidate.blockIndex}` === selection.candidate.id,
  )!;

  if (countGraphemes(block.text) > OPERATION_TEXT_MAX_GRAPHEMES) {
    return invalid(
      input,
      "paragraph_too_large",
      `Cílový odstavec překračuje limit ${OPERATION_TEXT_MAX_GRAPHEMES.toLocaleString("cs-CZ")} znaků.`,
    );
  }

  return resolved(
    input,
    operation,
    block.start,
    block.end,
    operation.text,
    selection.candidate,
  );
}

function appendSection(
  input: ResolveOperationInput,
  operation: Extract<LlmOperation, { readonly type: "append_bounded_section" }>,
): OperationResolution {
  const textError = validateText(
    input,
    operation.text,
    OPERATION_TEXT_MAX_GRAPHEMES,
  );
  if (textError !== null) {
    return textError;
  }

  const source = input.contentMd;
  const separator =
    source === ""
      ? ""
      : source.endsWith("\n\n")
        ? ""
        : source.endsWith("\n")
          ? "\n"
          : "\n\n";

  return resolved(
    input,
    operation,
    source.length,
    source.length,
    `${separator}${operation.text}`,
  );
}

interface TaskCandidate extends OperationCandidate {
  readonly checked: boolean;
  readonly checkboxIndex: number;
}

function collectTasks(ast: Root, source: string): TaskCandidate[] {
  const tasks: TaskCandidate[] = [];
  let ordinal = 1;

  visit(ast, "listItem", (node: ListItem) => {
    if (typeof node.checked !== "boolean") {
      return;
    }

    const start = node.position?.start.offset;

    if (start === undefined) {
      return;
    }

    const paragraphs = node.children.filter(
      (child) => child.type === "paragraph",
    );
    const text = paragraphs
      .map((child) => renderMarkdownBlock(child))
      .join("\n")
      .trim();

    if (text === "" || countGraphemes(text) > OPERATION_TASK_MAX_GRAPHEMES) {
      return;
    }

    const lineEnd = source.indexOf("\n", start);
    const line = source.slice(start, lineEnd === -1 ? source.length : lineEnd);
    const checkbox = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/u.exec(line);

    if (checkbox === null) {
      return;
    }

    tasks.push({
      id: `t${ordinal - 1}`,
      ordinal,
      text,
      snippet: snippet(text),
      blockIndex: -1,
      checked: node.checked,
      checkboxIndex: start + checkbox[0].length - 2,
    });
    ordinal += 1;
  });

  return tasks;
}

export interface ExistingTaskLabel {
  readonly text: string;
  readonly normalized: string;
  readonly checked: boolean;
}

export function listExistingTaskLabels(
  contentMd: string,
): ExistingTaskLabel[] {
  const parsed = parseNoteMarkdown(contentMd);

  return collectTasks(parsed.ast, contentMd).map((task) => ({
    text: task.text,
    normalized: normalizeMatchText(task.text),
    checked: task.checked,
  }));
}

function setTaskChecked(
  input: ResolveOperationInput,
  operation: Extract<LlmOperation, { readonly type: "set_task_checked" }>,
  ast: Root,
): OperationResolution {
  if (
    operation.taskText.trim() === "" ||
    countGraphemes(operation.taskText) > OPERATION_TASK_MAX_GRAPHEMES
  ) {
    return invalid(
      input,
      "invalid_target",
      `Text úkolu musí být neprázdný a mít nejvýše ${OPERATION_TASK_MAX_GRAPHEMES.toLocaleString("cs-CZ")} znaků.`,
    );
  }

  const target = normalizeMatchText(operation.taskText);

  if (target === "") {
    return invalid(
      input,
      "invalid_target",
      "Text úkolu neobsahuje žádné rozpoznatelné znaky.",
    );
  }

  const matching = collectTasks(ast, input.contentMd).filter(
    (task) => normalizeMatchText(task.text) === target,
  );

  if (matching.length === 0) {
    return noMatch(input, "Úkol se nepodařilo jednoznačně najít.");
  }

  const candidates = matching.filter(
    (task) => task.checked !== operation.checked,
  );

  if (candidates.length === 0) {
    return noMatch(
      input,
      operation.checked
        ? "Úkol už je označený jako hotový."
        : "Úkol už není označený jako hotový.",
    );
  }
  const publicCandidates: OperationCandidate[] = candidates.map(
    (task, index) => ({
      id: task.id,
      ordinal: index + 1,
      text: task.text,
      snippet: task.snippet,
      blockIndex: task.blockIndex,
      checked: task.checked,
    }),
  );
  const selection = selectCandidate(publicCandidates, input.candidateId);

  if (selection.kind === "missing") {
    return noMatch(input, "Úkol se nepodařilo jednoznačně najít.");
  }

  if (selection.kind === "ambiguous") {
    return ambiguous(input, publicCandidates);
  }

  const task = candidates.find(
    (candidate) => candidate.id === selection.candidate.id,
  )!;

  return resolved(
    input,
    operation,
    task.checkboxIndex,
    task.checkboxIndex + 1,
    operation.checked ? "x" : " ",
    selection.candidate,
  );
}

export function resolveOperation(
  input: ResolveOperationInput,
): OperationResolution {
  if (input.deletedAt !== undefined && input.deletedAt !== null) {
    return invalid(
      input,
      "note_deleted",
      "Smazanou poznámku nelze upravovat.",
    );
  }

  const sourceHash = hashNoteSource(input.contentMd);

  if (
    input.candidateId !== undefined &&
    (input.expectedVersion === undefined ||
      input.expectedSourceHash === undefined)
  ) {
    return invalid(
      input,
      "candidate_binding_required",
      "Výběr kandidáta musí být svázán s verzí poznámky a zdrojovým hashem. Vytvořte nový návrh.",
    );
  }

  if (
    input.expectedVersion !== undefined &&
    input.noteVersion !== input.expectedVersion
  ) {
    return stale(
      input,
      "version_mismatch",
      "Poznámka byla mezitím změněna. Vytvořte nový návrh.",
      input.expectedVersion,
      input.expectedSourceHash ?? null,
      sourceHash,
    );
  }

  if (
    input.expectedSourceHash !== undefined &&
    input.expectedSourceHash !== sourceHash
  ) {
    return stale(
      input,
      "source_mismatch",
      "Zdrojový hash poznámky už neodpovídá. Vytvořte nový návrh.",
      input.expectedVersion ?? null,
      input.expectedSourceHash,
      sourceHash,
    );
  }

  const parsedOperation = llmOperationSchema.safeParse(input.operation);

  if (!parsedOperation.success) {
    return invalid(
      input,
      "operation_invalid",
      "Operace nemá povolený tvar.",
      {
        issues: parsedOperation.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          code: issue.code,
        })),
      },
    );
  }

  const operation = parsedOperation.data;
  const parsed = parseNoteMarkdown(input.contentMd);
  const prose = collectProseBlocks(input.contentMd, parsed.ast);

  switch (operation.type) {
    case "replace_sentence":
      return replaceSentence(input, operation, prose);
    case "insert_before_sentence":
      return insertBeforeSentence(input, operation, prose);
    case "insert_after_sentence":
      return insertAfterSentence(input, operation, prose);
    case "delete_sentence":
      return deleteSentence(input, operation, prose);
    case "insert_heading_before_sentence":
      return insertHeading(input, operation, prose);
    case "replace_last_sentence":
      return replaceLastSentence(input, operation, prose);
    case "replace_paragraph":
      return replaceParagraph(input, operation, prose);
    case "append_bounded_section":
      return appendSection(input, operation);
    case "set_task_checked":
      return setTaskChecked(input, operation, parsed.ast);
    default:
      return invalid(input, "operation_invalid", "Nepodporovaný typ operace.");
  }
}
