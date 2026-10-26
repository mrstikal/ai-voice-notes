import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

let createdNoteId: string | undefined;

test.afterEach(async ({ request }) => {
  if (!createdNoteId) {
    return;
  }

  const noteId = createdNoteId;
  createdNoteId = undefined;
  const response = await request.get(`/api/notes/${noteId}`);
  if (!response.ok()) {
    return;
  }

  const note = (await response.json()) as { version: number };
  await request.delete(`/api/notes/${noteId}`, {
    data: { expectedVersion: note.version },
  });
});

const markdown = [
  "# Nadpis H1",
  "",
  "## Nadpis H2",
  "",
  "### Nadpis H3",
  "",
  "Odstavec s **tučným**, *kurzívou*, `kódem` a [odkazem](https://example.com).",
  "Měkký",
  "zlom a tvrdý\\",
  "zlom.",
  "",
  "- první",
  "- druhý",
  "  - vnořený",
  "",
  "1. jedna",
  "2. dva",
  "",
  "- [ ] otevřený úkol",
  "- [x] hotový úkol",
  "  - [ ] vnořený úkol",
  "",
  "> Citace s **důrazem**.",
  ">",
  "> Druhý odstavec.",
  "",
  "```ts",
  "const hodnota = 1;",
  "```",
  "",
  "Text s `inline kódem`.",
].join("\n");

test("visual and source editor, explicit save, reload, and source-only safety", async ({
  page,
}) => {
  const title = `Editor E2E ${Date.now()}`;

  await page.goto("/notes");
  await page.getByLabel("Název").fill(title);
  await page.getByLabel("Obsah").fill("");
  await page.getByRole("button", { name: "Vytvořit poznámku" }).click();
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]+$/);
  createdNoteId = page.url().split("/").pop();

  const source = page.getByLabel("Obsah (Markdown)");
  await expect(source).toBeVisible();
  await source.fill(markdown);

  await page.getByRole("button", { name: "Vizuální režim" }).click();
  const visual = page.getByRole("textbox", {
    name: "Vizuální editor poznámky",
  });
  await expect(visual).toBeVisible();
  await expect(visual.locator("h1")).toHaveText("Nadpis H1");
  await expect(visual.locator("h2")).toHaveText("Nadpis H2");
  await expect(visual.locator("h3")).toHaveText("Nadpis H3");
  await expect(visual.locator("strong").first()).toHaveText("tučným");
  await expect(visual.locator("em").first()).toHaveText("kurzívou");
  await expect(visual.locator("p code").first()).toHaveText("kódem");
  await expect(
    visual.locator("br:not(.ProseMirror-trailingBreak)"),
  ).toHaveCount(1);
  await expect(visual.locator("blockquote")).toContainText("Citace s důrazem.");
  await expect(visual.locator("pre code")).toContainText("const hodnota = 1;");
  await expect(visual.locator('a[href="https://example.com"]')).toHaveText(
    "odkazem",
  );
  await expect(visual.locator('input[type="checkbox"]')).toHaveCount(3);
  await expect(
    visual.locator('ul[data-type="taskList"] ul[data-type="taskList"]'),
  ).toHaveCount(1);
  await expect(visual.locator("ul ul, ul ol, ol ul, ol ol")).not.toHaveCount(0);

  await page.getByRole("button", { name: "Zdrojový režim" }).click();
  await expect(source).toBeVisible();
  const roundTrip = await source.inputValue();
  expect(roundTrip).toContain("Nadpis H1");
  expect(roundTrip).toContain("tučným");
  expect(roundTrip).toContain("vnořený úkol");
  expect(roundTrip).toContain("const hodnota = 1;");

  await page.getByRole("button", { name: "Uložit", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Uloženo");
  const savedStatus = await page.getByRole("status").textContent();
  const savedVersion = Number(/verze (\d+)/.exec(savedStatus ?? "")?.[1]);
  expect(savedVersion).toBeGreaterThanOrEqual(2);

  await page.reload();
  await expect(page.getByLabel("Obsah (Markdown)")).toHaveValue(/Nadpis H1/);
  await page.getByRole("button", { name: "Vizuální režim" }).click();
  const reloadedVisual = page.getByRole("textbox", {
    name: "Vizuální editor poznámky",
  });
  await expect(reloadedVisual.locator("h2")).toHaveText("Nadpis H2");
  await page.getByRole("button", { name: "Zdrojový režim" }).click();

  const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  await page.getByLabel("Obsah (Markdown)").fill(table);
  await page.getByRole("button", { name: "Vizuální režim" }).click();
  await expect(page.locator('p[role="alert"]')).toContainText("table");
  await expect(page.getByLabel("Obsah (Markdown)")).toHaveValue(table);

  const unsafe = "[klikni](javascript:alert(1))";
  await page.getByLabel("Obsah (Markdown)").fill(unsafe);
  await page.getByRole("button", { name: "Vizuální režim" }).click();
  await expect(page.locator('p[role="alert"]')).toContainText(
    "nebezpečný odkaz",
  );
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.getByLabel("Obsah (Markdown)")).toHaveValue(unsafe);

  await page.getByLabel("Obsah (Markdown)").fill(table);
  await page.getByRole("button", { name: "Uložit", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Uloženo");
  await page.reload();
  await expect(page.getByLabel("Obsah (Markdown)")).toHaveValue(table);

  await page.getByLabel("Obsah (Markdown)").fill("a".repeat(20_001));
  await expect(page.getByTestId("note-grapheme-counter")).toContainText(
    /20\s*001/,
  );
  await expect(
    page.getByRole("button", { name: "Uložit", exact: true }),
  ).toBeDisabled();

  await page.getByLabel("Obsah (Markdown)").fill("Úklid");
  await page.getByRole("button", { name: "Uložit", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Uloženo");

  await page.getByRole("button", { name: "Smazat", exact: true }).click();
  await page.getByRole("button", { name: "Potvrdit smazání" }).click();
  await expect(page).toHaveURL(/\/notes$/);
});
