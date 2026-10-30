import type { Metadata } from "next";
import Link from "next/link";

import { GeminiConversation } from "@/components/voice-agent/GeminiConversation";
import {
  GEMINI_LIVE_MODEL_ID,
  GEMINI_LIVE_SESSION_MAX_SECONDS,
} from "@/lib/voice-agent/gemini-session";

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
        Tento režim je oddělený od diktování. Vytváří obousměrnou českou
        hlasovou relaci Gemini Live přes WebSocket. Asistent může vyhledat
        poznámky a přečíst jednu poznámku, kterou v seznamu výslovně vyberete;
        zapisovat do poznámek nesmí. Mikrofon je výhradní, zvuk se neukládá a
        přepis zůstává jen dočasně v paměti stránky.
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
            Provider: Google Gemini Live, model{" "}
            <code className="rounded bg-amber-100 px-1.5 py-0.5">
              {GEMINI_LIVE_MODEL_ID}
            </code>
            , hlas vybíráte před připojením ze seznamu dostupných hlasů.
          </li>
          <li>
            Dlouhodobý klíč zůstává pouze na serveru. Prohlížeč dostane jen
            krátkodobý jednorázový token relace; v prohlížeči není žádný
            dlouhodobý provider klíč.
          </li>
          <li>
            Mikrofon se zapne až po kliknutí na Připojit a je výhradní. Pokud
            diktování, čtení nahlas nebo monitor používá jiná karta, relace se
            nezahájí a zobrazí se česká chyba. Před připojením tyto režimy
            ukončete.
          </li>
          <li>
            Zvuk se neukládá, přepis se nepersistuje do databáze ani do
            úložiště prohlížeče. Volitelné titulky jsou pouze dočasné a zmizí po
            ukončení relace.
          </li>
          <li>
            Maximální délka relace je {GEMINI_LIVE_SESSION_MAX_SECONDS / 60}{" "}
            minut. Prohlížeč ji ukončí nejpozději v tomto limitu uzavřením
            WebSocketu; token je jednorázový a aplikace jej znovu nepoužije.
          </li>
          <li>
            Cena je účtována Google podle skutečného využití. Aplikace ji v této
            fázi neměří ani neomezuje pevným dolarovým stropem; může být
            neznámá. Relaci spouštějte jen vědomě.
          </li>
          <li>
            Bez <code className="rounded bg-amber-100 px-1.5 py-0.5">GEMINI_API_KEY</code>{" "}
            zůstává celá aplikace pro psané poznámky a offline full-textové
            vyhledávání použitelná; tento režim pouze zobrazí chybu.
          </li>
          <li>
            Asistent má pouze dvě čtecí funkce: vyhledání poznámek a přečtení
            jedné poznámky vybrané uživatelem. Náhledy výsledků a obsah vybrané
            poznámky se v rámci relace odešlou Googlu; aplikace je neukládá.
            Zápis, návrhy změn ani potvrzení úprav nejsou dostupné a asistent
            nesmí tvrdit nepotvrzenou změnu poznámky.
          </li>
        </ul>
      </section>

      <GeminiConversation />

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
