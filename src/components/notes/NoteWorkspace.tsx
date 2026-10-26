"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { NoteDetail } from "@/lib/notes/client";

import { NoteEditor } from "./NoteEditor";
import { NoteHeader } from "./NoteHeader";

interface NoteWorkspaceProps {
  readonly note: NoteDetail;
}

export function NoteWorkspace({ note: initialNote }: NoteWorkspaceProps) {
  const router = useRouter();
  const [note, setNote] = useState(initialNote);

  function handleNoteUpdated(updated: NoteDetail) {
    setNote(updated);
    router.refresh();
  }

  return (
    <>
      <NoteHeader note={note} onNoteUpdated={handleNoteUpdated} />
      <NoteEditor note={note} onSaved={handleNoteUpdated} />
    </>
  );
}
