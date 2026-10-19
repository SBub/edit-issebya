import { expect, test } from "@playwright/test";
import { CALL_REQUEST_MESSAGES } from "../src/lib/call-request";
import {
  ctaButton,
  FIELD_LABELS,
  formDialog,
  MOCK_ROUTE,
  VALID_FORM,
  newsletterCheckbox,
  termsCheckbox,
} from "./viewport";

// Inline validation runs before the server action, which is never called with
// invalid answers; Escape closes the dialog and focus returns to the CTA.

test.beforeEach(async ({ page, request }) => {
  expect((await request.delete(MOCK_ROUTE)).ok()).toBe(true);
  await page.goto("/");
  await ctaButton(page).click();
  await expect(formDialog(page)).toBeVisible();
});

test("the submit button is disabled until the terms box is ticked", async ({ page }) => {
  const dialog = formDialog(page);
  const submit = dialog.getByRole("button", { name: "Continue to payment" });
  await expect(submit).toBeDisabled();
  await termsCheckbox(dialog).check();
  await expect(submit).toBeEnabled();
  await termsCheckbox(dialog).uncheck();
  await expect(submit).toBeDisabled();
});

test("the newsletter box is optional, unticked and never enables the submit button", async ({
  page,
}) => {
  const dialog = formDialog(page);
  const submit = dialog.getByRole("button", { name: "Continue to payment" });
  const newsletter = newsletterCheckbox(dialog);
  await expect(newsletter).toBeVisible();
  await expect(newsletter).not.toBeChecked();
  await expect(newsletter).not.toHaveAttribute("required", /.*/);
  await newsletter.check();
  await expect(submit).toBeDisabled();
  await termsCheckbox(dialog).check();
  await expect(submit).toBeEnabled();
  await newsletter.uncheck();
  await expect(submit).toBeEnabled();
});

// With the button disabled, a missing terms tick never reaches the client
// validator; the server action still rejects it (unit-tested in
// src/lib/call-request.test.ts).
test("an empty submit with terms ticked marks name and email invalid and calls nothing", async ({
  page,
  request,
}) => {
  const dialog = formDialog(page);
  await termsCheckbox(dialog).check();
  await dialog.getByRole("button", { name: "Continue to payment" }).click();
  for (const label of Object.values(FIELD_LABELS)) {
    await expect(dialog.getByLabel(label, { exact: true })).toHaveAttribute("aria-invalid", "true");
  }
  await expect(termsCheckbox(dialog)).not.toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByText(CALL_REQUEST_MESSAGES.required)).toHaveCount(2);
  await expect(dialog.getByText(CALL_REQUEST_MESSAGES.terms)).toHaveCount(0);
  // Socials are optional: an empty row is not an error.
  await expect(dialog.getByText(CALL_REQUEST_MESSAGES.url)).toHaveCount(0);
  const captured = await (await request.get(MOCK_ROUTE)).json();
  expect(captured.body).toBeNull();
});

test("social rows are added with + and removed with x", async ({ page }) => {
  const dialog = formDialog(page);
  await expect(dialog.getByRole("button", { name: /^Remove link/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Add another link" }).click();
  await dialog.getByRole("button", { name: "Add another link" }).click();
  await expect(dialog.getByLabel(/^Social media links \d$/)).toHaveCount(3);
  await dialog.getByRole("button", { name: "Remove link 2" }).click();
  await expect(dialog.getByLabel(/^Social media links \d$/)).toHaveCount(2);
});

test("a bad email and a bad link show their own messages until fixed", async ({ page }) => {
  const dialog = formDialog(page);
  await dialog.getByLabel(FIELD_LABELS.name, { exact: true }).fill(VALID_FORM.name);
  await termsCheckbox(dialog).check();
  const email = dialog.getByLabel(FIELD_LABELS.email, { exact: true });
  const link = dialog.getByLabel("Social media links 1", { exact: true });
  await email.fill("not-an-email");
  await link.fill("not a link");
  await dialog.getByRole("button", { name: "Continue to payment" }).click();

  await expect(dialog.getByText(CALL_REQUEST_MESSAGES.email)).toBeVisible();
  await expect(dialog.getByText(CALL_REQUEST_MESSAGES.url)).toBeVisible();
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(email).toHaveAttribute("aria-describedby", /email-error/);
  await expect(link).toHaveAttribute("aria-invalid", "true");

  await email.fill(VALID_FORM.email);
  await link.fill(VALID_FORM.socials[0]);
  await expect(dialog.getByText(CALL_REQUEST_MESSAGES.email)).toHaveCount(0);
  await expect(dialog.getByText(CALL_REQUEST_MESSAGES.url)).toHaveCount(0);
  await expect(email).not.toHaveAttribute("aria-invalid", "true");
  await expect(link).not.toHaveAttribute("aria-invalid", "true");
});

test("the terms and privacy links open their pages", async ({ page }) => {
  const dialog = formDialog(page);
  await expect(dialog.getByRole("link", { name: "terms and conditions" })).toHaveAttribute(
    "href",
    "/terms",
  );
  await expect(dialog.getByRole("link", { name: "privacy policy" })).toHaveAttribute(
    "href",
    "/privacy",
  );
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
