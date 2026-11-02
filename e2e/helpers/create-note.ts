import { expect, type Page } from "@playwright/test";

export async function createNoteViaApi(
  page: Page,
  title: string,
  contentMd: string,
): Promise<string> {
  await page.goto("/notes");

  const created = await page.evaluate(
    async ({ title, contentMd }) => {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, contentMd }),
      });

      if (!response.ok) {
        throw new Error(`Vytvoření poznámky selhalo (${response.status}).`);
      }

      return (await response.json()) as { id: string };
    },
    { title, contentMd },
  );

  await page.goto(`/notes/${created.id}`);
  await expect(page).toHaveURL(new RegExp(`/notes/${created.id}$`));
  return created.id;
}
