import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { loadConfig } from "../config.ts";
import * as schema from "./schema.ts";

export type AppDatabase = NodePgDatabase<typeof schema>;

export interface DatabaseConnection {
  db: AppDatabase;
  pool: Pool;
}

export function createDatabase(databaseUrl: string): DatabaseConnection {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
  });

  return {
    db: drizzle(pool, { schema }),
    pool,
  };
}

let connection: DatabaseConnection | undefined;

export function getDb(): AppDatabase {
  if (!connection) {
    if (process.env.NODE_ENV === "test") {
      const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

      if (!testDatabaseUrl) {
        throw new Error(
          "V testovacím režimu musí být TEST_DATABASE_URL nastavená. Použijte testovací harness.",
        );
      }

      connection = createDatabase(testDatabaseUrl);
    } else {
      const { databaseUrl } = loadConfig();

      if (!databaseUrl) {
        throw new Error(
          "Databáze není nakonfigurovaná. Nastavte DATABASE_URL v .env.local.",
        );
      }

      connection = createDatabase(databaseUrl);
    }
  }

  return connection.db;
}

export function getPool(): Pool {
  getDb();

  if (!connection) {
    throw new Error("Databázové připojení není dostupné.");
  }

  return connection.pool;
}

export async function closeDb(): Promise<void> {
  if (!connection) {
    return;
  }

  const { pool } = connection;
  connection = undefined;
  await pool.end();
}
