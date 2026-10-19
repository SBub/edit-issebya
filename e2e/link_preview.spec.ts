import { expect, test, type Page } from "@playwright/test";
import { LANDING } from "../src/content/landing";

// Link previews (WhatsApp, iMessage, LinkedIn): the Open Graph and Twitter
// tags on `/`, and the generated images they point to. The absolute URLs are
// built on metadataBase, which may name another port than the test server,
// so the images are fetched by path.

async function meta(page: Page, attr: "property" | "name", key: string): Promise<string> {
  const content = await page.locator(`meta[${attr}="${key}"]`).first().getAttribute("content");
  expect(content, key).not.toBeNull();
  return content ?? "";
}

function expectAbsolute(url: string) {
  expect(url).toMatch(/^https?:\/\/[^/]+\//);
}

test("/ has Open Graph and Twitter tags with absolute image URLs", async ({ page, request }) => {
  await page.goto("/");
  expect(await meta(page, "property", "og:title")).toBe("edit issebya");
  expect(await meta(page, "property", "og:description")).toBe(LANDING.quote);
  expect(await meta(page, "property", "og:site_name")).toBe("edit issebya");
  expect(await meta(page, "property", "og:type")).toBe("website");
  expect(await meta(page, "property", "og:image:width")).toBe("1200");
  expect(await meta(page, "property", "og:image:height")).toBe("630");
  expect(await meta(page, "property", "og:image:alt")).not.toBe("");
  expect(await meta(page, "name", "description")).toBe(LANDING.quote);
  expect(await meta(page, "name", "twitter:description")).toBe(LANDING.quote);
  expect(await meta(page, "name", "twitter:card")).toBe("summary_large_image");

  const ogImage = await meta(page, "property", "og:image");
  const twitterImage = await meta(page, "name", "twitter:image");
  for (const url of [ogImage, twitterImage]) {
    expectAbsolute(url);
    const { pathname, search } = new URL(url);
    const response = await request.get(`${pathname}${search}`);
    expect(response.status(), url).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
  }
  expect(new URL(ogImage).pathname).toBe("/opengraph-image");
});

test("/opengraph-image and the favicon are PNGs", async ({ request }) => {
  for (const path of ["/opengraph-image", "/twitter-image"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
  }
});

test("/ links a PNG icon", async ({ page, request }) => {
  await page.goto("/");
  const href = await page
    .locator('link[rel="icon"][type="image/png"]')
    .first()
    .getAttribute("href");
  expect(href).not.toBeNull();
  const response = await request.get(href ?? "");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/png");
});

test("/ links a 180x180 PNG Apple touch icon", async ({ page, request }) => {
  await page.goto("/");
  const link = page.locator('link[rel="apple-touch-icon"]').first();
  await expect(link).toHaveAttribute("sizes", "180x180");
  const response = await request.get((await link.getAttribute("href")) ?? "");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/png");
});
