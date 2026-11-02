import { expect, type Page } from "@playwright/test";

export async function openNoteTab(page: Page, name: string): Promise<void> {
  const tab = page.getByRole("tab", { name });
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}
