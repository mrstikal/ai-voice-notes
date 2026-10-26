import type { Metadata } from "next";

import { ScribeDiagnostic } from "@/components/voice/ScribeDiagnostic";

export const metadata: Metadata = {
  title: "Diagnostika diktování",
};

export default function VoiceDiagnosticPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-800">
        Diagnostika mikrofonu
      </p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-stone-950">
        Diktování přes Scribe
      </h1>
      <p className="mt-4 max-w-2xl leading-7 text-stone-700">
        Tato stránka ověřuje výhradní přístup k mikrofonu a český přepis od
        ElevenLabs. Nepracuje s poznámkami a přepis neukládá. Start vždy
        vyžaduje nový token a nové potvrzení uživatelem.
      </p>
      <ScribeDiagnostic />
    </div>
  );
}
