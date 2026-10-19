import { expect, test } from "@playwright/test";
import { LANDING } from "../src/content/landing";
import { CALL_REQUEST_FIELDS } from "../src/lib/call-request";
import {
  ctaButton,
  FIELD_LABELS,
  fillValidForm,
  formDialog,
  MOCK_ROUTE,
  VALID_FORM,
} from "./viewport";

// A valid submit creates a Checkout Session through the in-process Stripe mock
// (E2E_MOCK_STRIPE=true) and lands on the thank-you state; without a key the
// dialog shows an alert and keeps the answers.

test("a valid submit goes through Checkout and back to the thank-you dialog", async ({
  page,
  request,
}) => {
  expect((await request.delete(MOCK_ROUTE)).ok()).toBe(true);
  await page.goto("/?utm_source=test&utm_campaign=spring");
  await ctaButton(page).click();
  const dialog = formDialog(page);
  await fillValidForm(dialog);
  await dialog.getByRole("button", { name: "Continue to payment" }).click();

  await page.waitForURL(/\/\?checkout=success&session_id=cs_test_e2e_/);
  await expect(page.getByRole("dialog", { name: "Thank you" })).toBeVisible();
  await expect(page.getByText(LANDING.thankYou)).toBeVisible();

  const { body } = (await (await request.get(MOCK_ROUTE)).json()) as {
    body: Record<string, string> | null;
  };
  expect(body).not.toBeNull();
  expect(body?.["mode"]).toBe("payment");
  expect(body?.["customer_email"]).toBe(VALID_FORM.email);
  expect(body?.["line_items[0][price_data][unit_amount]"]).toBe("99000");
  expect(body?.["line_items[0][price_data][currency]"]).toBe("eur");
  expect(body?.["line_items[0][price_data][tax_behavior]"]).toBe("exclusive");
  for (const field of CALL_REQUEST_FIELDS) {
    expect(body?.[`metadata[${field}]`]).toBe(VALID_FORM[field]);
  }
  expect(body?.["metadata[utm_source]"]).toBe("test");
  expect(body?.["metadata[utm_campaign]"]).toBe("spring");
  expect(body).not.toHaveProperty("metadata[utm_medium]");
});

test("without a Stripe key the dialog shows an alert and keeps the answers", async ({
  page,
  request,
}) => {
  expect((await request.post(MOCK_ROUTE, { data: { keyMissing: true } })).ok()).toBe(true);
  try {
    expect((await request.delete(MOCK_ROUTE)).ok()).toBe(true);
    await page.goto("/");
    await ctaButton(page).click();
    const dialog = formDialog(page);
    await fillValidForm(dialog);
    await dialog.getByRole("button", { name: "Continue to payment" }).click();

    await expect(dialog.getByRole("alert")).toHaveText(LANDING.unavailable);
    expect(new URL(page.url()).pathname).toBe("/");
    expect(new URL(page.url()).search).toBe("");
    for (const [field, label] of Object.entries(FIELD_LABELS)) {
      await expect(dialog.getByLabel(label, { exact: true })).toHaveValue(
        VALID_FORM[field as keyof typeof VALID_FORM],
      );
    }
    const captured = await (await request.get(MOCK_ROUTE)).json();
    expect(captured.body).toBeNull();
  } finally {
    await request.post(MOCK_ROUTE, { data: { keyMissing: false } });
  }
});
