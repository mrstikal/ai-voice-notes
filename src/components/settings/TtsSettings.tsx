import { formatUsdAmount } from "@/lib/ai/usage-format";
import type { TtsProviderStatus } from "@/lib/tts/provider";

const availabilityLabels: Record<
  TtsProviderStatus["voices"][number]["availability"],
  string
> = {
  available: "ověřený pro účet",
  live_unverified: "live unverified",
  unavailable: "nedostupný pro účet",
};

interface TtsSettingsProps {
  readonly status: TtsProviderStatus | null;
  readonly error: string | null;
}

export function TtsSettings({ status, error }: TtsSettingsProps) {
  return (
    <section
      aria-labelledby="tts-settings-heading"
      className="rounded-2xl border border-stone-200 bg-white p-6"
    >
      <h2
        className="text-xl font-semibold text-stone-950"
        id="tts-settings-heading"
      >
        Čtení nahlas (OpenRouter)
      </h2>

      {error ? (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-900">
          {error}
        </p>
      ) : null}

      {status ? (
        <>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
              <dt className="font-medium text-stone-700">Model</dt>
              <dd className="mt-1 break-all text-stone-950">{status.model}</dd>
            </div>
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
              <dt className="font-medium text-stone-700">Formát</dt>
              <dd className="mt-1 text-stone-950">
                {status.responseFormat.toUpperCase()}
              </dd>
            </div>
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
              <dt className="font-medium text-stone-700">Limit požadavku</dt>
              <dd className="mt-1 text-stone-950">
                {status.maxInputCodeUnits.toLocaleString("cs-CZ")} znaků
                (UTF-16)
              </dd>
            </div>
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
              <dt className="font-medium text-stone-700">
                Odhad ceny jednoho požadavku
              </dt>
              <dd className="mt-1 text-stone-950">
                až {formatUsdAmount(String(status.estimatedMaxCostUsd))}
              </dd>
            </div>
          </dl>

          <div className="mt-4">
            <h3 className="text-sm font-semibold text-stone-900">
              Hlasy a ověření
            </h3>
            <ul className="mt-2 space-y-2 text-sm text-stone-700">
              {status.voices.map((voice) => (
                <li
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-stone-200 px-3 py-2"
                  key={voice.id}
                >
                  <span>
                    {voice.label}{" "}
                    <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">
                      {voice.id}
                    </code>
                  </span>
                  <span
                    className={
                      voice.availability === "available"
                        ? "font-medium text-emerald-800"
                        : voice.availability === "unavailable"
                          ? "font-medium text-red-800"
                          : "font-medium text-amber-900"
                    }
                  >
                    {availabilityLabels[voice.availability]}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <p className="mt-4 text-sm leading-6 text-stone-600">
            {status.configured
              ? "OpenRouter API klíč je nastavený pouze na serveru."
              : "OpenRouter API klíč není nastavený; čtení nahlas zůstává vypnuté."}{" "}
            Dvouhlasové ověření je{" "}
            <strong>
              {status.liveStatus === "verified"
                ? "ověřené"
                : "live unverified"}
            </strong>
            . Živý výběr hlasu se nezapíná před samostatně povoleným poslechem
            české věty v Sarah a George. Klíč se nikdy neposílá do prohlížeče.
          </p>
          <p className="mt-2 text-xs leading-5 text-stone-500">
            Cena je odhad pro místní rozpočet, ne limit poskytovatele. Neznámá
            nebo nejistá cena se nevykazuje jako nula.
          </p>
        </>
      ) : null}
    </section>
  );
}
