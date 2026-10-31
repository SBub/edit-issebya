import { expect, test } from "@playwright/test";

const ASSET = /\/studio-static\/_next\/[^"'\s)]+/;

test("the landing address serves the studio and its static files", async ({ request, page }) => {
  const response = await request.get("/studio");
  expect(response.status()).toBe(200);
  const html = await response.text();
  const asset = html.match(ASSET)?.[0];
  expect(asset, "no /studio-static/_next/ asset in the studio's HTML").toBeTruthy();

  const assetResponse = await request.get(asset!);
  expect(assetResponse.status()).toBe(200);

  // The studio's own login form, not Supabase's dashboard on another port.
  await page.goto("/studio");
  await expect(page.getByRole("button", { name: "Send sign-in link" })).toBeVisible();
});
