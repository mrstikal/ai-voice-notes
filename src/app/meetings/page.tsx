import type { Metadata } from "next";

import {
  getLlmProviderStatus,
  type LlmProviderStatus,
} from "@/lib/ai/structured";
import { MeetingRecorder } from "@/components/meetings/MeetingRecorder";
import { MeetingSuggestions } from "@/components/meetings/MeetingSuggestions";
import { loadConfig } from "@/lib/config";
import {
  listSavedMeetingNotes,
  type SavedMeetingNote,
} from "@/lib/meetings/suggestions";
import { MEETING_AUDIO_MAX_BYTES } from "@/lib/security/http";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Zápis ze schůzky",
};

export default async function MeetingsPage() {
  const config = loadConfig();
  let llmStatus: LlmProviderStatus | null = null;
  let llmError: string | null = null;
  let savedNotes: SavedMeetingNote[] = [];
  let savedNotesError: string | null = null;

  try {
    llmStatus = getLlmProviderStatus();
  } catch {
    llmError =
      "Stav AI návrhů se nepodařilo načíst. Uložený přepis můžete dál číst a upravovat ručně.";
  }

  try {
    savedNotes = await listSavedMeetingNotes();
  } catch {
    savedNotesError =
      "Uložené schůzky se nepodařilo načíst. Nahrávání a přepis fungují dál.";
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-3xl font-semibold tracking-tight text-stone-950">
        Zápis ze schůzky
      </h1>
      <p className="mt-3 max-w-2xl leading-7 text-stone-600">
        Nahrajte schůzku mikrofonem nebo vyberte lokální audio soubor. Server
        ověří skutečný typ a délku (MP3, WAV nebo WebM-Opus) a omezí nahrávku
        na {config.meetingMaxMinutes} minut a 25 MiB. Po výslovném potvrzení
        ceny můžete nahrávku přepsat přes ElevenLabs Scribe v2 (batch) a po
        kontrole přepis uložit jako poznámku. U uložené schůzky lze vyžádat
        české shrnutí, rozhodnutí a úkoly; vše se mění jen přes viditelný diff
        a potvrzení.
      </p>
      <MeetingRecorder
        llmError={llmError}
        llmStatus={llmStatus}
        maxBytes={MEETING_AUDIO_MAX_BYTES}
        maxMinutes={config.meetingMaxMinutes}
      />

      {savedNotesError ? (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          {savedNotesError}
        </p>
      ) : null}

      <MeetingSuggestions
        llmError={llmError}
        llmStatus={llmStatus}
        savedNotes={savedNotes.map((note) => ({
          noteId: note.noteId,
          label:
            note.total > 1
              ? `${note.title} (část ${note.part}/${note.total})`
              : note.title,
        }))}
      />
    </div>
  );
}
