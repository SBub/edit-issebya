import { expect, test } from "@playwright/test";
import { LANDING } from "../src/content/landing";
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
  expect(body?.["line_items[0][price_data][product_data][name]"]).toBe(
    "8 reels, each under 1 minute",
  );
  expect(body?.["line_items[0][price_data][product_data][description]"]).toBe(
    "Visual identity, recording guide and 30 days to send footage",
  );
  // The dev server's origin is http://localhost, which Stripe cannot fetch: no thumbnail.
  expect(Object.keys(body ?? {}).some((key) => key.includes("[product_data][images]"))).toBe(false);
  expect(body?.["branding_settings[display_name]"]).toBe("edit issebya");
  expect(body?.["branding_settings[background_color]"]).toBe("#ffffff");
  expect(body?.["branding_settings[button_color]"]).toBe("#a21caf");
  expect(body?.["branding_settings[border_style]"]).toBe("rounded");
  expect(body?.["custom_text[submit][message]"]).toBe(LANDING.afterPurchase);
  expect(Object.keys(body ?? {}).some((key) => key.startsWith("consent_collection"))).toBe(false);
  expect(body?.["metadata[name]"]).toBe(VALID_FORM.name);
  expect(body?.["metadata[email]"]).toBe(VALID_FORM.email);
  // https:// added to the bare host, one link per line.
  expect(body?.["metadata[socials]"]).toBe("https://instagram.com/ana\nhttps://ana.example.com/");
  expect(body?.["metadata[terms_accepted]"]).toBe("true");
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
    await expect(dialog.getByLabel(FIELD_LABELS.name, { exact: true })).toHaveValue(
      VALID_FORM.name,
    );
    await expect(dialog.getByLabel(FIELD_LABELS.email, { exact: true })).toHaveValue(
      VALID_FORM.email,
    );
    await expect(dialog.getByLabel("Social media links 2", { exact: true })).toHaveValue(
      VALID_FORM.socials[1],
    );
    await expect(dialog.getByRole("checkbox")).toBeChecked();
    const captured = await (await request.get(MOCK_ROUTE)).json();
    expect(captured.body).toBeNull();
  } finally {
    await request.post(MOCK_ROUTE, { data: { keyMissing: false } });
  }
});
