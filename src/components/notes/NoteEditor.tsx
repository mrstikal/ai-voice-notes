"use client";

import type { Editor, JSONContent } from "@tiptap/core";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  NoteApiError,
  formatCzechDateTime,
  updateNote,
  type NoteDetail,
} from "@/lib/notes/client";
import { CONTENT_MAX_GRAPHEMES } from "@/lib/notes/limits";
import {
  NOTE_EDITOR_EXTENSIONS,
  VisualConversionError,
  convertMarkdownToVisual,
  serializeVisualJson,
  type VisualConversionFailure,
} from "@/lib/notes/editor-markdown";
import { isSafeLinkDestination, parseNoteMarkdown } from "@/lib/notes/markdown";

import { MarkdownSource } from "./MarkdownSource";

type EditorMode = "source" | "visual";

interface NoteEditorProps {
  readonly note: NoteDetail;
  readonly onSaved?: (note: NoteDetail) => void;
}

function formatCount(value: number): string {
  return value.toLocaleString("cs-CZ");
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
}

function VisualMarkdownEditor({
  initialContent,
  disabled,
  onChange,
  onError,
  onPendingChange,
  onEditorReady,
}: VisualMarkdownEditorProps) {
  const onChangeRef = useRef(onChange);
  const onErrorRef = useRef(onError);
  const onPendingChangeRef = useRef(onPendingChange);
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

  useEffect(
    () => () => {
      if (serializationTimeoutRef.current !== null) {
        clearTimeout(serializationTimeoutRef.current);
      }
    },
    [],
  );

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
    onUpdate: ({ editor: currentEditor }) => {
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
        Shift+Enter vloží pevný zlomek. Změny se ukládají tlačítkem Uložit.
      </p>
    </div>
  );
}

export function NoteEditor({ note, onSaved }: NoteEditorProps) {
  const [mode, setMode] = useState<EditorMode>("source");
  const [source, setSource] = useState(note.contentMd);
  const [localSavedContent, setLocalSavedContent] = useState(note.contentMd);
  const [localVersion, setLocalVersion] = useState(note.version);
  const [visualContent, setVisualContent] = useState<JSONContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [visualDirty, setVisualDirty] = useState(false);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const visualEditorRef = useRef<Editor | null>(null);

  const deferredSource = useDeferredValue(source);
  const parsed = useMemo(
    () => parseNoteMarkdown(deferredSource),
    [deferredSource],
  );
  const overLimit = parsed.graphemeCount > CONTENT_MAX_GRAPHEMES;
  const parentHasNewerVersion = note.version > localVersion;
  const savedContent = parentHasNewerVersion ? note.contentMd : localSavedContent;
  const version = parentHasNewerVersion ? note.version : localVersion;
  const dirty = source !== savedContent || visualDirty;

  const handleEditorReady = useCallback((editor: Editor) => {
    visualEditorRef.current = editor;
  }, []);

  const handleVisualChange = useCallback((markdown: string) => {
    setSource(markdown);
    setVisualDirty(false);
    setStatus(null);
    setError(null);
  }, []);

  const handleVisualError = useCallback((message: string) => {
    setError(message);
  }, []);

  const handleVisualPending = useCallback(() => {
    setVisualDirty(true);
    setStatus(null);
    setError(null);
  }, []);

  function handleSourceChange(value: string) {
    setSource(value);
    setVisualDirty(false);
    setStatus(null);
    setError(null);
  }

  function handleShowVisual() {
    setError(null);
    setStatus(null);

    try {
      const content = convertMarkdownToVisual(source);
      setVisualContent(content);
      setVisualDirty(false);
      setMode("visual");
    } catch (conversionError) {
      if (conversionError instanceof VisualConversionError) {
        setError(describeVisualFailure(conversionError.failure));
        return;
      }

      setError("Vizuální režim se nepodařilo otevřít.");
    }
  }

  function handleShowSource() {
    setError(null);
    setStatus(null);

    if (mode === "visual" && visualEditorRef.current) {
      try {
        const markdown = serializeVisualJson(
          visualEditorRef.current.getJSON(),
        );
        setSource(markdown);
        setVisualDirty(false);
      } catch {
        setError(
          "Vizuální obsah nelze bezpečně převést zpět do Markdownu. Přepnuto do zdrojového režimu s posledním bezpečně převedeným textem.",
        );
        setStatus("Poslední vizuální úprava nebyla přenesena do zdrojového textu.");
        setVisualContent(null);
        setVisualDirty(false);
        setMode("source");
        return;
      }
    }

    setVisualContent(null);
    setMode("source");
  }

  async function handleSave() {
    setError(null);
    setStatus(null);

    let markdown = source;
    if (mode === "visual" && visualEditorRef.current) {
      try {
        markdown = serializeVisualJson(visualEditorRef.current.getJSON());
        setSource(markdown);
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

    setIsSaving(true);

    try {
      const updated = await updateNote(note.id, {
        contentMd: markdown,
        expectedVersion: version,
        title: note.title,
      });

      setLocalVersion(updated.version);
      setLocalSavedContent(updated.contentMd);
      setSource(updated.contentMd);
      setVisualDirty(false);
      setStatus(
        `Uloženo · verze ${updated.version} · ${formatCzechDateTime(updated.updatedAt)}`,
      );
      onSaved?.(updated);
    } catch (saveError) {
      if (saveError instanceof NoteApiError) {
        if (saveError.status === 409) {
          const latestVersion =
            saveError.latestVersion === undefined
              ? ""
              : ` Aktuální verze: ${saveError.latestVersion}.`;
          setError(
            `${saveError.message}${latestVersion} Váš text zůstal v editoru.`,
          );
        } else {
          setError(`${saveError.message} Váš text zůstal v editoru.`);
        }
      } else {
        setError(
          "Poznámku se nepodařilo uložit. Váš text zůstal v editoru.",
        );
      }
    } finally {
      setIsSaving(false);
    }
  }

  const statusText = isSaving
    ? "Ukládám…"
    : dirty
      ? "Neuložené změny"
      : status ?? "Vše je uloženo.";

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
            disabled={isSaving}
            onClick={handleShowSource}
            type="button"
          >
            Zdrojový režim
          </button>
          <button
            aria-pressed={mode === "visual"}
            className="rounded-md px-3 py-1.5 text-sm font-semibold text-stone-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 aria-pressed:bg-emerald-800 aria-pressed:text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isSaving}
            onClick={handleShowVisual}
            type="button"
          >
            Vizuální režim
          </button>
        </div>
      </div>

      <div className="mt-4">
        {mode === "source" ? (
          <MarkdownSource
            disabled={isSaving}
            onChange={handleSourceChange}
            textareaRef={sourceRef}
            value={source}
          />
        ) : visualContent ? (
          <VisualMarkdownEditor
            disabled={isSaving}
            initialContent={visualContent}
            onChange={handleVisualChange}
            onEditorReady={handleEditorReady}
            onError={handleVisualError}
            onPendingChange={handleVisualPending}
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
          disabled={isSaving || overLimit || !dirty}
          onClick={() => void handleSave()}
          type="button"
        >
          {isSaving ? "Ukládám…" : "Uložit"}
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

      {error ? (
        <p
          className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
          role="alert"
        >
          {error}
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
