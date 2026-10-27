"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { NoteDetail } from "@/lib/notes/client";
import type { TtsProviderStatus } from "@/lib/tts/provider";

import { ManualProposalPanel } from "../ai/ManualProposalPanel";
import { AudioPlayer } from "../tts/AudioPlayer";
import { DictationControls } from "../voice/DictationControls";
import { NoteEditor } from "./NoteEditor";
import { NoteHeader } from "./NoteHeader";

interface NoteWorkspaceProps {
  readonly note: NoteDetail;
  readonly providerStatus: TtsProviderStatus | null;
  readonly providerError: string | null;
}

export function NoteWorkspace({
  note: initialNote,
  providerStatus,
  providerError,
}: NoteWorkspaceProps) {
  const router = useRouter();
  const [note, setNote] = useState(initialNote);
  const [editorDirty, setEditorDirty] = useState(false);
  const [externalEditRevision, setExternalEditRevision] = useState(0);

  function handleNoteUpdated(updated: NoteDetail) {
    setNote(updated);
    router.refresh();
  }

  function handleProposalApplied(updated: NoteDetail) {
    setNote(updated);
    setExternalEditRevision((current) => current + 1);
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
        key={`${note.id}:${externalEditRevision}`}
        note={note}
        onSaved={handleNoteUpdated}
        onDirtyChange={setEditorDirty}
      />
      <AudioPlayer
        disabled={editorDirty}
        note={note}
        providerError={providerError}
        providerStatus={providerStatus}
      />
      <ManualProposalPanel
        disabled={editorDirty}
        key={note.version}
        noteId={note.id}
        noteTitle={note.title}
        noteVersion={note.version}
        onNoteUpdated={handleProposalApplied}
      />
    </>
  );
}
