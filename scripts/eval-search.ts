import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  assertEvaluationTargets,
  loadTestEnvironment,
} from "./test-db-guard.ts";
import { SEED_FIXTURES } from "./seed-fixtures.ts";
import {
  CZECH_SEARCH_EVALUATION_QUERIES,
  type CzechSearchEvaluationQuery,
} from "../tests/fixtures/czech-search.ts";
import { createDatabase } from "../src/lib/db/client.ts";
import {
  EMBEDDING_MODEL_ID,
  EMBEDDING_QUERY_OPERATION,
  EMBEDDING_QUERY_REQUEST_KIND,
  estimateEmbeddingMaxCostUsd,
  getEmbeddingService,
  type EmbeddingService,
} from "../src/lib/search/embeddings.ts";
import { searchNotesFullText } from "../src/lib/search/fts.ts";
import {
  HYBRID_COMPONENT_LIMIT,
  HYBRID_RESULT_LIMIT,
  fuseHybridResults,
} from "../src/lib/search/hybrid.ts";
import { searchNotesSemantic } from "../src/lib/search/semantic.ts";

type EvaluationMode = "text" | "semantic" | "hybrid";

interface EvaluationOptions {
  readonly testDb: boolean;
  readonly mode: EvaluationMode;
  readonly approveCost: number | null;
}

interface EvaluationRow {
  readonly id: string;
  readonly query: string;
  readonly expectedKeys: readonly string[];
  readonly rank: number | null;
  readonly topKeys: readonly string[];
  readonly elapsedMs: number;
}

interface SeedNote {
  readonly id: string;
  readonly seed_key: string;
}

const USAGE = `Použití: pnpm eval:search --test-db [--mode=text|semantic|hybrid] [--approve-cost=USD]

  --test-db            povinné; pracuje pouze s TEST_DATABASE_URL
  --mode=text          výchozí; offline fulltext, bez providera
  --mode=semantic      placené; vyžaduje ready vektory a --approve-cost
  --mode=hybrid        placené; vyžaduje ready vektory a --approve-cost`;

function parseOptions(argv: readonly string[]): EvaluationOptions {
  let testDb = false;
  let mode: EvaluationMode = "text";
  let approveCost: number | null = null;

  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      console.log(USAGE);
      process.exit(0);
    }

    if (argument === "--test-db") {
      testDb = true;
      continue;
    }

    if (argument.startsWith("--mode=")) {
      const value = argument.slice("--mode=".length);

      if (value !== "text" && value !== "semantic" && value !== "hybrid") {
        throw new Error("--mode musí být text, semantic nebo hybrid.");
      }

      mode = value;
      continue;
    }

    if (argument.startsWith("--approve-cost=")) {
      const value = Number(argument.slice("--approve-cost=".length));

      if (!Number.isFinite(value) || value < 0) {
        throw new Error("--approve-cost musí být nezáporné číslo v USD.");
      }

      approveCost = value;
      continue;
    }

    throw new Error(`Neznámý argument: ${argument}\n\n${USAGE}`);
  }

  if (!testDb) {
    throw new Error("Chybí --test-db. Evaluátor nikdy neběží nad vývojovou databází.");
  }

  if (mode === "text" && approveCost !== null) {
    throw new Error("Textový režim je offline a cenu neschvaluje.");
  }

  if (mode !== "text" && approveCost === null) {
    throw new Error(
      "Placený režim vyžaduje čerstvé schválení ceny přes --approve-cost=USD.",
    );
  }

  return { testDb, mode, approveCost };
}

async function loadSeedNotes(
  connection: ReturnType<typeof createDatabase>,
): Promise<Map<string, string>> {
  const result = await connection.pool.query<SeedNote>(
    `SELECT id, seed_key
     FROM notes
     WHERE seed_key LIKE 'demo-v1:%' AND deleted_at IS NULL
     ORDER BY seed_key`,
  );

  const presentKeys = new Set(result.rows.map((row) => row.seed_key));
  const missingKeys = SEED_FIXTURES.map((fixture) => fixture.key).filter(
    (key) => !presentKeys.has(key),
  );

  if (missingKeys.length > 0) {
    throw new Error(
      `Chybí testovací fixtures: ${missingKeys.join(", ")}. Spusťte NODE_ENV=test pnpm db:seed; evaluátor sám neseeduje ani nemaže poznámky.`,
    );
  }

  if (result.rows.length > SEED_FIXTURES.length) {
    console.warn(
      `Pozor: databáze obsahuje ${result.rows.length} seed poznámek, očekáváno ${SEED_FIXTURES.length}. Hodnocení filtruje pouze demo-v1:* výsledky.`,
    );
  }

  return new Map(result.rows.map((row) => [row.id, row.seed_key]));
}

async function loadReadySeedKeys(
  connection: ReturnType<typeof createDatabase>,
): Promise<Set<string>> {
  const result = await connection.pool.query<{ seed_key: string }>(
    `SELECT DISTINCT n.seed_key
     FROM note_chunks AS c
     JOIN notes AS n ON n.id = c.note_id
     WHERE n.seed_key LIKE 'demo-v1:%'
       AND n.deleted_at IS NULL
       AND c.note_version = n.version
       AND c.status = 'ready'
       AND c.model = $1
       AND c.embedding IS NOT NULL`,
    [EMBEDDING_MODEL_ID],
  );

  return new Set(result.rows.map((row) => row.seed_key));
}

function seedRankedIds(
  items: readonly { readonly id: string }[],
  seedKeyById: ReadonlyMap<string, string>,
): string[] {
  return items
    .map((item) => seedKeyById.get(item.id))
    .filter((key): key is string => key !== undefined);
}

function rankExpected(
  rankedSeedKeys: readonly string[],
  fixture: CzechSearchEvaluationQuery,
  maxRank: number,
): number | null {
  const expected = new Set(fixture.expectedSeedKeys);
  const limited = rankedSeedKeys.slice(0, maxRank);
  const index = limited.findIndex((key) => expected.has(key));

  return index === -1 ? null : index + 1;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * fraction)),
  );

  return sorted[index] ?? 0;
}

async function runTextRanking(
  connection: ReturnType<typeof createDatabase>,
  fixture: CzechSearchEvaluationQuery,
): Promise<readonly { readonly id: string }[]> {
  const page = await searchNotesFullText(connection.db, {
    page: 1,
    query: fixture.query,
  });

  return page.items;
}

export function fuseHybridEvaluation(
  textItems: Parameters<typeof fuseHybridResults>[0],
  semanticItems: Parameters<typeof fuseHybridResults>[1],
  seedKeyById: ReadonlyMap<string, string>,
): ReturnType<typeof fuseHybridResults> {
  return fuseHybridResults(
    textItems.slice(0, HYBRID_COMPONENT_LIMIT),
    semanticItems.slice(0, HYBRID_COMPONENT_LIMIT),
    HYBRID_RESULT_LIMIT,
  ).filter((item) => seedKeyById.has(item.id));
}

async function runHybridRanking(
  connection: ReturnType<typeof createDatabase>,
  fixture: CzechSearchEvaluationQuery,
  seedKeyById: ReadonlyMap<string, string>,
  vector: readonly number[],
): Promise<readonly { readonly id: string }[]> {
  const firstTextPage = await searchNotesFullText(connection.db, {
    page: 1,
    query: fixture.query,
  });
  const textItems = [...firstTextPage.items];

  if (firstTextPage.hasNext) {
    const secondTextPage = await searchNotesFullText(connection.db, {
      page: 2,
      query: fixture.query,
    });
    textItems.push(...secondTextPage.items);
  }

  const firstSemanticPage = await searchNotesSemantic(connection.db, {
    query: fixture.query,
    page: 1,
    vector,
    modelId: EMBEDDING_MODEL_ID,
  });
  const semanticItems = [...firstSemanticPage.items];

  if (firstSemanticPage.hasNext) {
    const secondSemanticPage = await searchNotesSemantic(connection.db, {
      query: fixture.query,
      page: 2,
      vector,
      modelId: EMBEDDING_MODEL_ID,
    });
    semanticItems.push(...secondSemanticPage.items);
  }

  return fuseHybridEvaluation(textItems, semanticItems, seedKeyById);
}

async function main(): Promise<void> {
  if (process.env.NEXT_PHASE === "phase-production-build") {
    throw new Error("Evaluátor se nesmí spouštět během produkčního buildu.");
  }

  const options = parseOptions(process.argv.slice(2));

  loadTestEnvironment();

  const targets = assertEvaluationTargets();

  if (options.mode !== "text") {
    // Paid evaluation is isolated to the test DB and must not use the
    // NODE_ENV=test OpenRouter transport block.
    const mutableEnv = process.env as Record<string, string | undefined>;

    mutableEnv.DATABASE_URL = targets.testUrl;
    mutableEnv.NODE_ENV = "production";
  }
  const connection = createDatabase(targets.testUrl);

  try {
    const seedKeyById = await loadSeedNotes(connection);
    const allQueries = CZECH_SEARCH_EVALUATION_QUERIES;
    let embedder: EmbeddingService | null = null;

    if (options.mode !== "text") {
      const readyKeys = await loadReadySeedKeys(connection);
      const missingReady = [
        ...new Set(
          allQueries.flatMap((fixture) => fixture.expectedSeedKeys),
        ),
      ].filter((key) => !readyKeys.has(key));

      if (missingReady.length > 0) {
        throw new Error(
          `Placené hodnocení vyžaduje ready vektory pro všechny očekávané fixtures (${missingReady.join(", ")}). Nejprve je připravte explicitní P36 reindexací; evaluátor vektory sám nevytváří.`,
        );
      }

      const estimate = allQueries.reduce(
        (total, fixture) =>
          total + estimateEmbeddingMaxCostUsd([fixture.query]),
        0,
      );

      console.log(
        `Placený režim ${options.mode}: odhad nejvýše ${estimate.toFixed(6)} USD za ${allQueries.length} dotazových embeddingů; schváleno ${options.approveCost?.toFixed(6)} USD.`,
      );

      if ((options.approveCost ?? 0) + 1e-9 < estimate) {
        throw new Error(
          `Schválená cena ${options.approveCost?.toFixed(6)} USD je nižší než odhad ${estimate.toFixed(6)} USD.`,
        );
      }

      embedder = getEmbeddingService({
        operation: EMBEDDING_QUERY_OPERATION,
        requestKind: EMBEDDING_QUERY_REQUEST_KIND,
      });
    }

    const rows: EvaluationRow[] = [];

    for (const fixture of allQueries) {
      const started = performance.now();
      let rankedSeedKeys: readonly string[];

      if (options.mode === "text") {
        const items = await runTextRanking(connection, fixture);
        rankedSeedKeys = seedRankedIds(items, seedKeyById);
      } else {
        const embedded = await embedder?.embed([fixture.query]);

        if (!embedded?.vectors[0]) {
          throw new Error(
            `Dotaz ${fixture.id}: poskytovatel nevrátil vektor.`,
          );
        }

        if (options.mode === "semantic") {
          const page = await searchNotesSemantic(connection.db, {
            query: fixture.query,
            page: 1,
            vector: embedded.vectors[0],
            modelId: EMBEDDING_MODEL_ID,
          });
          rankedSeedKeys = seedRankedIds(page.items, seedKeyById);
        } else {
          const fused = await runHybridRanking(
            connection,
            fixture,
            seedKeyById,
            embedded.vectors[0],
          );
          rankedSeedKeys = seedRankedIds(fused, seedKeyById);
        }
      }

      const elapsedMs = performance.now() - started;
      const rank = rankExpected(rankedSeedKeys, fixture, 5);
      const row: EvaluationRow = {
        id: fixture.id,
        query: fixture.query,
        expectedKeys: fixture.expectedSeedKeys,
        rank,
        topKeys: rankedSeedKeys.slice(0, 5),
        elapsedMs,
      };

      rows.push(row);

      console.log(
        `${row.id} rank=${row.rank ?? "miss"} query="${row.query}" expected=${row.expectedKeys.join(",")} top=${row.topKeys.join(",") || "-"} ${row.elapsedMs.toFixed(1)}ms`,
      );
    }

    const count = rows.length;
    const hit1 =
      rows.filter((row) => row.rank === 1).length / count;
    const hit3 =
      rows.filter((row) => row.rank !== null && row.rank <= 3).length /
      count;
    const mrr5 =
      rows.reduce((sum, row) => sum + (row.rank === null ? 0 : 1 / row.rank), 0) /
      count;
    const latencies = rows.map((row) => row.elapsedMs);
    const averageMs =
      latencies.reduce((sum, value) => sum + value, 0) / latencies.length;
    const medianMs = percentile(latencies, 0.5);
    const maxMs = Math.max(...latencies);
    const misses = rows.filter((row) => row.rank === null);

    console.log(
      `Souhrn: mode=${options.mode} queries=${count} hit@1=${hit1.toFixed(3)} hit@3=${hit3.toFixed(3)} mrr@5=${mrr5.toFixed(3)} latency avg=${averageMs.toFixed(1)}ms p50=${medianMs.toFixed(1)}ms max=${maxMs.toFixed(1)}ms misses=${misses.length}`,
    );
    console.log(
      `RESULT_JSON=${JSON.stringify({
        mode: options.mode,
        queries: count,
        hitAt1: Number(hit1.toFixed(3)),
        hitAt3: Number(hit3.toFixed(3)),
        mrrAt5: Number(mrr5.toFixed(3)),
        latencyAverageMs: Number(averageMs.toFixed(1)),
        latencyP50Ms: Number(medianMs.toFixed(1)),
        latencyMaxMs: Number(maxMs.toFixed(1)),
        misses: misses.map((row) => ({
          id: row.id,
          query: row.query,
          expectedSeedKeys: row.expectedKeys,
          topSeedKeys: row.topKeys,
        })),
      })}`,
    );
  } finally {
    await connection.pool.end().catch(() => undefined);
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Hodnocení selhalo.");
    process.exit(1);
  });
}
