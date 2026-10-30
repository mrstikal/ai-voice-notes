import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";

import {
  assertTestDatabaseTargets,
  loadTestEnvironment,
} from "../scripts/test-db-guard";
test.setTimeout(120_000);

let cachedTestDatabaseUrl: string | undefined;

function testDatabaseUrl(): string {
  if (cachedTestDatabaseUrl) {
    return cachedTestDatabaseUrl;
  }

  const previousNodeEnv = process.env.NODE_ENV;
  const mutableEnv = process.env as Record<string, string | undefined>;

  try {
    loadTestEnvironment();
    cachedTestDatabaseUrl = assertTestDatabaseTargets().testUrl;
  } finally {
    if (previousNodeEnv === undefined) {
      delete mutableEnv.NODE_ENV;
    } else {
      mutableEnv.NODE_ENV = previousNodeEnv;
    }
  }

  return cachedTestDatabaseUrl;
}

async function withTestPool<T>(operation: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: testDatabaseUrl() });

  try {
    return await operation(pool);
  } finally {
    await pool.end();
  }
}

test.afterEach(async () => {
  await withTestPool(async (pool) => {
    const rows = await pool.query<{ note_ids: string[] }>(
      "select note_ids from meeting_saves",
    );
    const noteIds = rows.rows.flatMap((row) => row.note_ids);

    await pool.query("delete from meeting_saves");

    if (noteIds.length > 0) {
      await pool.query("delete from notes where id = any($1::uuid[])", [
        noteIds,
      ]);
    }
  });
});

async function revisionCount(noteId: string): Promise<number> {
  return withTestPool(async (pool) => {
    const result = await pool.query<{ count: number }>(
      "select count(*)::int as count from note_revisions where note_id = $1",
      [noteId],
    );

    return result.rows[0]?.count ?? 0;
  });
}

async function createSavedMeetingNote(): Promise<string> {
  const noteId = randomUUID();
  const title = "Zápis ze schůzky";
  const contentMd =
    "**Mluvčí 1:** Dobrý den, týme.\n\n**Mluvčí 2:** Schůzka začíná v devět.";
  const contentPlain =
    "Mluvčí 1: Dobrý den, týme.\n\nMluvčí 2: Schůzka začíná v devět.";
  const emptySnapshot = {
    title: "",
    contentMd: "",
    category: null,
    tags: [],
  };
  const snapshot = {
    title,
    contentMd,
    category: null,
    tags: [],
  };

  await withTestPool(async (pool) => {
    await pool.query(
      "insert into notes (id, title, content_md, content_plain, version) values ($1, $2, $3, $4, 1)",
      [noteId, title, contentMd, contentPlain],
    );
    await pool.query(
      "insert into note_revisions (note_id, note_version, reason, before_snapshot, after_snapshot) values ($1, 1, 'initial', $2, $3)",
      [noteId, JSON.stringify(emptySnapshot), JSON.stringify(snapshot)],
    );
    await pool.query(
      "insert into meeting_saves (request_id, input_hash, note_ids) values ($1, $2, array[$3]::uuid[])",
      [randomUUID(), "a".repeat(64), noteId],
    );
  });

  return noteId;
}

async function mockMeetingAi(
  page: Page,
  options: {
    readonly summaryStatus?: number;
    readonly decisionsText?: string;
    readonly decisionsFailure?: boolean;
    readonly tasks?: readonly { text: string; duplicate?: boolean }[];
  } = {},
): Promise<void> {
  await page.route("**/api/notes/*/ai-suggest", async (route) => {
    const request = route.request();
    const body = JSON.parse(request.postData() ?? "{}") as {
      kind?: string;
      expectedVersion?: number;
      tasks?: string[];
    };

    if (options.summaryStatus && options.summaryStatus >= 400) {
      await route.fulfill({
        status: options.summaryStatus,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "ai_unavailable",
            message: "Návrhy pro schůzku nejsou dostupné.",
          },
        }),
      });
      return;
    }

    if (body.kind === "meeting_summary_decisions") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          kind: "meeting_summary_decisions",
          noteId: "ignored",
          noteVersion: 1,
          summaryText: "Shrnutí schůzky: tým se sejde a rozdělí úkoly.",
          summarySourceGraphemes: 58,
          decisionsText: options.decisionsFailure
            ? null
            : (options.decisionsText ??
              "## Rozhodnutí\n\n- Projekt začne v pondělí."),
          decisionsSourceGraphemes: 58,
          decisionsError: options.decisionsFailure
            ? {
                code: "meeting_decisions_unclear",
                message: "Rozhodnutí nejsou jednoznačná.",
              }
            : null,
        }),
      });
      return;
    }

    if (body.kind === "meeting_tasks") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          noteId: "ignored",
          noteVersion: 1,
          tasks: (options.tasks ?? [{ text: "Poslat zápis" }]).map((task) => ({
            text: task.text,
            normalized: task.text.toLocaleLowerCase("cs-CZ"),
            duplicate: task.duplicate ?? false,
          })),
          rejectedCount: 0,
          sourceGraphemes: 58,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        }),
      });
      return;
    }

    if (body.kind === "task_apply") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          kind: "task_apply",
          operation: {
            type: "append_bounded_section",
            text: `## Úkoly\n\n${(body.tasks ?? [])
              .map((task) => `- [ ] ${task}`)
              .join("\n")}`,
          },
          noteVersion: body.expectedVersion,
          tasks: body.tasks ?? [],
        }),
      });
      return;
    }

    await route.continue();
  });
}

test("keeps the open-note link and hides the loading label when the note fetch fails", async ({
  page,
}) => {
  const noteId = await createSavedMeetingNote();

  await page.route("**/api/notes/*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "internal_error",
          message: "Načtení zápisu se nepodařilo.",
        },
      }),
    });
  });

  await page.goto("/meetings");
  await expect(page.getByTestId("meeting-suggestions")).toBeVisible();
  await expect(page.getByText("Načtení zápisu se nepodařilo.")).toBeVisible();
  await expect(page.getByTestId("meeting-suggestion-note-label")).toHaveCount(0);
  await expect(page.getByTestId("meeting-suggestion-open-note")).toHaveAttribute(
    "href",
    `/notes/${noteId}`,
  );
});

test("applies a reviewed decisions section as exactly one revision", async ({
  page,
  request,
}) => {
  const noteId = await createSavedMeetingNote();
  const before = await revisionCount(noteId);

  await page.goto("/meetings");
  await expect(page.getByTestId("meeting-suggestions")).toBeVisible();
  await expect(page.getByTestId("meeting-suggestion-note-label")).toContainText(
    "Zápis ze schůzky",
  );
  await mockMeetingAi(page);
  await page.getByTestId("meeting-summary-generate").click();

  await expect(page.getByTestId("meeting-summary-artifact")).toContainText(
    "Shrnutí schůzky",
  );
  await expect(page.getByTestId("meeting-decisions-text")).toHaveValue(
    "## Rozhodnutí\n\n- Projekt začne v pondělí.",
  );

  await page.getByTestId("meeting-decisions-propose").click();
  await expect(page.getByTestId("proposal-preview")).toBeVisible();
  await page.getByRole("button", { name: "Potvrdit", exact: true }).click();
  await expect(page.getByTestId("meeting-suggestions-status")).toContainText(
    "Rozhodnutí byla vložena jako nová revize.",
  );

  const note = await request.get(`/api/notes/${noteId}`);
  const body = (await note.json()) as { contentMd: string };

  expect(body.contentMd).toContain("## Rozhodnutí");
  expect(body.contentMd).toContain("- Projekt začne v pondělí.");
  expect(await revisionCount(noteId)).toBe(before + 1);

  await page.reload();
  await expect(page.getByTestId("meeting-suggestions")).toBeVisible();
  await expect(page.getByTestId("meeting-suggestion-source")).toHaveValue(
    /Dobrý den, týme\./u,
  );
});

test("keeps a paid summary usable when decisions are ambiguous", async ({
  page,
}) => {
  const noteId = await createSavedMeetingNote();
  const before = await revisionCount(noteId);

  await page.goto("/meetings");
  await expect(page.getByTestId("meeting-suggestions")).toBeVisible();
  await mockMeetingAi(page, { decisionsFailure: true });
  await page.getByTestId("meeting-summary-generate").click();

  await expect(page.getByTestId("meeting-summary-artifact")).toContainText(
    "Shrnutí schůzky",
  );
  await expect(page.getByTestId("meeting-suggestions-error")).toContainText(
    "Rozhodnutí nejsou jednoznačná.",
  );
  await expect(page.getByTestId("meeting-decisions-artifact")).toHaveCount(0);

  await page.getByTestId("meeting-summary-propose").click();
  await expect(page.getByTestId("proposal-preview")).toBeVisible();
  await page.getByRole("button", { name: "Potvrdit", exact: true }).click();
  await expect(page.getByTestId("meeting-suggestions-status")).toContainText(
    "Shrnutí bylo vloženo jako nová revize.",
  );
  expect(await revisionCount(noteId)).toBe(before + 1);
});

test("applies a reviewed summary as exactly one revision", async ({
  page,
  request,
}) => {
  const noteId = await createSavedMeetingNote();
  const before = await revisionCount(noteId);

  await page.goto("/meetings");
  await expect(page.getByTestId("meeting-suggestions")).toBeVisible();
  await mockMeetingAi(page);
  await page.getByTestId("meeting-summary-generate").click();
  await expect(page.getByTestId("meeting-summary-artifact")).toContainText(
    "Shrnutí schůzky",
  );

  await page.getByTestId("meeting-summary-propose").click();
  await expect(page.getByTestId("proposal-preview")).toBeVisible();
  await page.getByRole("button", { name: "Potvrdit", exact: true }).click();
  await expect(page.getByTestId("meeting-suggestions-status")).toContainText(
    "Shrnutí bylo vloženo jako nová revize.",
  );

  const note = await request.get(`/api/notes/${noteId}`);
  const body = (await note.json()) as { contentMd: string };

  expect(body.contentMd).toContain("Shrnutí schůzky: tým se sejde a rozdělí úkoly.");
  expect(await revisionCount(noteId)).toBe(before + 1);
});

test("applies reviewed tasks as exactly one revision", async ({
  page,
  request,
}) => {
  const noteId = await createSavedMeetingNote();
  const before = await revisionCount(noteId);

  await page.goto("/meetings");
  await expect(page.getByTestId("meeting-suggestions")).toBeVisible();
  await mockMeetingAi(page);
  await page.getByTestId("meeting-tasks-generate").click();
  await expect(page.getByTestId("meeting-tasks-artifact")).toBeVisible();

  await page.getByTestId("meeting-tasks-propose").click();
  await expect(page.getByTestId("proposal-preview")).toBeVisible();
  await page.getByRole("button", { name: "Potvrdit", exact: true }).click();
  await expect(page.getByTestId("meeting-suggestions-status")).toContainText(
    "Úkoly byly vloženy jako nová revize.",
  );

  const note = await request.get(`/api/notes/${noteId}`);
  const body = (await note.json()) as { contentMd: string };

  expect(body.contentMd).toContain("## Úkoly");
  expect(body.contentMd).toContain("- [ ] Poslat zápis");
  expect(await revisionCount(noteId)).toBe(before + 1);
});

test("rejecting a decision proposal leaves the note and revisions unchanged", async ({
  page,
  request,
}) => {
  const noteId = await createSavedMeetingNote();
  const before = await revisionCount(noteId);

  await page.goto("/meetings");
  await expect(page.getByTestId("meeting-suggestions")).toBeVisible();
  await mockMeetingAi(page, {
    decisionsText:
      "## Rozhodnutí\n\n- Možná projekt začne v pondělí, není potvrzeno.",
  });
  await page.getByTestId("meeting-summary-generate").click();
  await page.getByTestId("meeting-decisions-propose").click();
  await expect(page.getByTestId("proposal-preview")).toBeVisible();
  await page.getByRole("button", { name: "Zamítnout návrh" }).click();
  await expect(page.getByTestId("meeting-suggestions-status")).toContainText(
    "Poznámka zůstala beze změny.",
  );

  const note = await request.get(`/api/notes/${noteId}`);
  const body = (await note.json()) as { contentMd: string };

  expect(body.contentMd).not.toContain("## Rozhodnutí");
  expect(await revisionCount(noteId)).toBe(before);
});

test("a provider failure never erases the saved transcript or creates a revision", async ({
  page,
  request,
}) => {
  const noteId = await createSavedMeetingNote();
  const before = await revisionCount(noteId);

  await page.goto("/meetings");
  await expect(page.getByTestId("meeting-suggestions")).toBeVisible();
  await mockMeetingAi(page, { summaryStatus: 503 });
  await page.getByTestId("meeting-summary-generate").click();
  await expect(page.getByTestId("meeting-suggestions-error")).toContainText(
    "nejsou dostupné",
  );

  const note = await request.get(`/api/notes/${noteId}`);
  const body = (await note.json()) as { contentMd: string };

  expect(body.contentMd).toContain("Dobrý den, týme.");
  expect(body.contentMd).not.toContain("## Rozhodnutí");
  expect(await revisionCount(noteId)).toBe(before);
  await expect(page.getByTestId("meeting-suggestion-source")).toHaveValue(
    /Schůzka začíná v devět\./u,
  );
});
