import { expect, test } from "@playwright/test";

test.setTimeout(60_000);

test("paginated notes, rename, delete, restore, and safe title", async ({ page }) => {
  await page.goto("/notes");
  await expect(
    page.getByRole("heading", { level: 1, name: "Poznámky" }),
  ).toBeVisible();

  const titles = Array.from(
    { length: 11 },
    (_, index) => `Poznámka ${String(index + 1).padStart(2, "0")}`,
  );
  titles[9] = "<script>window.__xss=1</script>";

  for (const title of titles) {
    await page.getByLabel("Název").fill(title);
    await page.getByLabel("Obsah").fill(`Obsah pro ${title}`);
    await page.getByRole("button", { name: "Vytvořit poznámku" }).click();
    await expect(
      page.getByRole("link", { name: title, exact: true }),
    ).toBeVisible();
  }

  const noteList = page.getByRole("list", { name: "Poznámky" });
  await expect(noteList.getByRole("listitem")).toHaveCount(10);
  await expect(
    page.getByText("<script>window.__xss=1</script>", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as Window & { __xss?: number }).__xss,
    ),
  ).toBeUndefined();

  await page.getByRole("link", { name: "Další" }).click();
  await expect(page).toHaveURL(/\/notes\?page=2$/);
  await expect(
    page.getByRole("list", { name: "Poznámky" }).getByRole("listitem"),
  ).toHaveCount(1);
  await expect(
    page.getByRole("link", { name: "Poznámka 01", exact: true }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Předchozí" }).click();
  await expect(page).toHaveURL(/\/notes$/);
  await page.getByRole("link", { name: "Poznámka 11", exact: true }).click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]+$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Poznámka 11" }),
  ).toBeVisible();
  await expect(page.getByText("Vytvořeno")).toBeVisible();
  await expect(page.getByText("Upraveno")).toBeVisible();

  await page.getByRole("button", { name: "Přejmenovat" }).click();
  await page.getByLabel("Nový název").fill("Poznámka 11 přejmenovaná");
  await page.getByRole("button", { name: "Uložit název" }).click();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Poznámka 11 přejmenovaná",
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Smazat" }).click();
  await expect(page.getByText("Opravdu smazat poznámku")).toBeVisible();
  await page.getByRole("button", { name: "Potvrdit smazání" }).click();
  await expect(page).toHaveURL(/\/notes$/);
  await expect(
    page.getByRole("link", { name: "Poznámka 11 přejmenovaná" }),
  ).toHaveCount(0);

  const mainNavigation = page.getByRole("navigation", {
    name: "Hlavní navigace",
  });
  await mainNavigation.getByRole("link", { name: "Koš", exact: true }).click();
  await expect(page).toHaveURL(/\/notes\/trash$/);
  await expect(
    page.getByText("Poznámka 11 přejmenovaná", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^Obnovit poznámku/ })
    .click();
  await expect(
    page.getByText("Koš je prázdný", { exact: true }),
  ).toBeVisible();

  await mainNavigation
    .getByRole("link", { name: "Poznámky", exact: true })
    .click();
  await expect(page).toHaveURL(/\/notes$/);
  await expect(
    page.getByRole("link", { name: "Poznámka 11 přejmenovaná", exact: true }),
  ).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("link", { name: "Poznámka 11 přejmenovaná", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Poznámky" }).getByRole("listitem"),
  ).toHaveCount(10);

  await page.getByRole("link", { name: "Další" }).click();
  await expect(
    page.getByRole("list", { name: "Poznámky" }).getByRole("listitem"),
  ).toHaveCount(1);
});
