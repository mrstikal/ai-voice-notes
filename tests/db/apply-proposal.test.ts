import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  EditProposalAlreadyAppliedError,
  EditProposalConflictError,
  EditProposalDiffMismatchError,
  EditProposalExpiredError,
  EditProposalNonceError,
  EditProposalStaleError,
  PROPOSAL_EXPIRY_MS,
  createEditProposalService,
  type EditProposalService,
} from "../../src/lib/notes/proposals";
import {
  NoteValidationError,
  createNoteService,
  type NoteService,
} from "../../src/lib/notes/service";

const hasTestDatabase = Boolean(
  process.env.DATABASE_URL && process.env.TEST_DATABASE_URL,
);

describe.skipIf(!hasTestDatabase)("P24 proposal application", () => {
  let connection: DatabaseConnection;
  let targets: TestDatabaseTargets;
  let noteService: NoteService;
  let proposals: EditProposalService;
  let now: Date;
  let purgeNote: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    targets = assertTestDatabaseTargets();
    connection = createDatabase(targets.testUrl);
    noteService = createNoteService({ db: connection.db });
  });

  beforeEach(async () => {
    await connection.pool.query("TRUNCATE TABLE notes CASCADE");
    await connection.pool.query("TRUNCATE TABLE ai_usage");
    now = new Date("2026-10-27T10:00:00.000Z");
    purgeNote = vi.fn().mockResolvedValue(undefined);
    proposals = createEditProposalService({
      db: connection.db,
      noteService,
      now: () => now,
      nonceFactory: () => "apply-nonce-0123456789abcdef",
      ttsCache: {
        purgeNote: purgeNote as unknown as (
          noteId: string,
        ) => Promise<number>,
      },
    });
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  const operation: LlmOperation = {
    type: "replace_sentence",
    target: { startPhrase: "První", endPhrase: "věta" },
    text: "Nová věta.",
  };

  async function baseNote() {
    return noteService.createNote({
      title: "Apply poznámka",
      contentMd: "První věta. PREFIX SUFFIX",
    });
  }

  async function createProposal() {
    const note = await baseNote();
    const created = await proposals.create(note.id, {
      operation,
      expectedVersion: note.version,
    });

    return { note, created };
  }

  async function revisions(noteId: string) {
    return connection.db
      .select()
      .from(noteRevisions)
      .where(eq(noteRevisions.noteId, noteId))
      .orderBy(noteRevisions.noteVersion);
  }

  it("applies once through CAS, writes exactly one ai revision and preserves unrelated bytes", async () => {
    const { note, created } = await createProposal();

    const confirmed = await proposals.confirm(note.id, created.id, {
      confirmationNonce: created.confirmationNonce,
      expectedVersion: 1,
    });

    expect(confirmed.note.version).toBe(2);
    expect(confirmed.note.contentMd).toBe("Nová věta. PREFIX SUFFIX");
    expect(confirmed.note.contentPlain).toBe("Nová věta. PREFIX SUFFIX");
    expect(confirmed.proposal.status).toBe("applied");
    expect(confirmed.proposal).not.toHaveProperty("confirmationNonce");

    const rows = await connection.db
      .select()
      .from(editProposals)
      .where(eq(editProposals.id, created.id));
    expect(rows[0]?.status).toBe("applied");
    expect(rows[0]?.confirmationNonceUsedAt).toBeInstanceOf(Date);

    const history = await revisions(note.id);
    expect(history).toHaveLength(2);
    expect(history[1]?.reason).toBe("ai");
    expect(history[1]?.noteVersion).toBe(2);
    expect(history[1]?.beforeSnapshot.contentMd).toBe(note.contentMd);
    expect(history[1]?.afterSnapshot.contentMd).toBe(
      "Nová věta. PREFIX SUFFIX",
    );
    expect(purgeNote).toHaveBeenCalledWith(note.id);

    await expect(
      proposals.confirm(note.id, created.id, {
        confirmationNonce: created.confirmationNonce,
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(EditProposalAlreadyAppliedError);

    const unchanged = await noteService.getNote(note.id);
    expect(unchanged.version).toBe(2);
    expect(unchanged.contentMd).toBe("Nová věta. PREFIX SUFFIX");
    expect(await revisions(note.id)).toHaveLength(2);
  });

  it("lets exactly one of two concurrent confirms apply and create one revision", async () => {
    const { note, created } = await createProposal();
    const input = {
      confirmationNonce: created.confirmationNonce,
      expectedVersion: 1,
    };

    const results = await Promise.allSettled([
      proposals.confirm(note.id, created.id, input),
      proposals.confirm(note.id, created.id, input),
    ]);
    const fulfilled = results.filter(
      (result) => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result) => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      EditProposalAlreadyAppliedError,
    );

    const noteAfter = await noteService.getNote(note.id);
    expect(noteAfter.version).toBe(2);
    expect(await revisions(note.id)).toHaveLength(2);
  });

  it("serializes a reject racer against confirm without losing or double-mutating the note", async () => {
    const { note, created } = await createProposal();

    const results = await Promise.allSettled([
      proposals.reject(note.id, created.id),
      proposals.confirm(note.id, created.id, {
        confirmationNonce: created.confirmationNonce,
        expectedVersion: 1,
      }),
    ]);
    const fulfilled = results.filter(
      (result) => result.status === "fulfilled",
    );

    expect(fulfilled).toHaveLength(1);

    const noteAfter = await noteService.getNote(note.id);
    const history = await revisions(note.id);
    const row = (
      await connection.db
        .select()
        .from(editProposals)
        .where(eq(editProposals.id, created.id))
    )[0];

    expect(row?.status === "applied" || row?.status === "rejected").toBe(true);

    if (row?.status === "applied") {
      expect(noteAfter.version).toBe(2);
      expect(history).toHaveLength(2);
      expect(history[1]?.reason).toBe("ai");
    } else {
      expect(noteAfter.version).toBe(1);
      expect(noteAfter.contentMd).toBe(note.contentMd);
      expect(history).toHaveLength(1);
    }
  });

  it("rejects a wrong nonce without consuming or applying", async () => {
    const { note, created } = await createProposal();

    await expect(
      proposals.confirm(note.id, created.id, {
        confirmationNonce: "wrong-nonce-0123456789",
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(EditProposalNonceError);

    const unchanged = await noteService.getNote(note.id);
    expect(unchanged.version).toBe(1);
    expect(unchanged.contentMd).toBe(note.contentMd);
    expect(await revisions(note.id)).toHaveLength(1);

    const rows = await connection.db
      .select()
      .from(editProposals)
      .where(eq(editProposals.id, created.id));
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.confirmationNonceUsedAt).toBeNull();
  });

  it("rejects stale version/hash without overwriting the note", async () => {
    const first = await createProposal();
    await noteService.updateNote(first.note.id, {
      title: first.note.title,
      contentMd: "Ruční změna.",
      expectedVersion: 1,
    });

    await expect(
      proposals.confirm(first.note.id, first.created.id, {
        confirmationNonce: first.created.confirmationNonce,
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(EditProposalStaleError);

    const afterVersion = await noteService.getNote(first.note.id);
    expect(afterVersion.version).toBe(2);
    expect(afterVersion.contentMd).toBe("Ruční změna.");
    expect(await revisions(first.note.id)).toHaveLength(2);

    const second = await createProposal();
    await connection.pool.query(
      "UPDATE notes SET content_md = $1, content_plain = $1 WHERE id = $2",
      ["Jiný obsah.", second.note.id],
    );

    await expect(
      proposals.confirm(second.note.id, second.created.id, {
        confirmationNonce: second.created.confirmationNonce,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "proposal_stale" });
    expect(await revisions(second.note.id)).toHaveLength(1);
  });

  it("expires a pending proposal without touching the note", async () => {
    const { note, created } = await createProposal();
    now = new Date(now.getTime() + PROPOSAL_EXPIRY_MS + 1);

    await expect(
      proposals.confirm(note.id, created.id, {
        confirmationNonce: created.confirmationNonce,
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(EditProposalExpiredError);

    const unchanged = await noteService.getNote(note.id);
    expect(unchanged.version).toBe(1);
    expect(unchanged.contentMd).toBe(note.contentMd);
    expect(await revisions(note.id)).toHaveLength(1);
    expect((await proposals.get(note.id, created.id)).status).toBe("expired");
  });

  it("rejects after rejection and does not apply a deleted note", async () => {
    const rejected = await createProposal();
    await proposals.reject(rejected.note.id, rejected.created.id);

    await expect(
      proposals.confirm(rejected.note.id, rejected.created.id, {
        confirmationNonce: rejected.created.confirmationNonce,
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(EditProposalConflictError);
    expect((await noteService.getNote(rejected.note.id)).version).toBe(1);

    const deleted = await createProposal();
    await noteService.deleteNote(deleted.note.id, 1);

    await expect(
      proposals.confirm(deleted.note.id, deleted.created.id, {
        confirmationNonce: deleted.created.confirmationNonce,
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(EditProposalConflictError);
  });

  it("honours the configured note content limit during apply", async () => {
    const note = await baseNote();
    const limited = createEditProposalService({
      db: connection.db,
      noteService,
      now: () => now,
      nonceFactory: () => "limited-nonce-0123456789",
      limits: { title: 200, content: 10 },
      ttsCache: {
        purgeNote: purgeNote as unknown as (
          noteId: string,
        ) => Promise<number>,
      },
    });
    const created = await limited.create(note.id, {
      operation,
      expectedVersion: 1,
    });

    await expect(
      limited.confirm(note.id, created.id, {
        confirmationNonce: created.confirmationNonce,
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(NoteValidationError);

    const unchanged = await noteService.getNote(note.id);
    expect(unchanged.version).toBe(1);
    expect(unchanged.contentMd).toBe(note.contentMd);
    expect(await revisions(note.id)).toHaveLength(1);
  });

  it("refuses a tampered after-diff without changing the note", async () => {
    const { note, created } = await createProposal();
    await connection.db
      .update(editProposals)
      .set({ afterMd: "Podvržený obsah. PREFIX SUFFIX" })
      .where(
        and(
          eq(editProposals.id, created.id),
          eq(editProposals.status, "pending"),
        ),
      );

    await expect(
      proposals.confirm(note.id, created.id, {
        confirmationNonce: created.confirmationNonce,
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(EditProposalDiffMismatchError);

    const unchanged = await noteService.getNote(note.id);
    expect(unchanged.version).toBe(1);
    expect(unchanged.contentMd).toBe(note.contentMd);
    expect(await revisions(note.id)).toHaveLength(1);
  });
});
