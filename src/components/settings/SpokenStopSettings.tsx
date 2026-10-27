"use client";

import { useSyncExternalStore } from "react";

import {
  MICROPHONE_SESSION_MAX_MS,
} from "@/lib/voice/microphone";
import {
  formatStopMonitorDelay,
  getStopMonitorPreferenceServerSnapshot,
  getStopMonitorPreferenceSnapshot,
  getStopMonitorStatsServerSnapshot,
  getStopMonitorStatsSnapshot,
  resetStopMonitorStats,
  subscribeStopMonitorPreference,
  subscribeStopMonitorStats,
  writeStopMonitorPreference,
} from "@/lib/voice/stop-monitor";

export function SpokenStopSettings() {
  const enabled = useSyncExternalStore(
    subscribeStopMonitorPreference,
    getStopMonitorPreferenceSnapshot,
    getStopMonitorPreferenceServerSnapshot,
  );
  const stats = useSyncExternalStore(
    subscribeStopMonitorStats,
    getStopMonitorStatsSnapshot,
    getStopMonitorStatsServerSnapshot,
  );

  return (
    <section
      aria-labelledby="spoken-stop-settings-heading"
      className="rounded-2xl border border-stone-200 bg-white p-6"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2
            className="text-xl font-semibold text-stone-950"
            id="spoken-stop-settings-heading"
          >
            Experimentální hlasový Stop
          </h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            Volitelné poslouchání samostatného příkazu „stop“ během čtení
            nahlas. Ve výchozím stavu je vypnuté. Jde o experimentální funkci:
            úspěšnost není zaručená a tlačítko Stop funguje vždy.
          </p>
        </div>
        <span
          className={
            enabled
              ? "rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-950"
              : "rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-700"
          }
          data-testid="stop-monitor-state"
        >
          {enabled ? "Zapnuto v tomto prohlížeči" : "Vypnuto"}
        </span>
      </div>

      <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
        <p className="font-semibold">Co zapnutí znamená</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            Během přehrávání se dočasně otevře mikrofon a vytvoří se relace
            ElevenLabs Scribe v2 Realtime, max.{" "}
            {MICROPHONE_SESSION_MAX_MS / 1000} s. Každé takové přehrávání
            mintí nový token a rezervuje v evidenci využití až 0,0195 USD;
            skutečná cena může být neznámá a není to limit poskytovatele.
          </li>
          <li>
            Poslouchá se jen samostatné slovo „stop“. Krátké slovo se po
            chvíli nechá Scribe potvrdit; přehrávání se zastaví až
            z potvrzeného segmentu. Ostatní řeč se nikam neukládá, nepředává
            do poznámky a nezobrazuje se jako přepis.
          </li>
          <li>
            Ukládají se pouze souhrnné počty pokusů, úspěchů a nejpomalejší
            naměřená prodleva. Neukládá se zvuk ani přepis.
          </li>
          <li>
            Prohlížeč používá potlačení ozvu (echo cancellation) a šumu.
            Doporučujeme sluchátka, aby zvuk z reproduktorů nerušil příkaz.
          </li>
          <li>
            Pokud mikrofon používá jiný režim nebo jiná karta, hlasový Stop se
            odmítne. Přehrávání může pokračovat bez monitoru a druhý režim může
            zachytit zvuk čtení. Tlačítko Stop zůstává plně funkční.
          </li>
          <li>
            Mikrofon se ukončí při Stopu, dokončení přehrávání, chybě nebo
            opuštění stránky. Po pozastavení zůstává monitor aktivní, dokud
            přehrávání neskončí nebo ho nezastavíte.
          </li>
        </ul>
      </div>

      <label className="mt-4 flex items-start gap-3 rounded-xl border border-stone-200 p-4 text-sm leading-6 text-stone-800">
        <input
          checked={enabled}
          className="mt-1"
          data-testid="stop-monitor-toggle"
          onChange={(event) =>
            writeStopMonitorPreference(event.target.checked)
          }
          type="checkbox"
        />
        <span>
          <strong>Povolit experimentální hlasový Stop.</strong> Zapnutí je
          dobrovolné a vztahuje se jen na tento prohlížeč. Rozumím, že se
          během přehrávání otevře mikrofon a vytvoří se placená relace Scribe.
        </span>
      </label>

      <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
        <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
          <dt className="font-medium text-stone-700">Pokusy</dt>
          <dd className="mt-1 text-stone-950">
            {stats.attempts.toLocaleString("cs-CZ")}
          </dd>
        </div>
        <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
          <dt className="font-medium text-stone-700">Úspěšné příkazy</dt>
          <dd className="mt-1 text-stone-950">
            {stats.successes.toLocaleString("cs-CZ")}
          </dd>
        </div>
        <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
          <dt className="font-medium text-stone-700">
            Nejpomalejší prodleva od konce řeči k příkazu
          </dt>
          <dd className="mt-1 text-stone-950">
            {formatStopMonitorDelay(stats.slowestDelayMs)}
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          onClick={resetStopMonitorStats}
          type="button"
        >
          Vynulovat statistiky hlasového Stopu
        </button>
        <span className="text-xs leading-5 text-stone-500">
          Souhrnná čísla zůstávají jen v tomto prohlížeči. Deset
          headsetových zkoušek je samostatný ruční test, ne automatická
          záruka.
        </span>
      </div>
    </section>
  );
}
