import { expect, test, type Page } from "@playwright/test";
import { ctaButton, fillValidForm, formDialog, MOCK_ROUTE } from "./viewport";

// The early-bird price: the first 4 paid sessions of the offer pay 590 EUR +
// VAT, everyone after 990. The sold count comes from the mocked Stripe
// sessions list, set through the mock route's soldCount toggle (DELETE resets
// it to 0).

test.beforeEach(async ({ request }) => {
  expect((await request.delete(MOCK_ROUTE)).ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
  await request.delete(MOCK_ROUTE);
});

function offer(page: Page) {
  return page.getByRole("region", { name: "Offer" });
}

async function checkoutBody(page: Page, request: Page["request"]) {
  await ctaButton(page).click();
  const dialog = formDialog(page);
  await fillValidForm(dialog);
  await dialog.getByRole("button", { name: "Continue to payment" }).click();
  await page.waitForURL(/\/\?checkout=success&session_id=cs_test_e2e_/);
  const { body } = (await (await request.get(MOCK_ROUTE)).json()) as {
    body: Record<string, string> | null;
  };
  expect(body).not.toBeNull();
  return body ?? {};
}

test("while spots remain the page shows 590 with 990 struck through and charges 59000", async ({
  page,
}) => {
  expect((await page.request.post(MOCK_ROUTE, { data: { soldCount: 3 } })).ok()).toBe(true);
  await page.goto("/");
  const box = offer(page);
  await expect(box.getByText("590 EUR + VAT", { exact: true })).toBeVisible();
  const struck = box.locator("s");
  await expect(struck).toHaveText("was 990 EUR + VAT");
  await expect(struck.locator(".sr-only")).toHaveText("was");
  await expect(
    box.getByText("First 4 clients only, 1 of 4 spots left", { exact: true }),
  ).toBeVisible();

  const body = await checkoutBody(page, page.request);
  expect(body["line_items[0][price_data][unit_amount]"]).toBe("59000");
  expect(body["metadata[price_tier]"]).toBe("early");
  expect(body["metadata[offer]"]).toBe("reels-8");
});

test("with no spots sold all 4 are left", async ({ page }) => {
  await page.goto("/");
  await expect(
    offer(page).getByText("First 4 clients only, 4 of 4 spots left", { exact: true }),
  ).toBeVisible();
});

test("after 4 sold the page shows only 990 and charges 99000", async ({ page }) => {
  expect((await page.request.post(MOCK_ROUTE, { data: { soldCount: 4 } })).ok()).toBe(true);
  await page.goto("/");
  const box = offer(page);
  await expect(box.getByText("990 EUR + VAT", { exact: true })).toBeVisible();
  await expect(box.getByText("590 EUR + VAT")).toHaveCount(0);
  await expect(box.locator("s")).toHaveCount(0);
  await expect(box.getByText(/spots left/)).toHaveCount(0);

  const body = await checkoutBody(page, page.request);
  expect(body["line_items[0][price_data][unit_amount]"]).toBe("99000");
  expect(body["metadata[price_tier]"]).toBe("standard");
  expect(body["metadata[offer]"]).toBe("reels-8");
});

test("the price is counted again at checkout, not taken from the page", async ({ page }) => {
  await page.goto("/");
  await expect(offer(page).getByText("590 EUR + VAT", { exact: true })).toBeVisible();
  // The last spot sells while this buyer is on the page.
  expect((await page.request.post(MOCK_ROUTE, { data: { soldCount: 4 } })).ok()).toBe(true);
  const body = await checkoutBody(page, page.request);
  expect(body["line_items[0][price_data][unit_amount]"]).toBe("99000");
  expect(body["metadata[price_tier]"]).toBe("standard");
});

test("without a Stripe key the page shows the full price", async ({ page }) => {
  expect((await page.request.post(MOCK_ROUTE, { data: { keyMissing: true } })).ok()).toBe(true);
  try {
    await page.goto("/");
    await expect(offer(page).getByText("990 EUR + VAT", { exact: true })).toBeVisible();
    await expect(offer(page).locator("s")).toHaveCount(0);
  } finally {
    await page.request.post(MOCK_ROUTE, { data: { keyMissing: false } });
  }
});
