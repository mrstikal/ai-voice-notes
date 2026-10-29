import type { Metadata } from "next";

import { MeetingRecorder } from "@/components/meetings/MeetingRecorder";
import { loadConfig } from "@/lib/config";
import { MEETING_AUDIO_MAX_BYTES } from "@/lib/security/http";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Zápis ze schůzky",
};

export default function MeetingsPage() {
  const config = loadConfig();

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-3xl font-semibold tracking-tight text-stone-950">
        Zápis ze schůzky
      </h1>
      <p className="mt-3 max-w-2xl leading-7 text-stone-600">
        Nahrajte schůzku mikrofonem nebo vyberte lokální audio soubor. Server
        ověří skutečný typ a délku (MP3, WAV nebo WebM-Opus) a omezí nahrávku
        na {config.meetingMaxMinutes} minut a 25 MiB. Po výslovném potvrzení
        ceny můžete nahrávku přepsat přes ElevenLabs Scribe v2 (batch). Přepis
        zůstane neuložený v prohlížeči; poznámka se zatím nevytváří.
      </p>
      <MeetingRecorder
        maxBytes={MEETING_AUDIO_MAX_BYTES}
        maxMinutes={config.meetingMaxMinutes}
      />
    </div>
  );
}
