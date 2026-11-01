"use client";

import { useState } from "react";

import type { UsageOperationDto, UsageSummaryDto } from "@/lib/ai/usage";
import {
  formatUsageCost,
  formatUsdAmount,
  hasAudioDurationCharge,
} from "@/lib/ai/usage-format";

const dateFormatter = new Intl.DateTimeFormat("cs-CZ", {
  dateStyle: "medium",
  timeStyle: "short",
});

const statusLabels: Record<UsageOperationDto["status"], string> = {
  started: "Probíhá",
  settled: "Vyúčtováno",
  unknown: "Neznámá cena",
};

interface UsageSettingsProps {
  readonly initialSummary: UsageSummaryDto | null;
  readonly initialError: string | null;
}

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { message?: unknown };
    };

    return typeof body.error?.message === "string"
      ? body.error.message
      : fallback;
  } catch {
    return fallback;
  }
}

export function UsageSettings({
  initialSummary,
  initialError,
}: UsageSettingsProps) {
  const [summary, setSummary] = useState(initialSummary);
  const [error, setError] = useState(initialError);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  async function resetUsage() {
    setResetting(true);
    setError(null);
    setResetMessage(null);

    try {
      const response = await fetch("/api/settings/usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: "reset-usage" }),
      });

      if (!response.ok) {
        throw new Error(
          await readErrorMessage(
            response,
            "Evidenci využití se nepodařilo resetovat.",
          ),
        );
      }

      setSummary((await response.json()) as UsageSummaryDto);
      setConfirmingReset(false);
      setResetMessage("Evidence využití byla resetována.");
    } catch (resetError) {
      setError(
        resetError instanceof Error
          ? resetError.message
          : "Evidenci využití se nepodařilo resetovat.",
      );
    } finally {
      setResetting(false);
    }
  }

  return (
    <>
      <section
        aria-labelledby="soukromi"
        className="mt-8 rounded-2xl border border-stone-200 bg-white p-6"
      >
        <h2 id="soukromi" className="text-xl font-semibold text-stone-950">
          Poskytovatelé, soukromí a cena
        </h2>
        <div className="mt-4 space-y-3 leading-7 text-stone-700">
          <p>
            Poznámky jsou uložené pouze v místní databázi. Teprve při výslovném
            spuštění placené AI operace odešle aplikace zvolený text nebo zvuk
            uvedenému poskytovateli. Bez API klíčů zůstávají ručně psané
            poznámky plně použitelné.
          </p>
          <p>
            Místní rozpočet je pouze odhad pro rozhodnutí, zda operaci zahájit.
            Není to limit na straně poskytovatele. Skutečná cena může být jiná a
            silnější limit nastavte přímo u poskytovatele.
          </p>
          <p>
            Neznámá nebo nejistá cena se záměrně nevykazuje jako nula. Zůstává
            jako <strong>Neznámá cena</strong>, dokud ji nelze spolehlivě
            vyúčtovat.
          </p>
        </div>
      </section>

      <section
        aria-labelledby="rozpocet"
        className="mt-8 rounded-2xl border border-stone-200 bg-white p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 id="rozpocet" className="text-xl font-semibold text-stone-950">
              Odhadovaný místní rozpočet
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">
              Rezervace se odečítají před operací. U OpenRouteru se používá cena
              oznámená poskytovatelem; u ElevenLabs Scribe se cena počítá
              z délky odeslaného audia. Nejisté položky zůstávají rezervované
              jako neznámá cena.
            </p>
          </div>
          <button
            className="rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-800 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={
              !summary ||
              summary.activeCount > 0 ||
              resetting ||
              confirmingReset
            }
            onClick={() => setConfirmingReset(true)}
            type="button"
          >
            Resetovat evidenci
          </button>
        </div>

        {error ? (
          <p
            className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        {resetMessage ? (
          <p
            className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
            role="status"
          >
            {resetMessage}
          </p>
        ) : null}

        {summary ? (
          <>
            <dl className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-xl bg-stone-100 p-4">
                <dt className="text-xs font-semibold uppercase tracking-wide text-stone-600">
                  Limit
                </dt>
                <dd className="mt-1 text-lg font-semibold text-stone-950">
                  {formatUsdAmount(summary.budgetUsd)}
                </dd>
              </div>
              <div className="rounded-xl bg-stone-100 p-4">
                <dt className="text-xs font-semibold uppercase tracking-wide text-stone-600">
                  Rezervováno a vyčerpáno
                </dt>
                <dd className="mt-1 text-lg font-semibold text-stone-950">
                  {formatUsdAmount(summary.committedUsd)}
                </dd>
              </div>
              <div className="rounded-xl bg-stone-100 p-4">
                <dt className="text-xs font-semibold uppercase tracking-wide text-stone-600">
                  Zbývá
                </dt>
                <dd className="mt-1 text-lg font-semibold text-stone-950">
                  {formatUsdAmount(summary.remainingUsd)}
                </dd>
              </div>
              <div className="rounded-xl bg-stone-100 p-4">
                <dt className="text-xs font-semibold uppercase tracking-wide text-stone-600">
                  Neznámé položky
                </dt>
                <dd className="mt-1 text-lg font-semibold text-stone-950">
                  {summary.unknownCount}
                </dd>
              </div>
            </dl>

            <p className="mt-4 text-sm text-stone-600">
              Aktivní rezervace: {summary.activeCount}. Vyúčtováno:{" "}
              {formatUsdAmount(summary.reportedUsd)}.
            </p>

            {summary.activeCount > 0 ? (
              <p className="mt-3 text-sm font-medium text-amber-900">
                Reset není dostupný, dokud je aktivní rezervovaná operace.
              </p>
            ) : null}

            {confirmingReset ? (
              <div
                aria-labelledby="potvrdit-reset"
                className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4"
                role="alertdialog"
              >
                <h3 className="font-semibold text-red-950" id="potvrdit-reset">
                  Opravdu resetovat evidenci?
                </h3>
                <p className="mt-2 text-sm leading-6 text-red-900">
                  Odstraní se všechny záznamy o využití a rezervace. Samotné
                  poznámky zůstanou beze změny. Tuto akci nelze vrátit.
                </p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <button
                    className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={resetting}
                    onClick={() => void resetUsage()}
                    type="button"
                  >
                    {resetting ? "Resetuji…" : "Ano, resetovat"}
                  </button>
                  <button
                    className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
                    disabled={resetting}
                    onClick={() => setConfirmingReset(false)}
                    type="button"
                  >
                    Zrušit
                  </button>
                </div>
              </div>
            ) : null}

            <div className="mt-8 overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <caption className="sr-only">
                  Evidence placených operací a rezervací
                </caption>
                <thead>
                  <tr className="border-b border-stone-200 text-xs uppercase tracking-wide text-stone-600">
                    <th className="px-3 py-2 font-semibold">Operace</th>
                    <th className="px-3 py-2 font-semibold">Poskytovatel</th>
                    <th className="px-3 py-2 font-semibold">Stav</th>
                    <th className="px-3 py-2 font-semibold">Rezervace</th>
                    <th className="px-3 py-2 font-semibold">Cena</th>
                    <th className="px-3 py-2 font-semibold">Zahájeno</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.operations.length === 0 ? (
                    <tr>
                      <td className="px-3 py-6 text-stone-600" colSpan={6}>
                        Zatím tu není žádná placená operace.
                      </td>
                    </tr>
                  ) : (
                    summary.operations.map((operation) => {
                      const audioDurationCharge =
                        operation.status === "settled" &&
                        hasAudioDurationCharge(operation.providerUsage);

                      return (
                        <tr
                          className="border-b border-stone-100 align-top"
                          key={operation.id}
                        >
                          <td className="px-3 py-3">
                            <p className="font-medium text-stone-950">
                              {operation.operation}
                            </p>
                            <p className="mt-1 text-xs text-stone-600">
                              {operation.model}
                            </p>
                            {operation.providerUsage !== null ? (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-xs font-medium text-stone-600">
                                  Údaje od poskytovatele
                                </summary>
                                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-stone-100 p-2 text-xs text-stone-800">
                                  {JSON.stringify(
                                    operation.providerUsage,
                                    null,
                                    2,
                                  )}
                                </pre>
                              </details>
                            ) : null}
                          </td>
                          <td className="px-3 py-3 text-stone-700">
                            {operation.provider}
                          </td>
                          <td className="px-3 py-3 text-stone-700">
                            {statusLabels[operation.status]}
                          </td>
                          <td className="px-3 py-3 text-stone-700">
                            {formatUsdAmount(operation.reservedCostUsd)}
                          </td>
                          <td className="px-3 py-3 font-medium text-stone-900">
                            {formatUsageCost(operation)}
                            {audioDurationCharge ? (
                              <span className="mt-1 block text-xs font-normal text-stone-600">
                                Cena z délky audia
                              </span>
                            ) : null}
                          </td>
                          <td className="px-3 py-3 text-stone-700">
                            {dateFormatter.format(
                              new Date(operation.startedAt),
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </section>
    </>
  );
}
