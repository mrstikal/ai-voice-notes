"use client";

import type { Ref } from "react";

interface MarkdownSourceProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly textareaRef?: Ref<HTMLTextAreaElement>;
}

export function MarkdownSource({
  value,
  onChange,
  disabled = false,
  textareaRef,
}: MarkdownSourceProps) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label
          className="block text-sm font-medium text-stone-800"
          htmlFor="note-markdown-source"
        >
          Obsah (Markdown)
        </label>
        <span className="text-xs text-stone-500">
          Markdown je uložený formát poznámky.
        </span>
      </div>
      <textarea
        aria-describedby="note-markdown-source-help note-grapheme-counter"
        className="mt-2 min-h-80 w-full resize-y rounded-xl border border-stone-300 bg-white px-4 py-3 font-mono text-sm leading-6 text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:bg-stone-100"
        disabled={disabled}
        id="note-markdown-source"
        onChange={(event) => onChange(event.target.value)}
        ref={textareaRef}
        spellCheck={false}
        value={value}
      />
      <p className="mt-2 text-xs text-stone-500" id="note-markdown-source-help">
        Můžete použít nadpisy H1-H3, odstavce, seznamy, úkoly, citace, tučné a
        kurzívové písmo, odkazy, vložený i blokový kód. Nepodporovaný Markdown
        zůstane dostupný pouze ve zdrojovém režimu.
      </p>
    </div>
  );
}
