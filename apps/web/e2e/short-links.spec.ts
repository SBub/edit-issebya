import { expect, test } from "@playwright/test";
import { SHORT_LINKS } from "../src/content/links";

// Short links (src/content/links.ts): each `/<slug>` is a temporary redirect
// to `/` with three UTM parameters, and the landing page renders there, so a
// link-preview crawler that follows the redirect reads the page's Open Graph
// tags.

for (const link of SHORT_LINKS) {
  test(`/${link.slug} redirects to / with its UTM tags`, async ({ page, request }) => {
    const response = await request.get(`/${link.slug}`, { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    const location = new URL(response.headers()["location"] ?? "", "http://x");
    expect(location.pathname).toBe("/");

    await page.goto(`/${link.slug}`);
    const url = new URL(page.url());
    expect(url.pathname).toBe("/");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      utm_source: link.source,
      utm_medium: link.medium,
      utm_campaign: link.campaign,
    });
    await expect(page.getByRole("heading", { level: 1, name: "edit issebya" })).toBeVisible();
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      "content",
      "edit issebya",
    );
  });
}

test("a short link keeps an extra parameter such as ?notrack", async ({ request }) => {
  const [first] = SHORT_LINKS;
  test.skip(first === undefined, "no short links registered");
  const response = await request.get(`/${first?.slug}?notrack`, { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  const location = new URL(response.headers()["location"] ?? "", "http://x");
  expect(location.pathname).toBe("/");
  expect(location.searchParams.has("notrack")).toBe(true);
  expect(location.searchParams.get("utm_campaign")).toBe(first?.campaign);
});
