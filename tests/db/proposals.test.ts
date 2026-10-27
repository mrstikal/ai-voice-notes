import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  assertTestDatabaseTargets,
  type TestDatabaseTargets,
} from "../../scripts/test-db-guard";
import {
  createDatabase,
  type DatabaseConnection,
} from "../../src/lib/db/client";
import {
  editProposals,
  noteRevisions,
} from "../../src/lib/db/schema";
import type { LlmOperation } from "../../src/lib/ai/schemas";
import {
  EditProposalAmbiguousError,
  EditProposalInvalidError,
  EditProposalStaleError,
  PROPOSAL_EXPIRY_MS,
  createEditProposalService,
  hashConfirmationNonce,
  type EditProposalService,
} from "../../src/lib/notes/proposals";
import { hashNoteSource } from "../../src/lib/notes/operations";
import {
  NoteNotFoundError,
  createNoteService,
  type NoteService,
} from "../../src/lib/notes/service";

const hasTestDatabase = Boolean(
  process.env.DATABASE_URL && process.env.TEST_DATABASE_URL,
);

describe.skipIf(!hasTestDatabase)("P23 edit proposals", () => {
  let connection: DatabaseConnection;
  let targets: TestDatabaseTargets;
  let noteService: NoteService;
  let proposals: EditProposalService;
  let now: Date;
  let nonceCounter: number;

  beforeAll(() => {
    targets = assertTestDatabaseTargets();
    connection = createDatabase(targets.testUrl);
    noteService = createNoteService({ db: connection.db });
  });

  beforeEach(async () => {
    await connection.pool.query("TRUNCATE TABLE notes CASCADE");
    await connection.pool.query("TRUNCATE TABLE ai_usage");
    now = new Date("2026-10-27T10:00:00.000Z");
    nonceCounter = 0;
    proposals = createEditProposalService({
      db: connection.db,
      noteService,
      now: () => now,
      nonceFactory: () => {
        nonceCounter += 1;
        return `nonce-${nonceCounter}-${"x".repeat(32)}`;
      },
    });
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  const replaceFirst: LlmOperation = {
    type: "replace_sentence",
    target: { startPhrase: "První", endPhrase: "věta" },
    text: "Nová věta.",
  };

  async function createBaseNote(
    contentMd = "První věta. Druhá věta.",
  ) {
    return noteService.createNote({
      title: "Návrhová poznámka",
      contentMd,
    });
  }

  async function proposalRows() {
    return connection.db.select().from(editProposals);
  }

  async function revisionCount(noteId: string) {
    const rows = await connection.db
      .select({ id: noteRevisions.id })
      .from(noteRevisions)
      .where(eq(noteRevisions.noteId, noteId));
    return rows.length;
  }

  it("persists a pending proposal, hash-only nonce, exact diff and leaves the note untouched", async () => {
    const note = await createBaseNote();
    const beforeVersion = note.version;
    const created = await proposals.create(note.id, {
      operation: replaceFirst,
      expectedVersion: note.version,
    });

    expect(created.status).toBe("pending");
    expect(created.noteTitle).toBe("Návrhová poznámka");
    expect(created.expectedVersion).toBe(1);
    expect(created.originalHash).toBe(hashNoteSource(note.contentMd));
    expect(created.beforeMd).toBe(note.contentMd);
    expect(created.afterMd).toBe("Nová věta. Druhá věta.");
    expect(created.diff).toMatchObject({
      prefix: "",
      removed: "První",
      inserted: "Nová",
      suffix: " věta. Druhá věta.",
    });
    expect(created.expiresAt.toISOString()).toBe(
      new Date(now.getTime() + PROPOSAL_EXPIRY_MS).toISOString(),
    );
    expect(created.confirmationNonce).toContain("nonce-1-");

    const rows = await proposalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.confirmationNonceHash).toBe(
      hashConfirmationNonce(created.confirmationNonce),
    );
    expect(rows[0]?.confirmationNonceHash).not.toBe(
      created.confirmationNonce,
    );
    expect(rows[0]?.confirmationNonceHash).toMatch(/^[a-f0-9]{64}$/);

    const fetched = await proposals.get(note.id, created.id);
    expect(fetched.status).toBe("pending");
    expect(fetched).not.toHaveProperty("confirmationNonce");
    expect(fetched.diff.prefix).toBe("");

    const unchanged = await noteService.getNote(note.id);
    expect(unchanged.version).toBe(beforeVersion);
    expect(unchanged.contentMd).toBe(note.contentMd);
    expect(await revisionCount(note.id)).toBe(1);
  });

  it("returns numbered candidates for an ambiguous target and persists nothing", async () => {
    const note = await createBaseNote(
      "Stejná věta. Jiná věta. Stejná věta.",
    );
    const ambiguousOperation: LlmOperation = {
      ...replaceFirst,
      target: { startPhrase: "Stejná", endPhrase: "věta" },
    };

    await expect(
      proposals.create(note.id, { operation: ambiguousOperation }),
    ).rejects.toBeInstanceOf(EditProposalAmbiguousError);

    try {
      await proposals.create(note.id, { operation: ambiguousOperation });
    } catch (error) {
      expect(error).toBeInstanceOf(EditProposalAmbiguousError);
      if (error instanceof EditProposalAmbiguousError) {
        expect(error.candidates).toHaveLength(2);
        expect(error.candidates.map((candidate) => candidate.ordinal)).toEqual([
          1, 2,
        ]);
        expect(error.noteVersion).toBe(1);
        expect(error.sourceHash).toBe(hashNoteSource(note.contentMd));
      }
    }

    expect(await proposalRows()).toHaveLength(0);
    expect(await revisionCount(note.id)).toBe(1);
    expect((await noteService.getNote(note.id)).version).toBe(1);
  });

  it("binds an explicitly selected candidate to version and source hash", async () => {
    const note = await createBaseNote(
      "Stejná věta. Jiná věta. Stejná věta.",
    );

    const ambiguousOperation: LlmOperation = {
      ...replaceFirst,
      target: { startPhrase: "Stejná", endPhrase: "věta" },
    };
    let ambiguous: EditProposalAmbiguousError | null = null;
    try {
      await proposals.create(note.id, { operation: ambiguousOperation });
    } catch (error) {
      if (error instanceof EditProposalAmbiguousError) {
        ambiguous = error;
      }
    }

    expect(ambiguous).not.toBeNull();
    const selected = ambiguous!.candidates[1]!;
    const created = await proposals.create(note.id, {
      operation: ambiguousOperation,
      candidateId: selected.id,
      expectedVersion: ambiguous!.noteVersion!,
      expectedSourceHash: ambiguous!.sourceHash,
    });

    expect(created.status).toBe("pending");
    expect(created.selectedCandidate?.id).toBe(selected.id);
    expect(created.afterMd).toBe(
      "Stejná věta. Jiná věta. Nová věta.",
    );
    expect((await noteService.getNote(note.id)).version).toBe(1);

    await expect(
      proposals.create(note.id, {
        operation: ambiguousOperation,
        candidateId: selected.id,
      }),
    ).rejects.toBeInstanceOf(EditProposalInvalidError);
  });

  it("rejects stale versions, hash mismatches and deleted notes without a proposal", async () => {
    const note = await createBaseNote();

    await expect(
      proposals.create(note.id, {
        operation: replaceFirst,
        expectedVersion: 2,
      }),
    ).rejects.toBeInstanceOf(EditProposalStaleError);

    await expect(
      proposals.create(note.id, {
        operation: replaceFirst,
        expectedVersion: 1,
        expectedSourceHash: "a".repeat(64),
      }),
    ).rejects.toBeInstanceOf(EditProposalStaleError);

    await noteService.deleteNote(note.id, 1);
    await expect(
      proposals.create(note.id, { operation: replaceFirst }),
    ).rejects.toBeInstanceOf(NoteNotFoundError);

    expect(await proposalRows()).toHaveLength(0);
  });

  it("keeps task-specific no-match reasons for already-finished tasks", async () => {
    const note = await createBaseNote("- [x] Koupit mléko");

    await expect(
      proposals.create(note.id, {
        operation: {
          type: "set_task_checked",
          taskText: "Koupit mléko",
          checked: true,
        },
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({
      message: "Úkol už je označený jako hotový.",
      name: "EditProposalNoMatchError",
    });

    expect(await proposalRows()).toHaveLength(0);
    expect(await revisionCount(note.id)).toBe(1);
  });

  it("rejects a proposal without changing the note and is idempotent", async () => {
    const note = await createBaseNote();
    const created = await proposals.create(note.id, {
      operation: replaceFirst,
      expectedVersion: 1,
    });

    const rejected = await proposals.reject(note.id, created.id);
    expect(rejected.status).toBe("rejected");

    const again = await proposals.reject(note.id, created.id);
    expect(again.status).toBe("rejected");

    const unchanged = await noteService.getNote(note.id);
    expect(unchanged.version).toBe(1);
    expect(unchanged.contentMd).toBe(note.contentMd);
    expect(await revisionCount(note.id)).toBe(1);
  });

  it("expires a pending proposal lazily after five minutes without touching the note", async () => {
    const note = await createBaseNote();
    const created = await proposals.create(note.id, {
      operation: replaceFirst,
      expectedVersion: 1,
    });

    now = new Date(now.getTime() + PROPOSAL_EXPIRY_MS + 1);
    const expired = await proposals.get(note.id, created.id);
    expect(expired.status).toBe("expired");

    const rejected = await proposals.reject(note.id, created.id);
    expect(rejected.status).toBe("expired");

    const unchanged = await noteService.getNote(note.id);
    expect(unchanged.version).toBe(1);
    expect(unchanged.contentMd).toBe(note.contentMd);
    expect(await revisionCount(note.id)).toBe(1);
  });

  it("returns 404 semantics for a proposal that does not belong to the note", async () => {
    const note = await createBaseNote();
    const other = await createBaseNote("Jiná poznámka.");
    const created = await proposals.create(note.id, {
      operation: replaceFirst,
      expectedVersion: 1,
    });

    await expect(proposals.get(other.id, created.id)).rejects.toMatchObject({
      status: 404,
      code: "proposal_not_found",
    });
    expect((await noteService.getNote(note.id)).version).toBe(1);
  });
});
