import { formatUsdAmount } from "@/lib/ai/usage-format";
import type { LlmProviderStatus } from "@/lib/ai/structured";

interface LlmSettingsProps {
  readonly status: LlmProviderStatus | null;
  readonly error: string | null;
}

export function LlmSettings({ status, error }: LlmSettingsProps) {
  return (
    <section
      aria-labelledby="llm-settings-heading"
      className="rounded-2xl border border-stone-200 bg-white p-6"
    >
      <h2
        className="text-xl font-semibold text-stone-950"
        id="llm-settings-heading"
      >
        Strukturované AI úpravy (OpenRouter)
      </h2>

      {error ? (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-900">
          {error}
        </p>
      ) : null}

      {status ? (
        <>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            Model vrací pouze striktní JSON-schema operace; server je znovu
            validuje přes Zod. Nic se neaplikuje bez samostatného náhledu a
            potvrzení v pozdější fázi. Neúspěch nebo nejednoznačný timeout se
            automaticky neopakuje.
          </p>

          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
              <dt className="font-medium text-stone-700">Model</dt>
              <dd className="mt-1 break-all text-stone-950">{status.model}</dd>
            </div>
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
              <dt className="font-medium text-stone-700">
                Striktní JSON schema
              </dt>
              <dd className="mt-1 text-stone-950">
                {status.structuredOutputs
                  ? "podporováno kandidátem"
                  : "nepodporováno"}
              </dd>
            </div>
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
              <dt className="font-medium text-stone-700">Limit vstupu</dt>
              <dd className="mt-1 text-stone-950">
                {status.maxInputCodeUnits.toLocaleString("cs-CZ")} znaků
                (UTF-16)
              </dd>
            </div>
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
              <dt className="font-medium text-stone-700">Limit výstupu</dt>
              <dd className="mt-1 text-stone-950">
                {status.maxOutputTokens.toLocaleString("cs-CZ")} tokenů
              </dd>
            </div>
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
              <dt className="font-medium text-stone-700">Timeout</dt>
              <dd className="mt-1 text-stone-950">
                {(status.timeoutMs / 1000).toLocaleString("cs-CZ")} s, bez
                automatického opakování
              </dd>
            </div>
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
              <dt className="font-medium text-stone-700">
                Maximální odhad ceny
              </dt>
              <dd className="mt-1 text-stone-950">
                až {formatUsdAmount(String(status.estimatedMaxCostUsd))}
              </dd>
            </div>
          </dl>

          <p className="mt-4 text-sm leading-6 text-stone-700">
            Kompatibilita poskytovatele je{" "}
            <strong>
              {status.liveStatus === "live_unverified"
                ? "live unverified"
                : "ověřená"}
            </strong>
            . Metadata kandidáta byla ověřena {status.checkedAt}; živý
            strukturovaný požadavek byl ověřen samostatně povoleným testem.
            Cena je odhad pro místní rozpočet, ne limit poskytovatele.
          </p>

          {status.blockedReason ? (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
              {status.blockedReason}
            </p>
          ) : (
            <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm leading-6 text-emerald-950">
              Model a serverový klíč jsou připravené. AI úpravy se v této fázi
              ještě nezobrazují v poznámkách; návazné fáze použijí stejný
              validovaný klient.
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
