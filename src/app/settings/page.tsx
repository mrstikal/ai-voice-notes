import type { Metadata } from "next";

import { LlmSettings } from "@/components/settings/LlmSettings";
import { SpokenStopSettings } from "@/components/settings/SpokenStopSettings";
import { TtsCacheSettings } from "@/components/settings/TtsCacheSettings";
import { TtsSettings } from "@/components/settings/TtsSettings";
import { UsageSettings } from "@/components/settings/UsageSettings";
import { VoiceSettings } from "@/components/settings/VoiceSettings";
import {
  getLlmProviderStatus,
  type LlmProviderStatus,
} from "@/lib/ai/structured";
import {
  getTtsProviderStatus,
  type TtsProviderStatus,
} from "@/lib/tts/provider";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Nastavení",
};

export default async function SettingsPage() {
  let ttsStatus: TtsProviderStatus | null = null;
  let ttsError: string | null = null;
  let llmStatus: LlmProviderStatus | null = null;
  let llmError: string | null = null;

  try {
    ttsStatus = getTtsProviderStatus();
  } catch {
    ttsError =
      "Stav čtení nahlas se nepodařilo načíst. Zkontrolujte konfiguraci aplikace.";
  }

  try {
    llmStatus = getLlmProviderStatus();
  } catch {
    llmError =
      "Stav strukturovaných AI úprav se nepodařilo načíst. Zkontrolujte konfiguraci aplikace.";
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-800">
        Soukromí a náklady
      </p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-stone-950">
        Nastavení
      </h1>
      <UsageSettings />
      <div className="mt-6">
        <VoiceSettings />
      </div>
      <div className="mt-6">
        <TtsSettings error={ttsError} status={ttsStatus} />
      </div>
      <div className="mt-6">
        <LlmSettings error={llmError} status={llmStatus} />
      </div>
      <div className="mt-6">
        <SpokenStopSettings />
      </div>
      <div className="mt-6">
        <TtsCacheSettings />
      </div>
    </div>
  );
}
