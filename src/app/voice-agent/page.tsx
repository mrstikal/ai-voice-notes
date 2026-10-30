import type { Metadata } from "next";
import Link from "next/link";

import { VoiceAgentSession } from "@/components/voice-agent/VoiceAgentSession";
import {
  OPENAI_REALTIME_DEFAULT_VOICE,
  OPENAI_REALTIME_MODEL_ID,
  OPENAI_REALTIME_SESSION_MAX_SECONDS,
} from "@/lib/voice-agent/openai-session";

export const metadata: Metadata = {
  title: "Konverzační asistent",
};

export default function VoiceAgentPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-800">
        Samostatný režim
      </p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-stone-950">
        Konverzační asistent
      </h1>
      <p className="mt-4 max-w-2xl leading-7 text-stone-700">
        Tento režim je oddělený od diktování a od poznámek. Vytváří přímou
        hlasovou relaci OpenAI Realtime přes WebRTC. Zvuk se neukládá jako
        poznámka a přepis se nepersistuje.
      </p>

      <section
        aria-labelledby="voice-agent-disclosure-title"
        className="mt-8 rounded-2xl border border-amber-200 bg-amber-50 p-6"
      >
        <h2
          id="voice-agent-disclosure-title"
          className="text-lg font-semibold text-amber-950"
        >
          Placená relace, soukromí a omezení
        </h2>
        <ul className="mt-3 space-y-2 text-sm leading-6 text-amber-950">
          <li>
            Provider: OpenAI Realtime, model{" "}
            <code className="rounded bg-amber-100 px-1.5 py-0.5">
              {OPENAI_REALTIME_MODEL_ID}
            </code>
            , výchozí hlas{" "}
            <code className="rounded bg-amber-100 px-1.5 py-0.5">
              {OPENAI_REALTIME_DEFAULT_VOICE}
            </code>
            .
          </li>
          <li>
            Dlouhodobý klíč zůstává pouze na serveru. Prohlížeč dostane jen
            SDP odpověď a neprůhledné ID relace.
          </li>
          <li>
            Maximální délka relace je {OPENAI_REALTIME_SESSION_MAX_SECONDS / 60}{" "}
            minut. Prohlížeč relaci ukončí nejpozději v tomto limitu a server
            po něm ID zneplatní. Ukončení samotné relace u OpenAI závisí na
            uzavření WebRTC spojení prohlížečem; aplikace nedrží identifikátor
            provider relace, kterým by ji ukončila sama.
          </li>
          <li>
            Cena je účtována OpenAI podle skutečného využití. Aplikace ji v této
            fázi neměří ani neomezuje pevným dolarovým stropem; může být
            neznámá. Relaci spouštějte jen vědomě.
          </li>
          <li>
            Bez <code className="rounded bg-amber-100 px-1.5 py-0.5">OPENAI_API_KEY</code>{" "}
            zůstává celá aplikace pro psané poznámky a offline full-textové
            vyhledávání použitelná; tento režim pouze zobrazí chybu.
          </li>
          <li>
            Nástroje, čtení poznámek ani zápis do poznámek nejsou v této fázi
            dostupné. Mikrofon se zapne až v navazující fázi.
          </li>
        </ul>
      </section>

      <VoiceAgentSession />

      <p className="mt-8 text-sm leading-6 text-stone-600">
        Potřebujete diktování?{" "}
        <Link
          className="font-medium text-emerald-800 underline underline-offset-4 hover:text-emerald-950"
          href="/notes"
        >
          Otevřete poznámky
        </Link>{" "}
        nebo{" "}
        <Link
          className="font-medium text-emerald-800 underline underline-offset-4 hover:text-emerald-950"
          href="/voice/diagnostic"
        >
          diagnostiku mikrofonu
        </Link>
        .
      </p>
    </div>
  );
}
