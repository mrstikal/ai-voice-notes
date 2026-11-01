import type { ExtractTablesWithRelations } from "drizzle-orm";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";

import { loadConfig } from "../config.ts";
import { readEnvInt } from "../env-limits.ts";
import { getDb, type AppDatabase } from "../db/client.ts";
import { aiBudget, aiUsage } from "../db/schema.ts";
import type * as schema from "../db/schema.ts";

const USD_SCALE = 6;
const MICROS_PER_USD = 1_000_000n;
const MAX_USD_MICROS = 999_999_999_999n;
const MAX_LABEL_LENGTH = 200;
const MAX_PROVIDER_USAGE_BYTES = readEnvInt(
  "MAX_PROVIDER_USAGE_BYTES",
  16 * 1024,
);
const SUMMARY_OPERATION_LIMIT = readEnvInt("SUMMARY_OPERATION_LIMIT", 50);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type UsageExecutor = PgDatabase<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export type UsageStatus = "started" | "settled" | "unknown";

export interface UsageOperationDto {
  readonly id: string;
  readonly operation: string;
  readonly provider: string;
  readonly model: string;
  readonly status: UsageStatus;
  readonly reservedCostUsd: string;
  readonly reportedCostUsd: string | null;
  readonly providerUsage: unknown;
  readonly startedAt: Date;
  readonly settledAt: Date | null;
}

export interface UsageSummaryDto {
  readonly budgetUsd: string;
  readonly committedUsd: string;
  readonly reservedUsd: string;
  readonly reportedUsd: string;
  readonly remainingUsd: string;
  readonly activeCount: number;
  readonly unknownCount: number;
  readonly operations: UsageOperationDto[];
}

export interface ReservationInput {
  readonly operation: string;
  readonly provider: string;
  readonly model: string;
  readonly estimatedMaxCostUsd: number | null;
}

export interface SettlementInput {
  readonly reportedCostUsd: number | null;
  readonly providerUsage?: unknown;
}

export interface SettlementOptions {
  /**
   * Allows a later, bounded correction of an `unknown` row, for example when
   * the provider reports the billed audio duration only after the request.
   */
  readonly allowUnknown?: boolean;
  readonly expectedOperation?: string;
  readonly expectedProvider?: string;
}

export interface UsageServiceOptions {
  readonly db: AppDatabase;
  readonly budgetUsd: number;
}

export interface UsageService {
  reserve(input: ReservationInput): Promise<UsageOperationDto>;
  settle(
    id: string,
    input: SettlementInput,
    options?: SettlementOptions,
  ): Promise<UsageOperationDto>;
  markUnknown(id: string, providerUsage?: unknown): Promise<UsageOperationDto>;
  getSummary(): Promise<UsageSummaryDto>;
  resetUsage(): Promise<{ readonly reset: true }>;
}

export class UsageServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "UsageServiceError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class BudgetExceededError extends UsageServiceError {
  constructor(details: {
    budgetUsd: string;
    committedUsd: string;
    requestedUsd: string;
  }) {
    super(
      402,
      "budget_exceeded",
      "Odhadovaný místní rozpočet by byl překročen. Operace nebyla zahájena.",
      details,
    );
    this.name = "BudgetExceededError";
  }
}

export class PriceUnavailableError extends UsageServiceError {
  constructor() {
    super(
      422,
      "price_unavailable",
      "Maximální cenu operace nelze spolehlivě odhadnout, proto ji aplikace odmítla.",
    );
    this.name = "PriceUnavailableError";
  }
}

export class UsageResetBlockedError extends UsageServiceError {
  constructor(activeCount: number) {
    super(
      409,
      "usage_active",
      "Evidenci nelze resetovat, dokud probíhá aktivní rezervovaná operace.",
      { activeCount },
    );
    this.name = "UsageResetBlockedError";
  }
}

export class UsageNotFoundError extends UsageServiceError {
  constructor() {
    super(404, "usage_not_found", "Záznam o využití nebyl nalezen.");
    this.name = "UsageNotFoundError";
  }
}

export class UsageStateError extends UsageServiceError {
  constructor(status: UsageStatus) {
    super(
      409,
      "usage_conflict",
      "Operace už není ve stavu, který dovoluje tuto změnu.",
      { status },
    );
    this.name = "UsageStateError";
  }
}

export class UsageValidationError extends UsageServiceError {
  constructor(message: string) {
    super(400, "invalid_usage", message);
    this.name = "UsageValidationError";
  }
}

export class UsageConfigurationError extends UsageServiceError {
  constructor() {
    super(
      500,
      "usage_configuration",
      "Rozpočtová evidence není inicializovaná. Spusťte migraci databáze.",
    );
    this.name = "UsageConfigurationError";
  }
}

export { formatUsageCost, formatUsdAmount } from "./usage-format.ts";

export function toUsageErrorResponse(error: unknown): Response {
  if (error instanceof UsageServiceError) {
    return Response.json(
      {
        error: {
          ...error.details,
          code: error.code,
          message: error.message,
        },
      },
      {
        status: error.status,
        headers: { "cache-control": "no-store" },
      },
    );
  }

  return Response.json(
    {
      error: {
        code: "internal_error",
        message: "Požadavek na evidenci využití se nepodařilo zpracovat.",
      },
    },
    { status: 500, headers: { "cache-control": "no-store" } },
  );
}

function usdMicrosFromString(value: string): bigint {
  const normalized = value.trim();

  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) {
    throw new Error("Neplatná částka v evidenci využití.");
  }

  const [whole = "0", fraction = ""] = normalized.split(".");
  return (
    BigInt(whole) * MICROS_PER_USD +
    BigInt((fraction + "0".repeat(USD_SCALE)).slice(0, USD_SCALE))
  );
}

function usdStringFromMicros(micros: bigint): string {
  const sign = micros < 0n ? "-" : "";
  const absolute = micros < 0n ? -micros : micros;
  const whole = absolute / MICROS_PER_USD;
  const fraction = (absolute % MICROS_PER_USD)
    .toString()
    .padStart(USD_SCALE, "0");

  return `${sign}${whole}.${fraction}`;
}

function usdMicrosFromNumber(value: number, field: string): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new UsageValidationError(`${field} musí být nezáporné číslo.`);
  }

  const micros = BigInt(Math.ceil(value * Number(MICROS_PER_USD) - 1e-7));

  if (micros > MAX_USD_MICROS) {
    throw new UsageValidationError(`${field} překračuje povolený rozsah.`);
  }

  return micros;
}

function normalizeLabel(value: string, field: string): string {
  const normalized = value.trim();

  if (normalized === "" || normalized.length > MAX_LABEL_LENGTH) {
    throw new UsageValidationError(
      `${field} musí mít 1 až ${MAX_LABEL_LENGTH} znaků.`,
    );
  }

  return normalized;
}

function normalizeProviderUsage(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }

  let json: string | undefined;

  try {
    json = JSON.stringify(value);
  } catch {
    throw new UsageValidationError("Údaje o využití nejsou serializovatelné.");
  }

  if (json === undefined) {
    throw new UsageValidationError("Údaje o využití nejsou serializovatelné.");
  }

  if (Buffer.byteLength(json, "utf8") > MAX_PROVIDER_USAGE_BYTES) {
    throw new UsageValidationError(
      `Údaje o využití překračují limit ${MAX_PROVIDER_USAGE_BYTES} bajtů.`,
    );
  }

  return JSON.parse(json) as unknown;
}

function assertUsageId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new UsageValidationError("Neplatné ID záznamu o využití.");
  }
}

function asStatus(value: string): UsageStatus {
  if (value === "started" || value === "settled" || value === "unknown") {
    return value;
  }

  throw new Error("Neplatný stav záznamu o využití.");
}

function toOperationDto(row: typeof aiUsage.$inferSelect): UsageOperationDto {
  return {
    id: row.id,
    operation: row.operation,
    provider: row.provider,
    model: row.model,
    status: asStatus(row.status),
    reservedCostUsd: row.reservedCostUsd,
    reportedCostUsd: row.reportedCostUsd,
    providerUsage: row.providerUsage,
    startedAt: row.startedAt,
    settledAt: row.settledAt,
  };
}

interface UsageAggregateRow {
  readonly [key: string]: unknown;
  readonly committed: string;
  readonly reserved: string;
  readonly reported: string;
  readonly active: string;
  readonly unknown: string;
}

interface BudgetRow {
  readonly [key: string]: unknown;
  readonly budget_usd: string;
}

async function lockBudget(
  db: UsageExecutor,
  budgetUsd: string | null,
): Promise<string> {
  if (budgetUsd === null) {
    const result = await db.execute<BudgetRow>(sql`
      SELECT budget_usd::text AS budget_usd
      FROM ai_budget
      WHERE id = 1
      FOR UPDATE
    `);
    const row = result.rows[0];

    if (!row) {
      throw new UsageConfigurationError();
    }

    return row.budget_usd;
  }

  const result = await db.execute<BudgetRow>(sql`
    INSERT INTO ai_budget (id, budget_usd, updated_at)
    VALUES (1, ${budgetUsd}::numeric, now())
    ON CONFLICT (id) DO UPDATE
    SET budget_usd = excluded.budget_usd, updated_at = now()
    RETURNING budget_usd::text AS budget_usd
  `);
  const row = result.rows[0];

  if (!row) {
    throw new Error("Rozpočtový řádek se nepodařilo zajistit.");
  }

  return row.budget_usd;
}

async function readAggregate(db: UsageExecutor): Promise<UsageAggregateRow> {
  const result = await db.execute<UsageAggregateRow>(sql`
    SELECT
      COALESCE(
        SUM(
          CASE
            WHEN status = 'settled'
              THEN COALESCE(reported_cost_usd, reserved_cost_usd)
            ELSE reserved_cost_usd
          END
        ),
        0
      )::text AS committed,
      COALESCE(
        SUM(CASE WHEN status = 'started' THEN reserved_cost_usd ELSE 0 END),
        0
      )::text AS reserved,
      COALESCE(
        SUM(
          CASE
            WHEN status = 'settled'
              THEN COALESCE(reported_cost_usd, 0)
            ELSE 0
          END
        ),
        0
      )::text AS reported,
      COUNT(*) FILTER (WHERE status = 'started')::text AS active,
      COUNT(*) FILTER (WHERE status = 'unknown')::text AS unknown
    FROM ai_usage
  `);
  const row = result.rows[0];

  if (!row) {
    throw new Error("Agregaci využití se nepodařilo načíst.");
  }

  return row;
}

async function readSummary(
  db: AppDatabase,
  budgetUsd: bigint,
): Promise<UsageSummaryDto> {
  const storedBudget = await db.execute<BudgetRow>(sql`
    SELECT budget_usd::text AS budget_usd
    FROM ai_budget
    WHERE id = 1
  `);

  if (!storedBudget.rows[0]) {
    throw new UsageConfigurationError();
  }

  const [aggregate, operations] = await Promise.all([
    readAggregate(db),
    db
      .select()
      .from(aiUsage)
      .orderBy(desc(aiUsage.startedAt))
      .limit(SUMMARY_OPERATION_LIMIT),
  ]);
  const committedMicros = usdMicrosFromString(aggregate.committed);

  return {
    budgetUsd: usdStringFromMicros(budgetUsd),
    committedUsd: usdStringFromMicros(committedMicros),
    reservedUsd: usdStringFromMicros(usdMicrosFromString(aggregate.reserved)),
    reportedUsd: usdStringFromMicros(usdMicrosFromString(aggregate.reported)),
    remainingUsd: usdStringFromMicros(budgetUsd - committedMicros),
    activeCount: Number(aggregate.active),
    unknownCount: Number(aggregate.unknown),
    operations: operations.map(toOperationDto),
  };
}

export async function reconcileInterruptedReservations(
  db: UsageExecutor,
): Promise<number> {
  const rows = await db
    .update(aiUsage)
    .set({ status: "unknown", settledAt: sql`now()` })
    .where(eq(aiUsage.status, "started"))
    .returning({ id: aiUsage.id });

  return rows.length;
}

export function createUsageService(options: UsageServiceOptions): UsageService {
  const db = options.db;
  const budgetMicros = usdMicrosFromNumber(options.budgetUsd, "Rozpočet");
  const budget = usdStringFromMicros(budgetMicros);

  async function finishOperation(
    id: string,
    status: "settled" | "unknown",
    reportedCostUsd: string | null,
    providerUsage: unknown,
    options: SettlementOptions = {},
  ): Promise<UsageOperationDto> {
    assertUsageId(id);

    return db.transaction(async (tx) => {
      await lockBudget(tx, null);
      const conditions = [
        eq(aiUsage.id, id),
        options.allowUnknown
          ? inArray(aiUsage.status, ["started", "unknown"])
          : eq(aiUsage.status, "started"),
      ];

      if (options.expectedOperation) {
        conditions.push(eq(aiUsage.operation, options.expectedOperation));
      }

      if (options.expectedProvider) {
        conditions.push(eq(aiUsage.provider, options.expectedProvider));
      }

      const rows = await tx
        .update(aiUsage)
        .set({
          status,
          reportedCostUsd,
          providerUsage,
          settledAt: sql`now()`,
        })
        .where(and(...conditions))
        .returning();
      const updated = rows[0];

      if (updated) {
        return toOperationDto(updated);
      }

      const existing = await tx
        .select()
        .from(aiUsage)
        .where(eq(aiUsage.id, id))
        .limit(1);
      const row = existing[0];

      if (
        !row ||
        (options.expectedOperation &&
          row.operation !== options.expectedOperation) ||
        (options.expectedProvider &&
          row.provider !== options.expectedProvider)
      ) {
        throw new UsageNotFoundError();
      }

      throw new UsageStateError(asStatus(row.status));
    });
  }

  return {
    async reserve(input) {
      if (input.estimatedMaxCostUsd === null) {
        throw new PriceUnavailableError();
      }

      const requestedMicros = usdMicrosFromNumber(
        input.estimatedMaxCostUsd,
        "Odhadovaná maximální cena",
      );
      const requested = usdStringFromMicros(requestedMicros);
      const operation = normalizeLabel(input.operation, "Operace");
      const provider = normalizeLabel(input.provider, "Poskytovatel");
      const model = normalizeLabel(input.model, "Model");

      return db.transaction(async (tx) => {
        const storedBudget = await lockBudget(tx, budget);
        const storedBudgetMicros = usdMicrosFromString(storedBudget);
        const aggregate = await readAggregate(tx);
        const committedMicros = usdMicrosFromString(aggregate.committed);

        if (committedMicros + requestedMicros > storedBudgetMicros) {
          throw new BudgetExceededError({
            budgetUsd: usdStringFromMicros(storedBudgetMicros),
            committedUsd: usdStringFromMicros(committedMicros),
            requestedUsd: requested,
          });
        }

        const rows = await tx
          .insert(aiUsage)
          .values({
            operation,
            provider,
            model,
            status: "started",
            reservedCostUsd: requested,
          })
          .returning();
        const inserted = rows[0];

        if (!inserted) {
          throw new Error("Rezervaci využití se nepodařilo zapsat.");
        }

        return toOperationDto(inserted);
      });
    },

    async settle(id, input, options) {
      if (input.reportedCostUsd === null) {
        return finishOperation(
          id,
          "unknown",
          null,
          normalizeProviderUsage(input.providerUsage),
          options,
        );
      }

      const reported = usdStringFromMicros(
        usdMicrosFromNumber(input.reportedCostUsd, "Cena od poskytovatele"),
      );

      return finishOperation(
        id,
        "settled",
        reported,
        normalizeProviderUsage(input.providerUsage),
        options,
      );
    },

    async markUnknown(id, providerUsage) {
      return finishOperation(
        id,
        "unknown",
        null,
        normalizeProviderUsage(providerUsage),
      );
    },

    async getSummary() {
      return readSummary(db, budgetMicros);
    },

    async resetUsage() {
      return db.transaction(async (tx) => {
        await lockBudget(tx, budget);
        const aggregate = await readAggregate(tx);
        const activeCount = Number(aggregate.active);

        if (activeCount > 0) {
          throw new UsageResetBlockedError(activeCount);
        }

        await tx.delete(aiUsage);
        await tx
          .update(aiBudget)
          .set({ budgetUsd: budget, updatedAt: sql`now()` })
          .where(eq(aiBudget.id, 1));

        return { reset: true as const };
      });
    },
  };
}

export function getUsageService(): UsageService {
  const config = loadConfig();

  return createUsageService({
    db: getDb(),
    budgetUsd: config.aiRequestBudgetUsd,
  });
}
