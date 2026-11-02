import { expect, test } from "@playwright/test";

test("root redirects to notes and the main menu has no home link", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/notes$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Poznámky" }),
  ).toBeVisible();

  const navigation = page.getByRole("navigation", {
    name: "Hlavní navigace",
  });
  await expect(navigation.getByRole("link", { name: "Domů" })).toHaveCount(0);
  await expect(
    navigation.getByRole("link", { name: "Poznámky", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "AI hlasové poznámky" }),
  ).toHaveAttribute("href", "/notes");
});
