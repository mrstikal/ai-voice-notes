import { expect, test } from "@playwright/test";

import { createNoteViaApi } from "./helpers/create-note";

test("saves default TTS and Gemini voices and applies them", async ({
  page,
}) => {
  const noteId = await createNoteViaApi(
    page,
    "Výchozí hlas E2E",
    "Text pro čtení nahlas.",
  );

  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Výchozí hlasy" }),
  ).toBeVisible();

  await page.getByTestId("default-tts-voice").selectOption("george");
  await page.getByTestId("default-tts-save").click();
  await expect(
    page.getByText("Výchozí hlas čtení nahlas byl uložen."),
  ).toBeVisible();

  await page.getByTestId("default-gemini-voice").selectOption("Puck");
  await page.getByTestId("default-gemini-save").click();
  await expect(
    page.getByText("Výchozí hlas konverzace byl uložen."),
  ).toBeVisible();

  await page.goto(`/notes/${noteId}`);
  await page.getByRole("tab", { name: "Čtení nahlas" }).click();
  await expect(page.getByTestId("tts-voice")).toHaveValue("george");

  await page.goto("/voice-agent");
  await expect(page.getByLabel("Hlas Gemini")).toHaveValue("Puck");

  const origin = new URL(page.url()).origin;
  const deleted = await page.request.delete(`/api/notes/${noteId}`, {
    data: { expectedVersion: 1 },
    headers: { origin },
  });
  expect(deleted.ok()).toBe(true);
});
