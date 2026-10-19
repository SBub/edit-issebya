import { expect, test, type Page } from "@playwright/test";
import { LANDING } from "../src/content/landing";
import { waitForPageReady } from "./viewport";

// Written out, not read from LANDING, so a wrong constant fails here.
const WHATSAPP_TEXT = "Hi, I saw your reel editing offer and have a few questions before I start";

const LEGAL = [
  { path: "/terms", title: "Terms and conditions" },
  { path: "/privacy", title: "Privacy policy" },
];

const SIZES = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
];

async function boxOf(page: Page, locator: ReturnType<Page["getByRole"]>) {
  const box = await locator.boundingBox();
  expect(box, "element has a bounding box").not.toBeNull();
  return box!;
}

test.describe("WhatsApp link", () => {
  for (const path of ["/", "/terms", "/privacy"]) {
    test(`"Message me here" on ${path} opens the WhatsApp chat in a new tab`, async ({ page }) => {
      await page.goto(path);
      const link = page.getByRole("link", { name: LANDING.questions.link });
      const href = await link.getAttribute("href");
      expect(href).not.toBeNull();
      const url = new URL(href!);
      expect(url.origin).toBe("https://wa.me");
      expect(url.pathname).toBe("/351920742845");
      expect(url.searchParams.get("text")).toBe(WHATSAPP_TEXT);
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", /noopener/);
    });
  }
});

test.describe("brand position", () => {
  for (const size of SIZES) {
    for (const legal of LEGAL) {
      test(`${legal.path} keeps the landing brand's place at ${size.width}x${size.height}`, async ({
        page,
      }) => {
        await page.setViewportSize(size);
        await page.goto("/");
        await waitForPageReady(page);
        const landing = await boxOf(
          page,
          page.getByRole("heading", { level: 1, name: "edit issebya" }),
        );

        await page.goto(legal.path);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const brand = await boxOf(page, page.getByRole("link", { name: "edit issebya, home" }));
        const title = await boxOf(page, page.getByRole("heading", { level: 1, name: legal.title }));

        expect(Math.abs(brand.x - landing.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(brand.y - landing.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(title.x - brand.x)).toBeLessThanOrEqual(1);
      });
    }
  }
});
