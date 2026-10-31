"use client";

import type { Editor, JSONContent } from "@tiptap/core";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { ReplaceAroundStep } from "@tiptap/pm/transform";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  NoteApiError,
  fetchNote,
  formatCzechDateTime,
  saveVoiceContent,
  updateNote,
  type NoteDetail,
} from "@/lib/notes/client";
import {
  DRAFT_AUTOSAVE_DEBOUNCE_MS,
  DraftAutosaveController,
  clearStoredDrafts,
  readStoredDraft,
  syncStoredDraft,
  writeStoredDraft,
  type DraftAutosaveStatus,
  type DraftSaveOutcome,
  type StoredNoteDraft,
} from "@/lib/notes/draft";
import { CONTENT_MAX_GRAPHEMES } from "@/lib/notes/limits";
import {
  NOTE_EDITOR_EXTENSIONS,
  VisualConversionError,
  convertMarkdownToVisual,
  serializeVisualJson,
  type VisualConversionFailure,
} from "@/lib/notes/editor-markdown";
import { isSafeLinkDestination, parseNoteMarkdown } from "@/lib/notes/markdown";
import type { InlineMark } from "@/lib/voice/format-state";
import {
  applyVoicePartsToMarkdown,
  type VoiceFormattingBatch,
  type VoiceRenderedPart,
} from "@/lib/voice/transcript-session";

import {
  BodyDictationControls,
  type BodyInsertMode,
  type VoiceApplyResult,
} from "../voice/DictationControls";
import { MarkdownSource } from "./MarkdownSource";

type EditorMode = "source" | "visual";

interface NoteEditorProps {
  readonly note: NoteDetail;
  readonly onSaved?: (note: NoteDetail) => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
}

interface ConflictState {
  readonly latestVersion: number;
  readonly serverContentMd: string | null;
  readonly serverNote: NoteDetail | null;
  readonly serverLoadFailed: boolean;
}

function subscribeToNothing(): () => void {
  return () => undefined;
}

function getClientSnapshot(): boolean {
  return true;
}

function getServerSnapshot(): boolean {
  return false;
}

function formatCount(value: number): string {
  return value.toLocaleString("cs-CZ");
}

function voiceLimitMessage(actual: number): string {
  return `Diktovaný text by překročil limit ${formatCount(CONTENT_MAX_GRAPHEMES)} viditelných znaků (nově ${formatCount(actual)}). Dřívější obsah zůstal beze změny. Zkraťte text a spusťte diktování znovu.`;
}

function isBlockVoicePart(part: VoiceRenderedPart): boolean {
  return (
    part.kind === "heading" ||
    part.kind === "paragraph_break" ||
    part.kind === "list_item" ||
    part.kind === "list_end"
  );
}

function needsVisualParagraphAfter(
  parts: readonly VoiceRenderedPart[],
): boolean {
  const last = parts.at(-1);

  return (
    last?.kind === "paragraph_break" ||
    last?.kind === "heading" ||
    last?.kind === "list_end"
  );
}

function toTiptapMarks(marks: readonly InlineMark[]): { type: string }[] {
  return marks.map((mark) => ({
    type: mark === "strong" ? "bold" : "italic",
  }));
}

function insertVisualVoiceText(
  editor: Editor,
  text: string,
  marks: readonly InlineMark[],
): void {
  if (text === "") {
    return;
  }

  const { $from } = editor.state.selection;
  const before = $from.parent.textBetween(
    0,
    $from.parentOffset,
    undefined,
    "\0",
  );
  const separator =
    before.length > 0 && !/\s$/u.test(before) && !/^\s/u.test(text)
      ? " "
      : "";
  const tiptapMarks = toTiptapMarks(marks);

  editor
    .chain()
    .focus()
    .insertContent({
      type: "text",
      text: `${separator}${text}`,
      ...(tiptapMarks.length > 0 ? { marks: tiptapMarks } : {}),
    })
    .run();
}

function setVisualSelectionAtEnd(editor: Editor): void {
  const selection = TextSelection.near(
    editor.state.doc.resolve(editor.state.doc.content.size),
    -1,
  );
  editor.commands.setTextSelection(selection.from);
}

function insertVisualParagraphAtEnd(editor: Editor): void {
  const end = editor.state.doc.content.size;
  editor.chain().focus().insertContentAt(end, { type: "paragraph" }).run();
  setVisualSelectionAtEnd(editor);
}

function describeVisualFailure(failure: VisualConversionFailure): string {
  if (failure.reason === "lossy") {
    return "Vizuální režim není dostupný, protože převod Markdownu by změnil význam poznámky. Upravte ji ve zdrojovém režimu.";
  }

  const reasons = failure.parsed.sourceOnlyReasons.map((reason) => {
    switch (reason.type) {
      case "unsupported_heading_depth":
        return `nadpis H${reason.depth}`;
      case "unsafe_link":
        return "nebezpečný odkaz";
      case "unsupported_node":
        return `nepodporovaný prvek (${reason.nodeType})`;
    }
  });

  return `Vizuální režim není dostupný, protože poznámka obsahuje ${reasons.join(", ")}. Upravte ji ve zdrojovém režimu.`;
}

function isTaskCheckboxStep(transaction: Transaction): boolean {
  if (transaction.steps.length !== 1) {
    return false;
  }

  const step = transaction.steps[0];

  if (!(step instanceof ReplaceAroundStep)) {
    return false;
  }

  const inserted = step.slice.content;

  return (
    step.gapFrom === step.from + 1 &&
    step.gapTo === step.to - 1 &&
    step.insert === 1 &&
    step.slice.openStart === 0 &&
    step.slice.openEnd === 0 &&
    inserted.childCount === 1 &&
    inserted.firstChild?.type.name === "taskItem"
  );
}

interface ToolbarButtonProps {
  readonly label: string;
  readonly onClick: () => void;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
}

function ToolbarButton({
  label,
  onClick,
  pressed,
  disabled = false,
}: ToolbarButtonProps) {
  return (
    <button
      aria-pressed={pressed}
      className="rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-stone-800 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:border-emerald-700 aria-pressed:bg-emerald-50 aria-pressed:text-emerald-900"
      disabled={disabled}
      onClick={onClick}
      onMouseDown={(event) => event.preventDefault()}
      type="button"
    >
      {label}
    </button>
  );
}

interface VisualMarkdownEditorProps {
  readonly initialContent: JSONContent;
  readonly disabled: boolean;
  readonly onChange: (markdown: string) => void;
  readonly onError: (message: string) => void;
  readonly onPendingChange: () => void;
  readonly onEditorReady: (editor: Editor) => void;
  readonly onTaskToggle: (markdown: string) => void;
}

function VisualMarkdownEditor({
  initialContent,
  disabled,
  onChange,
  onError,
  onPendingChange,
  onEditorReady,
  onTaskToggle,
}: VisualMarkdownEditorProps) {
  const onChangeRef = useRef(onChange);
  const onErrorRef = useRef(onError);
  const onPendingChangeRef = useRef(onPendingChange);
  const onTaskToggleRef = useRef(onTaskToggle);
  const serializationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    onPendingChangeRef.current = onPendingChange;
  }, [onPendingChange]);

  useEffect(() => {
    onTaskToggleRef.current = onTaskToggle;
  }, [onTaskToggle]);

  const editor = useEditor({
    content: initialContent,
    editorProps: {
      attributes: {
        "aria-describedby": "note-grapheme-counter",
        "aria-label": "Vizuální editor poznámky",
        "aria-multiline": "true",
        class: "note-editor-surface",
        role: "textbox",
      },
    },
    extensions: NOTE_EDITOR_EXTENSIONS,
    immediatelyRender: false,
    onUpdate: ({ editor: currentEditor, transaction }) => {
      if (isTaskCheckboxStep(transaction)) {
        if (serializationTimeoutRef.current !== null) {
          clearTimeout(serializationTimeoutRef.current);
          serializationTimeoutRef.current = null;
        }

        try {
          onTaskToggleRef.current(serializeVisualJson(currentEditor.getJSON()));
        } catch (error) {
          onErrorRef.current(
            error instanceof Error
              ? error.message
              : "Změnu úkolu nelze převést do Markdownu.",
          );
        }

        return;
      }

      onPendingChangeRef.current();

      if (serializationTimeoutRef.current !== null) {
        clearTimeout(serializationTimeoutRef.current);
      }

      serializationTimeoutRef.current = setTimeout(() => {
        serializationTimeoutRef.current = null;

        try {
          onChangeRef.current(serializeVisualJson(currentEditor.getJSON()));
        } catch (error) {
          onErrorRef.current(
            error instanceof Error
              ? error.message
              : "Vizuální obsah nelze převést do Markdownu.",
          );
        }
      }, 250);
    },
  });

  useEffect(() => {
    return () => {
      if (serializationTimeoutRef.current === null) {
        return;
      }

      clearTimeout(serializationTimeoutRef.current);
      serializationTimeoutRef.current = null;

      if (!editor) {
        return;
      }

      try {
        onChangeRef.current(serializeVisualJson(editor.getJSON()));
      } catch {
        // The editor is being disposed; the parent already reports conversion
        // failures through its own mode switch or save path.
      }
    };
  }, [editor]);

  useEffect(() => {
    if (editor) {
      onEditorReady(editor);
    }
  }, [editor, onEditorReady]);

  useEffect(() => {
    editor?.setEditable(!disabled, false);
  }, [disabled, editor]);

  useEffect(() => {
    if (disabled && serializationTimeoutRef.current !== null) {
      clearTimeout(serializationTimeoutRef.current);
      serializationTimeoutRef.current = null;
    }
  }, [disabled]);

  const active = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) =>
      currentEditor
        ? {
            blockquote: currentEditor.isActive("blockquote"),
            bold: currentEditor.isActive("bold"),
            bulletList: currentEditor.isActive("bulletList"),
            canRedo: currentEditor.can().redo(),
            canUndo: currentEditor.can().undo(),
            code: currentEditor.isActive("code"),
            codeBlock: currentEditor.isActive("codeBlock"),
            h1: currentEditor.isActive("heading", { level: 1 }),
            h2: currentEditor.isActive("heading", { level: 2 }),
            h3: currentEditor.isActive("heading", { level: 3 }),
            italic: currentEditor.isActive("italic"),
            link: currentEditor.isActive("link"),
            orderedList: currentEditor.isActive("orderedList"),
            taskList: currentEditor.isActive("taskList"),
          }
        : null,
  });

  const isDisabled = !editor || disabled;

  function handleLink() {
    if (!editor) {
      return;
    }

    const previousHref = editor.getAttributes("link").href;
    const entered = window.prompt(
      "Adresa odkazu (http, https nebo mailto):",
      typeof previousHref === "string" && previousHref ? previousHref : "https://",
    );
    if (entered === null) {
      return;
    }

    const href = entered.trim();
    if (!isSafeLinkDestination(href)) {
      onError("Odkaz musí být bezpečná adresa http, https nebo mailto.");
      return;
    }

    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
  }

  return (
    <div className="note-editor">
      <div
        aria-label="Formátování"
        className="flex flex-wrap gap-1.5 rounded-t-xl border border-b-0 border-stone-300 bg-stone-50 p-2"
        role="toolbar"
      >
        <ToolbarButton
          disabled={isDisabled}
          label="Zpět"
          onClick={() => editor?.chain().focus().undo().run()}
        />
        <ToolbarButton
          disabled={isDisabled || !active?.canRedo}
          label="Vpřed"
          onClick={() => editor?.chain().focus().redo().run()}
        />
        <span aria-hidden="true" className="mx-1 w-px self-stretch bg-stone-300" />
        <ToolbarButton
          disabled={isDisabled}
          label="Tučně"
          onClick={() => editor?.chain().focus().toggleBold().run()}
          pressed={active?.bold}
        />
        <ToolbarButton
          disabled={isDisabled}
          label="Kurzíva"
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          pressed={active?.italic}
        />
        <ToolbarButton
          disabled={isDisabled}
          label="Kód"
          onClick={() => editor?.chain().focus().toggleCode().run()}
          pressed={active?.code}
        />
        <span aria-hidden="true" className="mx-1 w-px self-stretch bg-stone-300" />
        <ToolbarButton
          disabled={isDisabled}
          label="H1"
          onClick={() =>
            editor?.chain().focus().toggleHeading({ level: 1 }).run()
          }
          pressed={active?.h1}
        />
        <ToolbarButton
          disabled={isDisabled}
          label="H2"
          onClick={() =>
            editor?.chain().focus().toggleHeading({ level: 2 }).run()
          }
          pressed={active?.h2}
        />
        <ToolbarButton
          disabled={isDisabled}
          label="H3"
          onClick={() =>
            editor?.chain().focus().toggleHeading({ level: 3 }).run()
          }
          pressed={active?.h3}
        />
        <ToolbarButton
          disabled={isDisabled}
          label="Odstavec"
          onClick={() => editor?.chain().focus().setParagraph().run()}
        />
        <span aria-hidden="true" className="mx-1 w-px self-stretch bg-stone-300" />
        <ToolbarButton
          disabled={isDisabled}
          label="Odrážky"
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
          pressed={active?.bulletList}
        />
        <ToolbarButton
          disabled={isDisabled}
          label="Číslování"
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          pressed={active?.orderedList}
        />
        <ToolbarButton
          disabled={isDisabled}
          label="Úkoly"
          onClick={() => editor?.chain().focus().toggleTaskList().run()}
          pressed={active?.taskList}
        />
        <ToolbarButton
          disabled={isDisabled}
          label="Citace"
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          pressed={active?.blockquote}
        />
        <ToolbarButton
          disabled={isDisabled}
          label="Blok kódu"
          onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
          pressed={active?.codeBlock}
        />
        <ToolbarButton
          disabled={isDisabled}
          label="Pevný zlomek"
          onClick={() => editor?.chain().focus().setHardBreak().run()}
        />
        <span aria-hidden="true" className="mx-1 w-px self-stretch bg-stone-300" />
        <ToolbarButton
          disabled={isDisabled}
          label="Odkaz"
          onClick={handleLink}
          pressed={active?.link}
        />
        <ToolbarButton
          disabled={isDisabled || !active?.link}
          label="Odebrat odkaz"
          onClick={() => editor?.chain().focus().unsetLink().run()}
        />
      </div>
      <div className="note-editor-content rounded-b-xl border border-stone-300 bg-white">
        <EditorContent editor={editor} />
      </div>
      <p className="mt-2 text-xs text-stone-500">
        Shift+Enter vloží pevný zlomek. Změny se ukládají automaticky; tlačítko
        Uložit vytvoří v historii bod obnovy.
      </p>
    </div>
  );
}

export function NoteEditor({ note, onSaved, onDirtyChange }: NoteEditorProps) {
  const [mode, setMode] = useState<EditorMode>("source");
  const [source, setSource] = useState(note.contentMd);
  const [localSavedContent, setLocalSavedContent] = useState(note.contentMd);
  const [localVersion, setLocalVersion] = useState(note.version);
  const [visualContent, setVisualContent] = useState<JSONContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autosaveError, setAutosaveError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isExplicitSaving, setIsExplicitSaving] = useState(false);
  const [visualDirty, setVisualDirty] = useState(false);
  const [hasAutosavedContent, setHasAutosavedContent] = useState(false);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [recoveryDismissed, setRecoveryDismissed] = useState(false);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  const sourceTextRef = useRef(note.contentMd);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingSelectionRef = useRef<number | null>(null);
  const modeRef = useRef<EditorMode>("source");
  const savedContentRef = useRef(note.contentMd);
  const versionRef = useRef(note.version);
  const titleRef = useRef(note.title);
  const conflictRef = useRef<ConflictState | null>(null);
  const conflictRequestRef = useRef(0);
  const restoreBaseVersionRef = useRef<number | null>(null);
  const visualEditedRef = useRef(false);
  const visualEditorRef = useRef<Editor | null>(null);
  const visualVoiceEndModeRef = useRef(false);
  const visualPendingParagraphRef = useRef(false);
  const controllerRef = useRef<DraftAutosaveController | null>(null);
  const taskSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const taskSavePendingRef = useRef(0);
  const bodyVoiceBaselineRef = useRef<string | null>(null);
  const onSavedRef = useRef(onSaved);
  const onDirtyChangeRef = useRef(onDirtyChange);

  const isClientReady = useSyncExternalStore(
    subscribeToNothing,
    getClientSnapshot,
    getServerSnapshot,
  );

  const storedDraft = useMemo(() => {
    if (!isClientReady) {
      return null;
    }

    const stored = readStoredDraft(note.id);

    if (!stored || stored.contentMd === note.contentMd) {
      return null;
    }

    return stored;
  }, [isClientReady, note.contentMd, note.id]);

  const recovery: StoredNoteDraft | null = recoveryDismissed
    ? null
    : storedDraft;

  const deferredSource = useDeferredValue(source);
  const parsed = useMemo(
    () => parseNoteMarkdown(deferredSource),
    [deferredSource],
  );
  const overLimit = parsed.graphemeCount > CONTENT_MAX_GRAPHEMES;
  const dirty = source !== localSavedContent || visualDirty;

  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);

  useEffect(() => {
    onDirtyChangeRef.current?.(dirty || recovery !== null);
  }, [dirty, recovery]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    titleRef.current = note.title;
  }, [note.title]);

  useEffect(() => {
    const pending = pendingSelectionRef.current;
    const textarea = textareaRef.current;

    if (pending === null || textarea === null) {
      return;
    }

    pendingSelectionRef.current = null;
    textarea.setSelectionRange(pending, pending);
  }, [source]);

  const handleEditorReady = useCallback((editor: Editor) => {
    visualEditorRef.current = editor;
  }, []);

  const readCurrentContent = useCallback((): string | null => {
    if (modeRef.current === "visual") {
      const editor = visualEditorRef.current;

      if (!editor) {
        return sourceTextRef.current;
      }

      try {
        return serializeVisualJson(editor.getJSON());
      } catch {
        return null;
      }
    }

    return sourceTextRef.current;
  }, []);

  const storeDraft = useCallback(
    (contentMd: string) => {
      if (contentMd === savedContentRef.current) {
        clearStoredDrafts(note.id);
        return;
      }

      writeStoredDraft({
        noteId: note.id,
        baseVersion: versionRef.current,
        contentMd,
        savedAt: new Date().toISOString(),
      });
    },
    [note.id],
  );

  const loadServerVersion = useCallback(
    async (noteId: string, requestId: number) => {
      try {
        const serverNote = await fetchNote(noteId);

        setConflict((current) => {
          if (!current || requestId !== conflictRequestRef.current) {
            return current;
          }

          const refreshed: ConflictState = {
            ...current,
            latestVersion: serverNote.version,
            serverContentMd: serverNote.contentMd,
            serverNote,
            serverLoadFailed: false,
          };
          conflictRef.current = refreshed;
          return refreshed;
        });
      } catch {
        setConflict((current) => {
          if (!current || requestId !== conflictRequestRef.current) {
            return current;
          }

          const failed: ConflictState = {
            ...current,
            serverLoadFailed: true,
          };
          conflictRef.current = failed;
          return failed;
        });
      }
    },
    [],
  );

  const showConflict = useCallback(
    async (latestVersion: number, message: string) => {
      const nextConflict: ConflictState = {
        latestVersion,
        serverContentMd: null,
        serverNote: null,
        serverLoadFailed: false,
      };

      conflictRequestRef.current += 1;
      conflictRef.current = nextConflict;
      setConflict(nextConflict);
      setStatus(null);
      setError(
        `${message} Aktuální verze: ${latestVersion}. Váš text zůstal v editoru. Automatické ukládání je pozastaveno.`,
      );
      controllerRef.current?.pause();

      await loadServerVersion(note.id, conflictRequestRef.current);
    },
    [loadServerVersion, note.id],
  );

  const saveDraft = useCallback(
    async (contentMd: string): Promise<DraftSaveOutcome> => {
      try {
        const updated = await updateNote(note.id, {
          contentMd,
          draft: true,
          expectedVersion: versionRef.current,
          title: titleRef.current,
        });

        versionRef.current = updated.version;
        savedContentRef.current = updated.contentMd;
        restoreBaseVersionRef.current = null;
        setLocalVersion(updated.version);
        setLocalSavedContent(updated.contentMd);
        setHasAutosavedContent(true);
        setAutosaveError(null);
        setRecoveryDismissed(true);

        syncStoredDraft({
          noteId: note.id,
          acknowledgedContentMd: updated.contentMd,
          currentContentMd: readCurrentContent(),
          baseVersion: updated.version,
        });

        onSavedRef.current?.(updated);

        return {
          status: "saved",
          version: updated.version,
          contentMd: updated.contentMd,
          updatedAt: updated.updatedAt,
        };
      } catch (saveError) {
        if (saveError instanceof NoteApiError && saveError.status === 409) {
          return {
            status: "conflict",
            latestVersion: saveError.latestVersion ?? versionRef.current,
            message: saveError.message,
          };
        }

        return {
          status: "failed",
          message:
            saveError instanceof NoteApiError
              ? saveError.message
              : "Poznámku se nepodařilo uložit.",
        };
      }
    },
    [note.id, readCurrentContent],
  );

  const getAutosaveContent = useCallback((): string | null => {
    const content = readCurrentContent();

    if (content === null) {
      return null;
    }

    if (content === savedContentRef.current) {
      return null;
    }

    if (parseNoteMarkdown(content).graphemeCount > CONTENT_MAX_GRAPHEMES) {
      return null;
    }

    return content;
  }, [readCurrentContent]);

  const handleAutosaveStatus = useCallback(
    (next: DraftAutosaveStatus) => {
      switch (next.kind) {
        case "saving":
          setIsSaving(true);
          return;
        case "saved":
          setIsSaving(false);
          setStatus(
            `Uloženo · verze ${next.version} · ${formatCzechDateTime(next.updatedAt)}`,
          );
          return;
        case "conflict":
          setIsSaving(false);
          void showConflict(next.latestVersion, next.message);
          return;
        case "failed":
          setIsSaving(false);
          setStatus(null);
          setAutosaveError(
            `Ukládání konceptu se nezdařilo. ${next.message} Váš text zůstal v editoru.`,
          );
          return;
        case "idle":
          setIsSaving(false);
          return;
      }
    },
    [showConflict],
  );

  useEffect(() => {
    const controller = new DraftAutosaveController({
      debounceMs: DRAFT_AUTOSAVE_DEBOUNCE_MS,
      getContent: getAutosaveContent,
      onStatus: handleAutosaveStatus,
      save: saveDraft,
    });

    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [getAutosaveContent, handleAutosaveStatus, saveDraft]);

  useEffect(() => {
    if (restoreBaseVersionRef.current !== null) {
      return;
    }

    if (note.version <= versionRef.current) {
      return;
    }

    if (note.contentMd !== savedContentRef.current) {
      return;
    }

    versionRef.current = note.version;
    setLocalVersion(note.version);
  }, [note.contentMd, note.version]);

  useEffect(() => {
    if (!dirty && conflict === null && recovery === null) {
      return;
    }

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [conflict, dirty, recovery]);

  const notifyChange = useCallback(() => {
    controllerRef.current?.notifyChange();
  }, []);

  const syncVisualVoiceContent = useCallback(
    (markdown: string) => {
      visualEditedRef.current = true;
      setSource(markdown);
      sourceTextRef.current = markdown;
      setVisualDirty(false);
      storeDraft(markdown);
      notifyChange();
    },
    [notifyChange, storeDraft],
  );

  const revertVisualVoiceContent = useCallback(
    (editor: Editor, beforeJson: JSONContent) => {
      editor.commands.setContent(beforeJson, { emitUpdate: false });
      visualEditedRef.current = true;
      setVisualDirty(false);

      try {
        const markdown = serializeVisualJson(beforeJson);
        setSource(markdown);
        sourceTextRef.current = markdown;
        storeDraft(markdown);
      } catch {
        return;
      }
    },
    [storeDraft],
  );

  const applyVisualBlockBatch = useCallback(
    (
      editor: Editor,
      parts: readonly VoiceRenderedPart[],
    ): VoiceApplyResult => {
      const base = readCurrentContent();

      if (base === null) {
        return {
          ok: false,
          message:
            "Vizuální obsah nelze bezpečně přečíst. Přepněte do zdrojového režimu.",
        };
      }

      const applied = applyVoicePartsToMarkdown(base, base.length, parts);
      const parsedNext = parseNoteMarkdown(applied.content);

      if (parsedNext.graphemeCount > CONTENT_MAX_GRAPHEMES) {
        return {
          ok: false,
          message: voiceLimitMessage(parsedNext.graphemeCount),
        };
      }

      let visualJson: JSONContent;

      try {
        visualJson = convertMarkdownToVisual(applied.content);
      } catch {
        return {
          ok: false,
          message:
            "Formátovaný text nelze ve vizuálním režimu bezpečně zobrazit. Přepněte do zdrojového režimu.",
        };
      }

      const beforeJson = editor.getJSON();
      editor.commands.setContent(visualJson, { emitUpdate: false });

      let canonical: string;

      try {
        canonical = serializeVisualJson(editor.getJSON());
      } catch {
        revertVisualVoiceContent(editor, beforeJson);
        return {
          ok: false,
          message:
            "Formátovaný text nelze bezpečně převést zpět do Markdownu. Obsah zůstal beze změny.",
        };
      }

      const parsedCanonical = parseNoteMarkdown(canonical);

      if (parsedCanonical.graphemeCount > CONTENT_MAX_GRAPHEMES) {
        revertVisualVoiceContent(editor, beforeJson);
        return {
          ok: false,
          message: voiceLimitMessage(parsedCanonical.graphemeCount),
        };
      }

      setVisualSelectionAtEnd(editor);
      syncVisualVoiceContent(canonical);

      return {
        ok: true,
        notice:
          "Formátovací příkazy se ve vizuálním režimu vkládají na konec poznámky.",
      };
    },
    [readCurrentContent, revertVisualVoiceContent, syncVisualVoiceContent],
  );

  const applyVisualInlineBatch = useCallback(
    (
      editor: Editor,
      parts: readonly VoiceRenderedPart[],
      mode: BodyInsertMode,
    ): VoiceApplyResult => {
      const beforeJson = editor.getJSON();

      if (visualPendingParagraphRef.current) {
        insertVisualParagraphAtEnd(editor);
        visualPendingParagraphRef.current = false;
      }

      if (mode === "end") {
        setVisualSelectionAtEnd(editor);
      }

      for (const part of parts) {
        if (part.kind === "text") {
          insertVisualVoiceText(editor, part.text, part.marks);
        } else if (part.kind === "line_break") {
          editor.chain().focus().setHardBreak().run();
        }
      }

      let markdown: string;

      try {
        markdown = serializeVisualJson(editor.getJSON());
      } catch {
        revertVisualVoiceContent(editor, beforeJson);
        return {
          ok: false,
          message:
            "Vizuální text nelze bezpečně převést do Markdownu. Obsah zůstal beze změny.",
        };
      }

      const parsedNext = parseNoteMarkdown(markdown);

      if (parsedNext.graphemeCount > CONTENT_MAX_GRAPHEMES) {
        revertVisualVoiceContent(editor, beforeJson);
        return {
          ok: false,
          message: voiceLimitMessage(parsedNext.graphemeCount),
        };
      }

      syncVisualVoiceContent(markdown);
      return { ok: true };
    },
    [revertVisualVoiceContent, syncVisualVoiceContent],
  );

  const applyVoiceBatch = useCallback(
    (
      batch: VoiceFormattingBatch,
      insertMode: BodyInsertMode,
    ): VoiceApplyResult => {
      if (batch.batchIndex === 0) {
        visualVoiceEndModeRef.current = false;
        visualPendingParagraphRef.current = false;
      }

      if (batch.parts.length === 0) {
        return { ok: true };
      }

      if (modeRef.current === "visual") {
        const editor = visualEditorRef.current;

        if (editor === null) {
          return {
            ok: false,
            message:
              "Vizuální editor není připravený. Přepněte do zdrojového režimu.",
          };
        }

        if (batch.parts.some(isBlockVoicePart)) {
          visualVoiceEndModeRef.current = true;
          visualPendingParagraphRef.current = needsVisualParagraphAfter(
            batch.parts,
          );
          return applyVisualBlockBatch(editor, batch.parts);
        }

        const effectiveMode = visualVoiceEndModeRef.current
          ? "end"
          : insertMode;

        return applyVisualInlineBatch(editor, batch.parts, effectiveMode);
      }

      const current = sourceTextRef.current;
      const cursor =
        insertMode === "end"
          ? current.length
          : (pendingSelectionRef.current ??
            textareaRef.current?.selectionStart ??
            current.length);
      const applied = applyVoicePartsToMarkdown(current, cursor, batch.parts);
      const parsedNext = parseNoteMarkdown(applied.content);

      if (parsedNext.graphemeCount > CONTENT_MAX_GRAPHEMES) {
        return {
          ok: false,
          message: voiceLimitMessage(parsedNext.graphemeCount),
        };
      }

      if (applied.content !== current) {
        sourceTextRef.current = applied.content;
        setSource(applied.content);
        storeDraft(applied.content);
        notifyChange();
      }

      pendingSelectionRef.current = applied.cursor;
      return { ok: true };
    },
    [
      applyVisualBlockBatch,
      applyVisualInlineBatch,
      notifyChange,
      storeDraft,
    ],
  );

  const clearRecoverableError = useCallback(() => {
    if (conflictRef.current === null) {
      setError(null);
    }
  }, []);

  const handleVisualChange = useCallback(
    (markdown: string) => {
      setSource(markdown);
      sourceTextRef.current = markdown;
      setVisualDirty(false);
      storeDraft(markdown);
    },
    [storeDraft],
  );

  const handleVisualError = useCallback((message: string) => {
    setError(message);
  }, []);

  const handleVisualPending = useCallback(() => {
    visualEditedRef.current = true;
    setVisualDirty(true);
    setStatus(null);
    clearRecoverableError();
    setRecoveryDismissed(true);
    notifyChange();
  }, [clearRecoverableError, notifyChange]);

  const handleTaskToggle = useCallback(
    (markdown: string) => {
      setSource(markdown);
      sourceTextRef.current = markdown;
      setVisualDirty(false);
      setStatus(null);
      setRecoveryDismissed(true);
      clearRecoverableError();

      if (conflictRef.current !== null) {
        return;
      }

      controllerRef.current?.cancelPending();
      taskSavePendingRef.current += 1;
      setIsSaving(true);
      setIsExplicitSaving(true);

      taskSaveChainRef.current = taskSaveChainRef.current.then(async () => {
        try {
          await controllerRef.current?.waitForIdle();
          controllerRef.current?.cancelPending();

          if (conflictRef.current !== null) {
            return;
          }

          controllerRef.current?.pause();
          const updated = await updateNote(note.id, {
            contentMd: markdown,
            expectedVersion: versionRef.current,
            title: titleRef.current,
          });

          versionRef.current = updated.version;
          savedContentRef.current = updated.contentMd;
          restoreBaseVersionRef.current = null;
          setLocalVersion(updated.version);
          setLocalSavedContent(updated.contentMd);
          setHasAutosavedContent(false);
          setAutosaveError(null);
          setRecoveryDismissed(true);
          setStatus(
            `Uloženo · verze ${updated.version} · ${formatCzechDateTime(updated.updatedAt)}`,
          );

          syncStoredDraft({
            noteId: note.id,
            acknowledgedContentMd: updated.contentMd,
            currentContentMd: readCurrentContent(),
            baseVersion: updated.version,
          });

          onSaved?.(updated);
        } catch (saveError) {
          if (saveError instanceof NoteApiError && saveError.status === 409) {
            await showConflict(
              saveError.latestVersion ?? versionRef.current,
              saveError.message,
            );
          } else {
            storeDraft(markdown);
            setStatus(null);
            setError(
              saveError instanceof NoteApiError
                ? `${saveError.message} Změna úkolu zůstala v editoru.`
                : "Změnu úkolu se nepodařilo uložit. Zůstala v editoru.",
            );
          }
        } finally {
          taskSavePendingRef.current -= 1;

          if (taskSavePendingRef.current === 0) {
            setIsSaving(false);
            setIsExplicitSaving(false);
          }

          if (conflictRef.current === null) {
            controllerRef.current?.resume();

            if (
              taskSavePendingRef.current === 0 &&
              readCurrentContent() !== savedContentRef.current
            ) {
              notifyChange();
            }
          }
        }
      });
    },
    [
      clearRecoverableError,
      note.id,
      notifyChange,
      onSaved,
      readCurrentContent,
      showConflict,
      storeDraft,
    ],
  );

  const handleBodyDictationStart = useCallback(() => {
    bodyVoiceBaselineRef.current = readCurrentContent();
  }, [readCurrentContent]);

  const handleBodyDictationComplete = useCallback(async () => {
    const baseline = bodyVoiceBaselineRef.current;
    bodyVoiceBaselineRef.current = null;

    if (baseline === null || conflictRef.current !== null) {
      return;
    }

    controllerRef.current?.cancelPending();
    setIsExplicitSaving(true);

    try {
      await controllerRef.current?.waitForIdle();
      await taskSaveChainRef.current;
      controllerRef.current?.cancelPending();

      if (conflictRef.current !== null) {
        return;
      }

      const contentMd = readCurrentContent();

      if (contentMd === null || contentMd === baseline) {
        return;
      }

      controllerRef.current?.pause();
      const updated = await saveVoiceContent(note.id, {
        baselineContentMd: baseline,
        contentMd,
        expectedVersion: versionRef.current,
      });

      versionRef.current = updated.version;
      savedContentRef.current = updated.contentMd;
      restoreBaseVersionRef.current = null;
      setLocalVersion(updated.version);
      setLocalSavedContent(updated.contentMd);
      setHasAutosavedContent(false);
      setAutosaveError(null);
      setRecoveryDismissed(true);
      setStatus(
        `Hlasový přepis uložen · verze ${updated.version} · ${formatCzechDateTime(updated.updatedAt)}`,
      );

      syncStoredDraft({
        noteId: note.id,
        acknowledgedContentMd: updated.contentMd,
        currentContentMd: readCurrentContent(),
        baseVersion: updated.version,
      });
      onSaved?.(updated);
    } catch (saveError) {
      if (saveError instanceof NoteApiError && saveError.status === 409) {
        await showConflict(
          saveError.latestVersion ?? versionRef.current,
          saveError.message,
        );
      } else {
        const current = readCurrentContent();

        if (current !== null) {
          storeDraft(current);
        }

        setStatus(null);
        setError(
          saveError instanceof NoteApiError
            ? `${saveError.message} Váš text zůstal v editoru.`
            : "Hlasový přepis se nepodařilo uložit. Váš text zůstal v editoru.",
        );
      }
    } finally {
      setIsExplicitSaving(false);

      if (conflictRef.current === null) {
        controllerRef.current?.resume();
      }
    }
  }, [
    note.id,
    onSaved,
    readCurrentContent,
    showConflict,
    storeDraft,
  ]);

  function handleSourceChange(value: string) {
    setSource(value);
    sourceTextRef.current = value;
    setVisualDirty(false);
    setStatus(null);
    clearRecoverableError();
    setRecoveryDismissed(true);
    storeDraft(value);
    notifyChange();
  }

  function handleShowVisual() {
    if (mode === "visual") {
      return;
    }

    setStatus(null);
    clearRecoverableError();

    try {
      const content = convertMarkdownToVisual(source);
      visualEditedRef.current = false;
      visualEditorRef.current = null;
      setVisualContent(content);
      setVisualDirty(false);
      setMode("visual");
      modeRef.current = "visual";
    } catch (conversionError) {
      if (conversionError instanceof VisualConversionError) {
        setError(describeVisualFailure(conversionError.failure));
        return;
      }

      setError("Vizuální režim se nepodařilo otevřít.");
    }
  }

  function handleShowSource() {
    setStatus(null);
    clearRecoverableError();

    if (mode === "visual" && visualEditorRef.current) {
      try {
        const markdown = serializeVisualJson(
          visualEditorRef.current.getJSON(),
        );
        setSource(markdown);
        sourceTextRef.current = markdown;
        setVisualDirty(false);

        if (visualEditedRef.current) {
          storeDraft(markdown);
          setRecoveryDismissed(true);
        }
      } catch {
        setError(
          "Vizuální obsah nelze bezpečně převést zpět do Markdownu. Přepnuto do zdrojového režimu s posledním bezpečně převedeným textem.",
        );
        setStatus("Poslední vizuální úprava nebyla přenesena do zdrojového textu.");
        setVisualContent(null);
        visualEditorRef.current = null;
        setVisualDirty(false);
        setMode("source");
        modeRef.current = "source";
        return;
      }
    }

    setVisualContent(null);
    visualEditorRef.current = null;
    setMode("source");
    modeRef.current = "source";
  }

  async function handleSave() {
    clearRecoverableError();
    setStatus(null);
    setCopyNotice(null);

    let markdown = source;

    if (mode === "visual" && visualEditorRef.current) {
      try {
        markdown = serializeVisualJson(visualEditorRef.current.getJSON());
        setSource(markdown);
        sourceTextRef.current = markdown;
      } catch (serializationError) {
        setError(
          serializationError instanceof Error
            ? serializationError.message
            : "Vizuální obsah nelze převést do Markdownu.",
        );
        return;
      }
    }

    const currentParsed = parseNoteMarkdown(markdown);
    if (currentParsed.graphemeCount > CONTENT_MAX_GRAPHEMES) {
      setError(
        `Poznámka může mít nejvýše ${formatCount(CONTENT_MAX_GRAPHEMES)} viditelných znaků. Před uložením ji zkraťte.`,
      );
      return;
    }

    storeDraft(markdown);

    controllerRef.current?.cancelPending();
    await controllerRef.current?.waitForIdle();
    controllerRef.current?.cancelPending();

    setIsSaving(true);
    setIsExplicitSaving(true);

    try {
      const updated = await updateNote(note.id, {
        contentMd: markdown,
        expectedVersion: versionRef.current,
        title: titleRef.current,
      });

      versionRef.current = updated.version;
      savedContentRef.current = updated.contentMd;
      restoreBaseVersionRef.current = null;
      setLocalVersion(updated.version);
      setLocalSavedContent(updated.contentMd);
      setSource(updated.contentMd);
      sourceTextRef.current = updated.contentMd;
      setVisualDirty(false);
      setHasAutosavedContent(false);
      conflictRef.current = null;
      setConflict(null);
      setAutosaveError(null);
      setRecoveryDismissed(true);
      setStatus(
        `Uloženo · verze ${updated.version} · ${formatCzechDateTime(updated.updatedAt)}`,
      );

      syncStoredDraft({
        noteId: note.id,
        acknowledgedContentMd: updated.contentMd,
        currentContentMd: markdown,
        baseVersion: updated.version,
      });

      onSaved?.(updated);
    } catch (saveError) {
      if (saveError instanceof NoteApiError && saveError.status === 409) {
        await showConflict(
          saveError.latestVersion ?? versionRef.current,
          saveError.message,
        );
      } else {
        setError(
          saveError instanceof NoteApiError
            ? `${saveError.message} Váš text zůstal v editoru.`
            : "Poznámku se nepodařilo uložit. Váš text zůstal v editoru.",
        );
      }
    } finally {
      controllerRef.current?.cancelPending();

      if (conflictRef.current === null) {
        controllerRef.current?.resume();
      }

      setIsSaving(false);
      setIsExplicitSaving(false);
    }
  }

  function handleRestoreDraft() {
    if (!recovery) {
      return;
    }

    const draft = recovery;

    setSource(draft.contentMd);
    sourceTextRef.current = draft.contentMd;
    visualEditedRef.current = false;
    visualEditorRef.current = null;
    setVisualContent(null);
    setVisualDirty(false);
    setMode("source");
    modeRef.current = "source";
    setRecoveryDismissed(true);
    setStatus(null);
    restoreBaseVersionRef.current = draft.baseVersion;
    versionRef.current = draft.baseVersion;
    setLocalVersion(draft.baseVersion);
    storeDraft(draft.contentMd);
    notifyChange();
  }

  function handleDiscardDraft() {
    clearStoredDrafts(note.id);
    setRecoveryDismissed(true);
  }

  function handleLoadServerVersion() {
    if (!conflict || conflict.serverNote === null) {
      return;
    }

    const serverNote = conflict.serverNote;

    setSource(serverNote.contentMd);
    sourceTextRef.current = serverNote.contentMd;
    savedContentRef.current = serverNote.contentMd;
    visualEditedRef.current = false;
    visualEditorRef.current = null;
    versionRef.current = serverNote.version;
    setLocalVersion(serverNote.version);
    setLocalSavedContent(serverNote.contentMd);
    titleRef.current = serverNote.title;
    setVisualContent(null);
    setVisualDirty(false);
    setHasAutosavedContent(false);
    setMode("source");
    modeRef.current = "source";
    conflictRef.current = null;
    setConflict(null);
    setError(null);
    setAutosaveError(null);
    setStatus(null);
    setRecoveryDismissed(true);
    restoreBaseVersionRef.current = null;
    clearStoredDrafts(note.id);
    controllerRef.current?.resume();
    onSaved?.(serverNote);
  }

  async function handleCopyText(value: string, label: string) {
    try {
      if (!navigator.clipboard) {
        throw new Error("Schránka není dostupná.");
      }

      await navigator.clipboard.writeText(value);
      setCopyNotice(`${label} byl zkopírován do schránky.`);
    } catch {
      setCopyNotice(
        "Kopírování do schránky selhalo. Text zvolte a zkopírujte ručně.",
      );
    }
  }

  const statusText = isSaving
    ? "Ukládá se…"
    : dirty
      ? "Neuložené změny"
      : conflict !== null
        ? "Konflikt uložení – automatické ukládání je pozastaveno."
        : recovery !== null
          ? "Nalezen neuložený koncept – obnovte ho nebo zahoďte."
          : status ?? "Vše je uloženo.";

  const alertMessage = [autosaveError, error].filter(Boolean).join(" ");
  const canSave = dirty || hasAutosavedContent;
  const bodyDictationDisabled =
    conflict !== null || overLimit || recovery !== null || isExplicitSaving;
  const bodyDictationDisabledReason =
    conflict !== null
      ? "Diktování textu je pozastaveno, dokud nevyřešíte konflikt uložení."
      : overLimit
        ? "Diktování textu je pozastaveno, protože obsah překračuje limit."
        : recovery !== null
          ? "Nejprve obnovte nebo zahoďte nalezený koncept."
          : isExplicitSaving
            ? "Počkejte na dokončení ukládání."
            : null;

  return (
    <section aria-labelledby="note-editor-heading" className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          className="text-lg font-semibold tracking-tight text-stone-950"
          id="note-editor-heading"
        >
          Editor
        </h2>
        <div
          aria-label="Režim editoru"
          className="inline-flex rounded-lg border border-stone-300 bg-white p-1"
          role="group"
        >
          <button
            aria-pressed={mode === "source"}
            className="rounded-md px-3 py-1.5 text-sm font-semibold text-stone-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 aria-pressed:bg-emerald-800 aria-pressed:text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isExplicitSaving}
            onClick={handleShowSource}
            type="button"
          >
            Zdrojový režim
          </button>
          <button
            aria-pressed={mode === "visual"}
            className="rounded-md px-3 py-1.5 text-sm font-semibold text-stone-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 aria-pressed:bg-emerald-800 aria-pressed:text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isExplicitSaving}
            onClick={handleShowVisual}
            type="button"
          >
            Vizuální režim
          </button>
        </div>
      </div>

      {recovery ? (
        <section
          aria-labelledby="note-recovery-heading"
          className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4"
          role="region"
        >
          <h3
            className="text-sm font-semibold text-amber-950"
            id="note-recovery-heading"
          >
            Nalezen neuložený koncept
          </h3>
          <p className="mt-1 text-sm text-amber-900">
            V této kartě je uložený rozpracovaný text poznámky (verze{" "}
            {recovery.baseVersion}). Obnovit jej do editoru, nebo ho zahodit?
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="rounded-lg bg-amber-800 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
              onClick={handleRestoreDraft}
              type="button"
            >
              Obnovit koncept
            </button>
            <button
              className="rounded-lg border border-amber-300 px-4 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
              onClick={handleDiscardDraft}
              type="button"
            >
              Zahodit koncept
            </button>
          </div>
        </section>
      ) : null}

      {conflict ? (
        <section
          aria-labelledby="note-conflict-heading"
          className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4"
          role="region"
        >
          <h3
            className="text-sm font-semibold text-amber-950"
            id="note-conflict-heading"
          >
            Konflikt uložení
          </h3>
          <p className="mt-1 text-sm text-amber-900">
            Poznámka byla mezitím změněna. Automatické ukládání je
            pozastaveno. Texty se nikdy nepřipojují ani nepřepisují automaticky –
            porovnejte je a rozhodněte ručně. Načtením serverové verze se text
            v editoru nahradí, proto si svůj text nejprve zkopírujte.
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <label
                className="block text-sm font-medium text-amber-950"
                htmlFor="note-conflict-local"
              >
                Můj text (verze {localVersion})
              </label>
              <textarea
                className="mt-1 min-h-32 w-full rounded-lg border border-amber-300 bg-white p-2 font-mono text-xs"
                id="note-conflict-local"
                readOnly
                value={source}
              />
            </div>
            <div>
              <label
                className="block text-sm font-medium text-amber-950"
                htmlFor="note-conflict-server"
              >
                Text na serveru (verze {conflict.latestVersion})
              </label>
              <textarea
                className="mt-1 min-h-32 w-full rounded-lg border border-amber-300 bg-white p-2 font-mono text-xs"
                id="note-conflict-server"
                readOnly
                value={
                  conflict.serverContentMd ??
                  (conflict.serverLoadFailed
                    ? "Serverovou verzi se nepodařilo načíst."
                    : "Načítání serverové verze…")
                }
              />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="rounded-lg border border-amber-300 px-4 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
              onClick={() => void handleCopyText(source, "Můj text")}
              type="button"
            >
              Zkopírovat můj text
            </button>
            <button
              className="rounded-lg border border-amber-300 px-4 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
              disabled={conflict.serverContentMd === null}
              onClick={() =>
                void handleCopyText(
                  conflict.serverContentMd ?? "",
                  "Serverová verze",
                )
              }
              type="button"
            >
              Zkopírovat serverovou verzi
            </button>
            <button
              className="rounded-lg bg-amber-800 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={conflict.serverNote === null}
              onClick={handleLoadServerVersion}
              type="button"
            >
              Načíst serverovou verzi
            </button>
            {conflict.serverLoadFailed ? (
              <button
                className="rounded-lg border border-amber-300 px-4 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
                onClick={() => {
                  conflictRequestRef.current += 1;
                  void loadServerVersion(note.id, conflictRequestRef.current);
                }}
                type="button"
              >
                Zkusit načíst serverovou verzi znovu
              </button>
            ) : null}
          </div>
          {copyNotice ? (
            <p aria-live="polite" className="mt-2 text-sm text-amber-900">
              {copyNotice}
            </p>
          ) : null}
        </section>
      ) : null}

      <BodyDictationControls
        contentGraphemeCount={parsed.graphemeCount}
        disabled={bodyDictationDisabled}
        disabledReason={bodyDictationDisabledReason}
        onApplyBatch={applyVoiceBatch}
        onSessionComplete={handleBodyDictationComplete}
        onSessionStart={handleBodyDictationStart}
        targetMode={mode}
      />

      <div className="mt-4">
        {mode === "source" ? (
          <MarkdownSource
            disabled={isExplicitSaving}
            onChange={handleSourceChange}
            textareaRef={textareaRef}
            value={source}
          />
        ) : visualContent ? (
          <VisualMarkdownEditor
            disabled={isExplicitSaving}
            initialContent={visualContent}
            onChange={handleVisualChange}
            onEditorReady={handleEditorReady}
            onError={handleVisualError}
            onPendingChange={handleVisualPending}
            onTaskToggle={handleTaskToggle}
          />
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p
          aria-live="polite"
          className={
            overLimit
              ? "text-sm font-semibold text-red-800"
              : "text-sm text-stone-600"
          }
          data-testid="note-grapheme-counter"
          id="note-grapheme-counter"
        >
          {formatCount(parsed.graphemeCount)} /{" "}
          {formatCount(CONTENT_MAX_GRAPHEMES)} viditelných znaků
        </p>
        <button
          className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={isSaving || overLimit || !canSave}
          onClick={() => void handleSave()}
          type="button"
        >
          {isExplicitSaving ? "Ukládám…" : "Uložit"}
        </button>
      </div>

      {overLimit ? (
        <p
          className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
          role="alert"
        >
          Poznámka překračuje limit {formatCount(CONTENT_MAX_GRAPHEMES)}{" "}
          viditelných znaků. Můžete pokračovat v úpravách, ale uložit ji lze až
          po zkrácení.
        </p>
      ) : null}

      {alertMessage ? (
        <p
          className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
          role="alert"
        >
          {alertMessage}
        </p>
      ) : null}

      <p
        aria-live="polite"
        className="mt-3 text-sm text-stone-600"
        role="status"
      >
        {statusText}
      </p>
    </section>
  );
}
