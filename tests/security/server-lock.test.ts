import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());
const createDatabaseMock = vi.hoisted(() => vi.fn());
const reconcileMock = vi.hoisted(() => vi.fn());

const pgMock = vi.hoisted(() => ({
  clientConstructor: vi.fn(),
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}));

vi.mock("../../src/lib/config", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../../src/lib/db/client", () => ({
  createDatabase: createDatabaseMock,
}));

vi.mock("../../src/lib/ai/usage", () => ({
  reconcileInterruptedReservations: reconcileMock,
}));

vi.mock("pg", () => ({
  Client: class {
    constructor(options: unknown) {
      pgMock.clientConstructor(options);
    }

    connect = pgMock.connect;
    query = pgMock.query;
    end = pgMock.end;
  },
  Pool: class {},
}));

import { acquireServerLock } from "../../src/lib/ai/server-lock";

const TEST_DATABASE_URL =
  "postgresql://ai_voice_notes:ai_voice_notes@127.0.0.1:55433/ai_voice_notes_test";

function resetServerLockGlobal(): void {
  delete (globalThis as { __aiVoiceNotesServerLock?: unknown })
    .__aiVoiceNotesServerLock;
}

beforeEach(() => {
  loadConfigMock.mockReset();
  createDatabaseMock.mockReset();
  reconcileMock.mockReset();
  pgMock.clientConstructor.mockReset();
  pgMock.connect.mockReset();
  pgMock.query.mockReset();
  pgMock.end.mockReset();
  resetServerLockGlobal();
  vi.stubEnv("NEXT_PHASE", "");
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(process, "exit").mockImplementation(
    (code?: string | number | null): never => {
      throw new Error(`process.exit(${code ?? "undefined"})`);
    },
  );
});

afterEach(() => {
  resetServerLockGlobal();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("server startup guard", () => {
  it("validates the full configuration before constructing a database client", async () => {
    loadConfigMock.mockImplementation(() => {
      throw new Error("AI_TEST_MODE=1 vyžaduje testovací databázi.");
    });

    await expect(acquireServerLock()).rejects.toThrow("process.exit(1)");

    expect(loadConfigMock).toHaveBeenCalledTimes(1);
    expect(pgMock.clientConstructor).not.toHaveBeenCalled();
    expect(pgMock.connect).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "AI_TEST_MODE=1 vyžaduje testovací databázi.",
    );
  });

  it("constructs the database client only after configuration succeeds", async () => {
    loadConfigMock.mockReturnValue({
      databaseUrl: TEST_DATABASE_URL,
      testDatabaseUrl: TEST_DATABASE_URL,
    });
    pgMock.connect.mockResolvedValue(undefined);
    pgMock.query.mockResolvedValue({ rows: [{ locked: true }] });
    pgMock.end.mockResolvedValue(undefined);
    createDatabaseMock.mockReturnValue({
      db: {},
      pool: { end: vi.fn().mockResolvedValue(undefined) },
    });
    reconcileMock.mockResolvedValue(0);

    await acquireServerLock();

    expect(pgMock.clientConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ connectionString: TEST_DATABASE_URL }),
    );
    expect(pgMock.connect).toHaveBeenCalledTimes(1);
    expect(createDatabaseMock).toHaveBeenCalledWith(TEST_DATABASE_URL);
    expect(reconcileMock).toHaveBeenCalledTimes(1);
  });
});
