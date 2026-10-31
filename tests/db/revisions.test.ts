import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  assertTestDatabaseTargets,
  type TestDatabaseTargets,
} from "../../scripts/test-db-guard";
import {
  createDatabase,
  type DatabaseConnection,
} from "../../src/lib/db/client";
import type { LlmOperation } from "../../src/lib/ai/schemas";
import {
  NoteConflictError,
  NoteNotFoundError,
  createNoteService,
  type NoteService,
} from "../../src/lib/notes/service";
import {
  createEditProposalService,
  type EditProposalService,
} from "../../src/lib/notes/proposals";
import {
  RevisionNoChangeError,
  createRevisionService,
  type RevisionService,
} from "../../src/lib/notes/revisions";

const hasTestDatabase = Boolean(
  process.env.DATABASE_URL && process.env.TEST_DATABASE_URL,
);

describe.skipIf(!hasTestDatabase)("P25 persistent revisions", () => {
  let connection: DatabaseConnection;
  let targets: TestDatabaseTargets;
  let notes: NoteService;
  let proposals: EditProposalService;
  let revisions: RevisionService;

  beforeAll(() => {
    targets = assertTestDatabaseTargets();
    connection = createDatabase(targets.testUrl);
    notes = createNoteService({ db: connection.db });
  });

  beforeEach(async () => {
    await connection.pool.query("TRUNCATE TABLE notes CASCADE");
    await connection.pool.query("TRUNCATE TABLE ai_usage");
    proposals = createEditProposalService({
      db: connection.db,
      noteService: notes,
      nonceFactory: () => "history-nonce-0123456789",
    });
    revisions = createRevisionService({
      db: connection.db,
      noteService: notes,
    });
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  async function createNote(contentMd = "První verze.") {
    return notes.createNote({ title: "Historie", contentMd });
  }

  async function manualChange(
    noteId: string,
    contentMd: string,
    expectedVersion: number,
    draft = false,
  ) {
    return notes.updateNote(noteId, {
      title: "Historie",
      contentMd,
      expectedVersion,
      draft,
    });
  }

  async function aiChange(
    noteId: string,
    expectedVersion: number,
    contentMd = "Třetí verze.",
  ) {
    const operation: LlmOperation = {
      type: "replace_sentence",
      target: { startPhrase: "Draft", endPhrase: "verze" },
      text: contentMd,
    };
    const proposal = await proposals.create(noteId, {
      operation,
      expectedVersion,
    });

    return proposals.confirm(noteId, proposal.id, {
      confirmationNonce: proposal.confirmationNonce,
      expectedVersion,
    });
  }

  it("recovers the exact pre-AI state through manual -> draft -> AI -> undo -> restore", async () => {
    const note = await createNote();
    const manual = await manualChange(note.id, "Druhá verze.", 1);
    const draft = await manualChange(manual.id, "Draft verze.", 2, true);
    await aiChange(note.id, draft.version);

    const list = await revisions.list(note.id);
    expect(list.currentVersion).toBe(4);
    expect(list.canUndo).toBe(true);
    expect(list.revisions.map((revision) => revision.reason)).toEqual([
      "ai",
      "manual",
      "initial",
    ]);
    expect(
      list.revisions.some((revision) => revision.reason === "manual" &&
        revision.afterSnapshot.contentMd === "Draft verze."),
    ).toBe(false);

    const aiRevision = list.revisions[0]!;
    const undone = await revisions.restore(note.id, aiRevision.id, {
      mode: "undo",
      expectedVersion: 4,
    });
    expect(undone.version).toBe(5);
    expect(undone.contentMd).toBe("Draft verze.");

    const manualRevision = list.revisions.find(
      (revision) => revision.reason === "manual",
    )!;
    const restored = await revisions.restore(note.id, manualRevision.id, {
      mode: "restore",
      expectedVersion: 5,
    });
    expect(restored.version).toBe(6);
    expect(restored.contentMd).toBe("Druhá verze.");

    const finalList = await revisions.list(note.id);
    expect(finalList.revisions.map((revision) => revision.reason)).toEqual([
      "restore",
      "undo",
      "ai",
      "manual",
      "initial",
    ]);
    expect(finalList.currentSnapshot.contentMd).toBe("Druhá verze.");
  });

  it("records an undoable voice revision even after the draft autosave stored the dictation", async () => {
    const note = await createNote("Ruční text.");
    const baseline = note.contentMd;
    const dictatedContent = "Ruční text. Diktovaná věta.";

    const draft = await manualChange(note.id, dictatedContent, 1, true);
    expect(draft.version).toBe(2);

    const checkpoint = await notes.updateNoteVoiceContent(note.id, {
      baselineContentMd: baseline,
      contentMd: dictatedContent,
      expectedVersion: 2,
    });
    expect(checkpoint.version).toBe(3);

    const list = await revisions.list(note.id);
    expect(list.currentVersion).toBe(3);
    expect(list.canUndo).toBe(true);
    expect(list.undoRevisionId).not.toBeNull();
    expect(list.revisions.map((revision) => revision.reason)).toEqual([
      "voice",
      "initial",
    ]);
    expect(list.revisions[0]?.beforeSnapshot.contentMd).toBe(baseline);
    expect(list.revisions[0]?.afterSnapshot.contentMd).toBe(dictatedContent);

    const undone = await revisions.restore(note.id, list.undoRevisionId!, {
      mode: "undo",
      expectedVersion: 3,
    });
    expect(undone.version).toBe(4);
    expect(undone.contentMd).toBe(baseline);
  });

  it("restores the original transcript from an AI revision after later named changes", async () => {
    const note = await createNote("Původní přepis.");
    const operation: LlmOperation = {
      type: "replace_sentence",
      target: { startPhrase: "Původní", endPhrase: "přepis" },
      text: "Vyčištěný text.",
    };
    const proposal = await proposals.create(note.id, {
      operation,
      expectedVersion: 1,
    });
    const cleaned = await proposals.confirm(note.id, proposal.id, {
      confirmationNonce: proposal.confirmationNonce,
      expectedVersion: 1,
    });
    expect(cleaned.note.contentMd).toBe("Vyčištěný text.");

    const later = await manualChange(note.id, "Pozdější změna.", 2);
    const list = await revisions.list(note.id);
    const aiRevision = list.revisions.find(
      (revision) => revision.reason === "ai",
    )!;

    expect(list.undoRevisionId).not.toBe(aiRevision.id);

    const restored = await revisions.restore(note.id, aiRevision.id, {
      mode: "restore_before",
      expectedVersion: later.version,
    });

    expect(restored.version).toBe(4);
    expect(restored.contentMd).toBe("Původní přepis.");
    expect(
      (await revisions.list(note.id)).revisions.map(
        (revision) => revision.reason,
      ),
    ).toEqual(["restore", "manual", "ai", "initial"]);
  });

  it("refuses restore_before outside AI revisions and for an empty original", async () => {
    const note = await createNote();
    const list = await revisions.list(note.id);
    const initial = list.revisions.find(
      (revision) => revision.reason === "initial",
    )!;

    await expect(
      revisions.restore(note.id, initial.id, {
        mode: "restore_before",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({
      message: "Obnovit původní přepis lze pouze z AI revize.",
    });
  });

  it("refuses one-click undo when a draft/autosave moved the note past the AI revision", async () => {
    const note = await createNote();
    const manual = await manualChange(note.id, "Draft verze.", 1);
    await aiChange(note.id, manual.version);
    await manualChange(note.id, "Draft po AI.", 3, true);

    const list = await revisions.list(note.id);
    expect(list.currentVersion).toBe(4);
    expect(list.canUndo).toBe(false);
    expect(list.undoRevisionId).toBeNull();

    await expect(
      revisions.restore(note.id, list.revisions[0]!.id, {
        mode: "undo",
        expectedVersion: 4,
      }),
    ).rejects.toBeInstanceOf(NoteConflictError);

    const unchanged = await notes.getNote(note.id);
    expect(unchanged.version).toBe(4);
    expect(unchanged.contentMd).toBe("Draft po AI.");
    expect((await revisions.list(note.id)).revisions).toHaveLength(3);
  });

  it("allows only one of two simultaneous restores to win", async () => {
    const note = await createNote();
    const manual = await manualChange(note.id, "Druhá verze.", 1);
    const list = await revisions.list(note.id);
    const initial = list.revisions.find(
      (revision) => revision.reason === "initial",
    )!;

    const results = await Promise.allSettled([
      revisions.restore(note.id, initial.id, {
        mode: "restore",
        expectedVersion: manual.version,
      }),
      revisions.restore(note.id, initial.id, {
        mode: "restore",
        expectedVersion: manual.version,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof revisions.restore>>> =>
        result.status === "fulfilled",
    )!;
    expect(winner.value.version).toBe(3);
    expect(winner.value.contentMd).toBe("První verze.");
    expect((await revisions.list(note.id)).revisions).toHaveLength(3);
  });

  it("restores the full stored snapshot including title, category and tags", async () => {
    const note = await createNote();
    await connection.pool.query(
      `UPDATE notes
       SET version = 2, title = $1, content_md = $2, content_plain = $2,
           category = $3
       WHERE id = $4`,
      ["Titulek s metadaty", "Meta obsah.", "práce", note.id],
    );
    await connection.pool.query(
      `INSERT INTO note_revisions
        (note_id, note_version, reason, before_snapshot, after_snapshot)
       VALUES ($1, 2, 'metadata', $2::jsonb, $3::jsonb)`,
      [
        note.id,
        JSON.stringify({
          title: "Historie",
          contentMd: "První verze.",
          category: null,
          tags: [],
        }),
        JSON.stringify({
          title: "Titulek s metadaty",
          contentMd: "Meta obsah.",
          category: "práce",
          tags: ["b", "a"],
        }),
      ],
    );
    await connection.pool.query(
      `UPDATE notes
       SET version = 3, title = 'Bez metadat', content_md = 'Bez metadat.',
           content_plain = 'Bez metadat.', category = NULL
       WHERE id = $1`,
      [note.id],
    );

    const list = await revisions.list(note.id);
    const metadataRevision = list.revisions.find(
      (revision) => revision.reason === "metadata",
    )!;
    expect(list.currentVersion).toBe(3);

    const restored = await revisions.restore(note.id, metadataRevision.id, {
      mode: "restore",
      expectedVersion: 3,
    });

    expect(restored.version).toBe(4);
    expect(restored.title).toBe("Titulek s metadaty");
    expect(restored.category).toBe("práce");
    expect(restored.tags).toEqual(["a", "b"]);
    expect(restored.contentMd).toBe("Meta obsah.");
    expect((await revisions.list(note.id)).revisions[0]?.reason).toBe(
      "restore",
    );
  });

  it("does not offer Undo for a named revision with identical snapshots", async () => {
    const note = await createNote();
    await manualChange(note.id, "Mezistav.", 1, true);
    const noOp = await manualChange(note.id, "Mezistav.", 2);

    const list = await revisions.list(note.id);
    expect(list.currentVersion).toBe(noOp.version);
    expect(list.canUndo).toBe(false);
    expect(list.undoRevisionId).toBeNull();

    const latest = list.revisions[0]!;
    await expect(
      revisions.restore(note.id, latest.id, {
        mode: "undo",
        expectedVersion: noOp.version,
      }),
    ).rejects.toBeInstanceOf(RevisionNoChangeError);
    expect((await notes.getNote(note.id)).version).toBe(noOp.version);
  });

  it("refuses undo of a non-latest revision", async () => {
    const note = await createNote();
    await manualChange(note.id, "Druhá verze.", 1);
    const list = await revisions.list(note.id);
    const initial = list.revisions.find(
      (revision) => revision.reason === "initial",
    )!;

    await expect(
      revisions.restore(note.id, initial.id, {
        mode: "undo",
        expectedVersion: list.currentVersion,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("refuses stale restore and no-op restore without writing", async () => {
    const note = await createNote();
    const manual = await manualChange(note.id, "Druhá verze.", 1);
    const list = await revisions.list(note.id);
    const manualRevision = list.revisions.find(
      (revision) => revision.reason === "manual",
    )!;

    await expect(
      revisions.restore(note.id, manualRevision.id, {
        mode: "restore",
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(NoteConflictError);

    await expect(
      revisions.restore(note.id, manualRevision.id, {
        mode: "restore",
        expectedVersion: manual.version,
      }),
    ).rejects.toBeInstanceOf(RevisionNoChangeError);

    const unchanged = await notes.getNote(note.id);
    expect(unchanged.version).toBe(2);
    expect((await revisions.list(note.id)).revisions).toHaveLength(2);
  });

  it("keeps history and restore unavailable for a deleted note", async () => {
    const note = await createNote();
    const beforeDelete = await revisions.list(note.id);
    const initial = beforeDelete.revisions.find(
      (revision) => revision.reason === "initial",
    )!;
    await notes.deleteNote(note.id, 1);

    await expect(revisions.list(note.id)).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );

    await expect(
      revisions.restore(note.id, initial.id, {
        mode: "restore",
        expectedVersion: 2,
      }),
    ).rejects.toBeInstanceOf(NoteNotFoundError);
  });
});
