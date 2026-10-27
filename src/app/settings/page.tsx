import type { Metadata } from "next";

import { TtsSettings } from "@/components/settings/TtsSettings";
import { UsageSettings } from "@/components/settings/UsageSettings";
import { VoiceSettings } from "@/components/settings/VoiceSettings";
import { getUsageService, type UsageSummaryDto } from "@/lib/ai/usage";
import {
  getTtsProviderStatus,
  type TtsProviderStatus,
} from "@/lib/tts/provider";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Nastavení",
};

export default async function SettingsPage() {
  let summary: UsageSummaryDto | null = null;
  let error: string | null = null;
  let ttsStatus: TtsProviderStatus | null = null;
  let ttsError: string | null = null;

  try {
    summary = await getUsageService().getSummary();
  } catch {
    error =
      "Evidenci využití se nepodařilo načíst. Zkontrolujte, zda běží databáze a jsou spuštěné migrace.";
  }

  try {
    ttsStatus = getTtsProviderStatus();
  } catch {
    ttsError =
      "Stav čtení nahlas se nepodařilo načíst. Zkontrolujte konfiguraci aplikace.";
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-800">
        Soukromí a náklady
      </p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-stone-950">
        Nastavení
      </h1>
      <UsageSettings initialError={error} initialSummary={summary} />
      <div className="mt-6">
        <VoiceSettings />
      </div>
      <div className="mt-6">
        <TtsSettings error={ttsError} status={ttsStatus} />
      </div>
    </div>
  );
}
