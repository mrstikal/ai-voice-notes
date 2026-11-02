import { expect, test, type Page } from "@playwright/test";

import { createNoteViaApi } from "./helpers/create-note";

async function deleteNoteViaApi(page: Page, noteId: string): Promise<void> {
  const origin = new URL(page.url()).origin;
  const response = await page.request.delete(`/api/notes/${noteId}`, {
    data: { expectedVersion: 1 },
    headers: { origin },
  });
  expect(response.ok()).toBe(true);
}

test("empties the trash permanently and keeps active notes", async ({
  page,
}) => {
  const activeId = await createNoteViaApi(
    page,
    "Aktivní poznámka",
    "Zůstane.",
  );
  const firstId = await createNoteViaApi(page, "Smazaná 1", "První.");
  const secondId = await createNoteViaApi(page, "Smazaná 2", "Druhá.");

  await deleteNoteViaApi(page, firstId);
  await deleteNoteViaApi(page, secondId);

  await page.goto("/notes/trash");
  await expect(page.getByText("Smazaná 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Smazaná 2", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Vysypat koš" }).click();
  await expect(
    page.getByText("Trvale smaže všechny poznámky v koši."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Potvrdit vysypání" }).click();

  await expect(page.getByText(/Koš byl vysypán\./)).toBeVisible();
  await expect(page.getByText("Koš je prázdný")).toBeVisible();

  const origin = new URL(page.url()).origin;

  for (const id of [firstId, secondId]) {
    const response = await page.request.get(`/api/notes/${id}`, {
      headers: { origin },
    });
    expect(response.status()).toBe(404);
  }

  const activeResponse = await page.request.get(`/api/notes/${activeId}`, {
    headers: { origin },
  });
  expect(activeResponse.ok()).toBe(true);
});
