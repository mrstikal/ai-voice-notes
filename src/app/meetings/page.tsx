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
        Nahrajte schůzku mikrofonem nebo vyberte lokální audio soubor. V této
        fázi jde pouze o bezpečné omezení velikosti a dočasné přijetí souboru;
        přepis, ověření typu a délky i vytvoření poznámky přijdou v dalších
        fázích.
      </p>
      <MeetingRecorder
        maxBytes={MEETING_AUDIO_MAX_BYTES}
        maxMinutes={config.meetingMaxMinutes}
      />
    </div>
  );
}
