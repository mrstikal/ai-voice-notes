import { expect, test } from "@playwright/test";

test("status page shows a human-readable health message and the API stays JSON", async ({
  page,
  request,
}) => {
  await page.goto("/status");

  await expect(
    page.getByRole("heading", { level: 1, name: "Stav aplikace" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Aplikace je v pořádku" }),
  ).toBeVisible();
  await expect(
    page.getByText("Aplikace je v pořádku. Databáze odpovídá."),
  ).toBeVisible();

  const navigation = page.getByRole("navigation", {
    name: "Hlavní navigace",
  });
  await expect(
    navigation.getByRole("link", { name: "Stav aplikace" }),
  ).toHaveAttribute("href", "/status");

  const response = await request.get("/api/health");
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({
    status: "ok",
    message: "Aplikace je v pořádku. Databáze odpovídá.",
  });
});
