"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { NoteDetail } from "@/lib/notes/client";
import type { LlmProviderStatus } from "@/lib/ai/structured";
import type { TtsProviderStatus } from "@/lib/tts/provider";

import { AiEditControls } from "../ai/AiEditControls";
import { CleanupAction } from "../ai/CleanupAction";
import { ManualProposalPanel } from "../ai/ManualProposalPanel";
import { SummaryAction } from "../ai/SummaryAction";
import { TaskSuggestions } from "../ai/TaskSuggestions";
import { RevisionHistory } from "./RevisionHistory";
import { AudioPlayer } from "../tts/AudioPlayer";
import { DictationControls } from "../voice/DictationControls";
import type { SummaryArtifact } from "@/lib/ai/summary-types";

import { NoteEditor } from "./NoteEditor";
import { NoteHeader } from "./NoteHeader";
import { NoteTags } from "./NoteTags";
import { TaskVoiceControls } from "./TaskVoiceControls";

interface NoteWorkspaceProps {
  readonly note: NoteDetail;
  readonly providerStatus: TtsProviderStatus | null;
  readonly providerError: string | null;
  readonly llmStatus: LlmProviderStatus | null;
  readonly llmError: string | null;
}

export function NoteWorkspace({
  note: initialNote,
  providerStatus,
  providerError,
  llmStatus,
  llmError,
}: NoteWorkspaceProps) {
  const router = useRouter();
  const [note, setNote] = useState(initialNote);
  const [editorDirty, setEditorDirty] = useState(false);
  const [externalEditRevision, setExternalEditRevision] = useState(0);
  const [taskVoiceNotice, setTaskVoiceNotice] = useState<string | null>(null);
  const [cleanupNotice, setCleanupNotice] = useState<string | null>(null);
  const [summaryPlayback, setSummaryPlayback] =
    useState<SummaryArtifact | null>(null);
  const [summaryArtifact, setSummaryArtifact] =
    useState<SummaryArtifact | null>(null);
  const [metadataNotice, setMetadataNotice] = useState<string | null>(null);

  function handleNoteUpdated(updated: NoteDetail) {
    setNote(updated);
    router.refresh();
  }

  function handleExternalNoteUpdate(updated: NoteDetail) {
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
      <NoteTags
        disabled={editorDirty}
        key={`tags:${note.id}:${note.category ?? ""}:${JSON.stringify(note.tags)}`}
        llmError={llmError}
        llmStatus={llmStatus}
        note={note}
        onApplied={setMetadataNotice}
        onNoteUpdated={handleNoteUpdated}
      />
      {metadataNotice ? (
        <p
          aria-live="polite"
          className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-950"
          data-testid="metadata-applied"
        >
          {metadataNotice}
        </p>
      ) : null}
      <SummaryAction
        disabled={editorDirty}
        key={`summary:${note.version}`}
        llmError={llmError}
        llmStatus={llmStatus}
        note={note}
        onNoteUpdated={handleExternalNoteUpdate}
        onReadSummary={setSummaryPlayback}
        onSummaryChange={setSummaryArtifact}
      />
      <TaskSuggestions
        disabled={editorDirty}
        llmError={llmError}
        llmStatus={llmStatus}
        note={note}
        onNoteUpdated={handleExternalNoteUpdate}
      />
      <AudioPlayer
        disabled={editorDirty}
        note={note}
        providerError={providerError}
        providerStatus={providerStatus}
        summary={
          summaryPlayback?.noteId === note.id &&
          summaryPlayback.noteVersion === note.version
            ? summaryPlayback
            : null
        }
        summaryArtifact={
          summaryArtifact?.noteId === note.id ? summaryArtifact : null
        }
        onVoiceSummary={setSummaryPlayback}
      />
      <TaskVoiceControls
        disabled={editorDirty}
        key={`tasks:${externalEditRevision}`}
        note={note}
        onApplied={setTaskVoiceNotice}
        onNoteUpdated={handleExternalNoteUpdate}
      />
      {taskVoiceNotice ? (
        <p
          aria-live="polite"
          className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-950"
          data-testid="task-voice-applied"
        >
          {taskVoiceNotice}
        </p>
      ) : null}
      <CleanupAction
        disabled={editorDirty}
        key={`cleanup:${note.version}`}
        llmError={llmError}
        llmStatus={llmStatus}
        note={note}
        onApplied={setCleanupNotice}
        onNoteUpdated={handleExternalNoteUpdate}
      />
      {cleanupNotice ? (
        <p
          aria-live="polite"
          className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-950"
          data-testid="cleanup-applied"
        >
          {cleanupNotice}
        </p>
      ) : null}
      <AiEditControls
        disabled={editorDirty}
        key={`ai:${note.version}`}
        llmError={llmError}
        llmStatus={llmStatus}
        note={note}
        onNoteUpdated={handleExternalNoteUpdate}
      />
      <ManualProposalPanel
        disabled={editorDirty}
        key={note.version}
        noteId={note.id}
        noteTitle={note.title}
        noteVersion={note.version}
        onNoteUpdated={handleExternalNoteUpdate}
      />
      <RevisionHistory
        disabled={editorDirty}
        key={`history:${note.version}`}
        noteId={note.id}
        noteVersion={note.version}
        onNoteUpdated={handleExternalNoteUpdate}
      />
    </>
  );
}
