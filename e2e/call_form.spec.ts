import { expect, test } from "@playwright/test";
import { CALL_REQUEST_MESSAGES } from "../src/lib/call-request";
import { ctaButton, FIELD_LABELS, formDialog, MOCK_ROUTE, VALID_FORM } from "./viewport";

// Inline validation runs before the server action, which is never called with
// invalid answers; Escape closes the dialog and focus returns to the CTA.

test.beforeEach(async ({ page, request }) => {
  expect((await request.delete(MOCK_ROUTE)).ok()).toBe(true);
  await page.goto("/");
  await ctaButton(page).click();
  await expect(formDialog(page)).toBeVisible();
});

test("an empty submit marks all six fields invalid and calls nothing", async ({
  page,
  request,
}) => {
  const dialog = formDialog(page);
  await dialog.getByRole("button", { name: "Continue to payment" }).click();
  for (const label of Object.values(FIELD_LABELS)) {
    await expect(dialog.getByLabel(label, { exact: true })).toHaveAttribute("aria-invalid", "true");
  }
  await expect(dialog.getByText(CALL_REQUEST_MESSAGES.required)).toHaveCount(6);
  const captured = await (await request.get(MOCK_ROUTE)).json();
  expect(captured.body).toBeNull();
});

test("a bad email and a non-URL link show their own messages until fixed", async ({ page }) => {
  const dialog = formDialog(page);
  for (const [field, label] of Object.entries(FIELD_LABELS)) {
    await dialog
      .getByLabel(label, { exact: true })
      .fill(VALID_FORM[field as keyof typeof VALID_FORM]);
  }
  const email = dialog.getByLabel(FIELD_LABELS.email, { exact: true });
  const link = dialog.getByLabel(FIELD_LABELS.content_link, { exact: true });
  await email.fill("not-an-email");
  await link.fill("example.com");
  await dialog.getByRole("button", { name: "Continue to payment" }).click();

  await expect(dialog.getByText(CALL_REQUEST_MESSAGES.email)).toBeVisible();
  await expect(dialog.getByText(CALL_REQUEST_MESSAGES.url)).toBeVisible();
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(email).toHaveAttribute("aria-describedby", /email-error/);
  await expect(link).toHaveAttribute("aria-invalid", "true");

  await email.fill(VALID_FORM.email);
  await link.fill(VALID_FORM.content_link);
  await expect(dialog.getByText(CALL_REQUEST_MESSAGES.email)).toHaveCount(0);
  await expect(dialog.getByText(CALL_REQUEST_MESSAGES.url)).toHaveCount(0);
  await expect(email).not.toHaveAttribute("aria-invalid", "true");
  await expect(link).not.toHaveAttribute("aria-invalid", "true");
});

test("Escape closes the dialog and focuses the CTA", async ({ page }) => {
  await page.keyboard.press("Escape");
  await expect(formDialog(page)).toBeHidden();
  await expect(ctaButton(page)).toBeFocused();
});

test("Close closes the dialog and focuses the CTA", async ({ page }) => {
  await formDialog(page).getByRole("button", { name: "Close" }).click();
  await expect(formDialog(page)).toBeHidden();
  await expect(ctaButton(page)).toBeFocused();
});
