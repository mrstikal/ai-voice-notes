"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { NoteDetail } from "@/lib/notes/client";

import { DictationControls } from "../voice/DictationControls";
import { NoteEditor } from "./NoteEditor";
import { NoteHeader } from "./NoteHeader";

interface NoteWorkspaceProps {
  readonly note: NoteDetail;
}

export function NoteWorkspace({ note: initialNote }: NoteWorkspaceProps) {
  const router = useRouter();
  const [note, setNote] = useState(initialNote);
  const [editorDirty, setEditorDirty] = useState(false);

  function handleNoteUpdated(updated: NoteDetail) {
    setNote(updated);
    router.refresh();
  }

  return (
    <>
      <NoteHeader note={note} onNoteUpdated={handleNoteUpdated} />
      <DictationControls
        note={note}
        onNoteUpdated={handleNoteUpdated}
        disabled={editorDirty}
      />
      <NoteEditor
        note={note}
        onSaved={handleNoteUpdated}
        onDirtyChange={setEditorDirty}
      />
    </>
  );
}
