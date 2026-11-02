import type { UsageOperationDto } from "./usage.ts";

export function formatUsdAmount(value: string): string {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return "Neznámá cena";
  }

  return `${new Intl.NumberFormat("cs-CZ", {
    maximumFractionDigits: 6,
    minimumFractionDigits: 2,
  }).format(amount)} USD`;
}

export function hasAudioDurationCharge(providerUsage: unknown): boolean {
  return (
    typeof providerUsage === "object" &&
    providerUsage !== null &&
    (providerUsage as { chargeBasis?: unknown }).chargeBasis ===
      "audio_duration"
  );
}

export function hasInputCharacterCharge(providerUsage: unknown): boolean {
  return (
    typeof providerUsage === "object" &&
    providerUsage !== null &&
    (providerUsage as { chargeBasis?: unknown }).chargeBasis ===
      "input_characters"
  );
}

export function formatUsageCost(
  operation: Pick<
    UsageOperationDto,
    "status" | "reservedCostUsd" | "reportedCostUsd"
  >,
): string {
  if (
    operation.status === "unknown" ||
    (operation.status === "settled" && operation.reportedCostUsd === null)
  ) {
    return "Neznámá cena";
  }

  if (operation.status === "settled" && operation.reportedCostUsd !== null) {
    return formatUsdAmount(operation.reportedCostUsd);
  }

  return `Odhad ${formatUsdAmount(operation.reservedCostUsd)}`;
}
