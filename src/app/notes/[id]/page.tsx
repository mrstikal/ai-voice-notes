import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { NoteWorkspace } from "@/components/notes/NoteWorkspace";
import {
  InvalidNoteIdError,
  NoteNotFoundError,
  getNoteService,
} from "@/lib/notes/service";
import { toClientDetail } from "@/lib/notes/view";
import {
  getTtsProviderStatus,
  type TtsProviderStatus,
} from "@/lib/tts/provider";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Detail poznámky",
};

interface NoteDetailPageProps {
  readonly params: Promise<{ id: string }>;
}

export default async function NoteDetailPage({ params }: NoteDetailPageProps) {
  const { id } = await params;

  let note;
  let ttsStatus: TtsProviderStatus | null = null;
  let ttsError: string | null = null;

  try {
    ttsStatus = getTtsProviderStatus();
  } catch {
    ttsError =
      "Stav čtení nahlas se nepodařilo načíst. Zkontrolujte konfiguraci aplikace.";
  }

  try {
    note = await getNoteService().getNote(id);
  } catch (error) {
    if (error instanceof NoteNotFoundError || error instanceof InvalidNoteIdError) {
      notFound();
    }

    throw error;
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <NoteWorkspace
        key={note.id}
        note={toClientDetail(note)}
        providerError={ttsError}
        providerStatus={ttsStatus}
      />
    </div>
  );
}
