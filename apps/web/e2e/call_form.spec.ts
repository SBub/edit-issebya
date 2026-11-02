import { expect, test } from "@playwright/test";
import { CALL_REQUEST_MESSAGES } from "../src/lib/call-request";
import type { CapturedEvent } from "../src/lib/track";
import { eventNames, eventsNamed, recordEvents } from "./events";
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

// Every analytics event of the current test (e2e/events.ts).
let log: CapturedEvent[] = [];

test.beforeEach(async ({ page, request }) => {
  expect((await request.delete(MOCK_ROUTE)).ok()).toBe(true);
  log = await recordEvents(page);
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
  await expect
    .poll(() => eventsNamed(log, "call_form_invalid"))
    .toEqual([
      { event: "call_form_invalid", properties: { fields: ["name", "email"], stage: "client" } },
    ]);
  expect(eventNames(log)).not.toContain("call_form_submitted");
});

test("call_form_invalid lists the fields a bad email and a bad link fail", async ({ page }) => {
  const dialog = formDialog(page);
  await dialog.getByLabel(FIELD_LABELS.name, { exact: true }).fill(VALID_FORM.name);
  await dialog.getByLabel(FIELD_LABELS.email, { exact: true }).fill("not-an-email");
  await dialog.getByLabel("Social media links 1", { exact: true }).fill("not a link");
  await termsCheckbox(dialog).check();
  await dialog.getByRole("button", { name: "Continue to payment" }).click();
  await expect
    .poll(() => eventsNamed(log, "call_form_invalid"))
    .toEqual([
      { event: "call_form_invalid", properties: { fields: ["email", "socials"], stage: "client" } },
    ]);
});

test("each field is completed once per open, by name only, and closing reports the progress", async ({
  page,
}) => {
  const dialog = formDialog(page);
  const name = dialog.getByLabel(FIELD_LABELS.name, { exact: true });
  const email = dialog.getByLabel(FIELD_LABELS.email, { exact: true });
  // Focus left empty: not completed.
  await name.focus();
  await email.focus();
  await name.fill(VALID_FORM.name);
  await email.focus();
  // Back and away again: still once.
  await name.focus();
  await email.focus();
  await newsletterCheckbox(dialog).check();
  await termsCheckbox(dialog).check();
  await email.fill(VALID_FORM.email);
  // Escape with the email still focused: counted before the close.
  await page.keyboard.press("Escape");
  await expect(formDialog(page)).toBeHidden();

  const expected = [
    { event: "call_form_field_completed", properties: { field: "name" } },
    { event: "call_form_field_completed", properties: { field: "newsletter" } },
    { event: "call_form_field_completed", properties: { field: "terms" } },
    { event: "call_form_field_completed", properties: { field: "email" } },
    {
      event: "call_form_closed",
      properties: { fields_completed: 4, last_field: "email", started: true },
    },
  ];
  await expect
    .poll(() =>
      log.filter((e) => e.event === "call_form_field_completed" || e.event === "call_form_closed"),
    )
    .toEqual(expected);
  // Never an answer, only field names.
  const sent = JSON.stringify(log);
  expect(sent).not.toContain(VALID_FORM.name);
  expect(sent).not.toContain(VALID_FORM.email);

  // A new open starts the count again; a filled social row is "socials".
  await ctaButton(page).click();
  await dialog.getByLabel("Social media links 1", { exact: true }).fill(VALID_FORM.socials[0]);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(formDialog(page)).toBeHidden();
  await expect
    .poll(() =>
      log
        .slice(eventNames(log).indexOf("call_form_closed") + 1)
        .filter((e) => e.event === "call_form_field_completed" || e.event === "call_form_closed"),
    )
    .toEqual([
      { event: "call_form_field_completed", properties: { field: "socials" } },
      {
        event: "call_form_closed",
        properties: { fields_completed: 1, last_field: "socials", started: true },
      },
    ]);
});

test("closing an untouched form reports that it never started", async ({ page }) => {
  await formDialog(page).getByRole("button", { name: "Close" }).click();
  await expect(formDialog(page)).toBeHidden();
  await expect
    .poll(() => eventsNamed(log, "call_form_closed"))
    .toEqual([
      {
        event: "call_form_closed",
        properties: { fields_completed: 0, last_field: null, started: false },
      },
    ]);
  expect(eventNames(log)).not.toContain("call_form_field_completed");
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
