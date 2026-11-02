import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";

import {
  assertTestDatabaseTargets,
  loadTestEnvironment,
} from "../scripts/test-db-guard";
import { createNoteViaApi } from "./helpers/create-note";

test.setTimeout(120_000);

let createdNoteId: string | undefined;
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

test.afterEach(async () => {
  if (!createdNoteId) {
    return;
  }

  const noteId = createdNoteId;
  createdNoteId = undefined;
  const pool = new Pool({ connectionString: testDatabaseUrl() });

  try {
    await pool.query("delete from notes where id = $1", [noteId]);
  } finally {
    await pool.end();
  }
});

async function createNote(
  page: Page,
  title: string,
  content: string,
): Promise<string> {
  const noteId = await createNoteViaApi(page, title, content);

  createdNoteId = noteId;
  return noteId;
}

async function fillReplaceSentence(
  page: Page,
  startPhrase: string,
  endPhrase: string,
  text: string,
) {
  await page.getByLabel("Začátek cíle").fill(startPhrase);
  await page.getByLabel("Konec cíle").fill(endPhrase);
  await page.getByLabel("Text operace").fill(text);
}

test("manual proposal shows an escaped diff, rejects without changing the note and keeps the nonce out of the DOM", async ({
  page,
}) => {
  const title = `Návrh E2E ${Date.now()}`;
  const content = "První věta. Druhá věta.";
  await createNote(page, title, content);

  await fillReplaceSentence(page, "První", "věta", "Nová věta.");
  await page.getByRole("button", {
    name: "Vytvořit návrh a zobrazit diff",
  }).click();

  await expect(page.getByTestId("proposal-preview")).toBeVisible();
  await expect(page.getByText("Čeká na potvrzení")).toBeVisible();
  await expect(page.getByTestId("proposal-diff")).toContainText(
    "Nová věta. Druhá věta.",
  );
  await expect(page.getByText(/nonce/iu)).toHaveCount(0);
  await expect(page.getByLabel("Obsah (Markdown)")).toHaveValue(content);

  await page.getByRole("button", { name: "Zamítnout návrh" }).click();
  await expect(page.getByText("Zamítnuto")).toBeVisible();
  await expect(page.getByLabel("Obsah (Markdown)")).toHaveValue(content);
});

test("confirming a proposal writes the persisted result exactly once and updates the editor", async ({
  page,
}) => {
  const title = `Confirm E2E ${Date.now()}`;
  const content = "První věta. Druhá věta.";
  await createNote(page, title, content);

  await fillReplaceSentence(page, "První", "věta", "Nová věta.");
  await page.getByRole("button", {
    name: "Vytvořit návrh a zobrazit diff",
  }).click();
  await expect(page.getByTestId("proposal-preview")).toBeVisible();
  await expect(page.getByLabel("Obsah (Markdown)")).toHaveValue(content);

  await page.getByRole("button", { name: "Potvrdit" }).click();

  await expect(page.getByLabel("Obsah (Markdown)")).toHaveValue(
    "Nová věta. Druhá věta.",
  );
  await expect(page.getByText(/Verze 2/)).toBeVisible();
  await expect(page.getByTestId("proposal-preview")).toHaveCount(0);
  await expect(page.getByLabel("Obsah (Markdown)")).not.toHaveValue(content);
});

test("ambiguous manual target offers numbered candidates and applies neither to the note", async ({
  page,
}) => {
  const title = `Ambiguous E2E ${Date.now()}`;
  const content = "Stejná věta. Jiná věta. Stejná věta.";
  await createNote(page, title, content);

  await fillReplaceSentence(page, "Stejná", "věta", "Upravená věta.");
  await page.getByRole("button", {
    name: "Vytvořit návrh a zobrazit diff",
  }).click();

  await expect(
    page.getByText("Cíl odpovídá více místům"),
  ).toBeVisible();
  await page.getByRole("button", { name: /^2\./ }).click();

  await expect(page.getByTestId("proposal-preview")).toBeVisible();
  await expect(page.getByTestId("proposal-diff")).toContainText(
    "Upravená věta.",
  );
  await expect(page.getByLabel("Obsah (Markdown)")).toHaveValue(content);
});
