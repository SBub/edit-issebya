import { expect, test, type Page } from "@playwright/test";
import { LANDING } from "../src/content/landing";
import { LEGAL } from "../src/content/legal";
import { eventsNamed, recordEvents } from "./events";
import { ctaButton, formDialog, termsCheckbox, waitForPageReady } from "./viewport";

// Written out, not read from LANDING, so a wrong constant fails here.
const WHATSAPP_TEXT = "Hi, I saw your reel editing offer and have a few questions before I start";

const LEGAL_PAGES = [
  { path: "/terms", title: "Terms and conditions" },
  { path: "/privacy", title: "Privacy policy" },
];

const SIZES = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
];

async function boxOf(locator: ReturnType<Page["getByRole"]>) {
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

  for (const [path, location] of [
    ["/", "offer"],
    ["/terms", "terms"],
    ["/privacy", "privacy"],
  ] as const) {
    test(`a click on "Message me here" on ${path} sends message_clicked from ${location}`, async ({
      page,
      context,
    }) => {
      // The new tab never reaches WhatsApp.
      await context.route("https://wa.me/**", (route) => route.fulfill({ body: "" }));
      const log = await recordEvents(page);
      await page.goto(path);
      const popup = page.waitForEvent("popup");
      await page.getByRole("link", { name: LANDING.questions.link }).click();
      await (await popup).close();
      await expect
        .poll(() => eventsNamed(log, "message_clicked"))
        .toEqual([{ event: "message_clicked", properties: { location } }]);
    });
  }
});

test.describe("brand position", () => {
  for (const size of SIZES) {
    for (const legal of LEGAL_PAGES) {
      test(`${legal.path} keeps the landing brand's place at ${size.width}x${size.height}`, async ({
        page,
      }) => {
        await page.setViewportSize(size);
        await page.goto("/");
        await waitForPageReady(page);
        const landing = await boxOf(page.getByRole("heading", { level: 1, name: "edit issebya" }));

        await page.goto(legal.path);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const brand = await boxOf(page.getByRole("link", { name: "edit issebya, home" }));
        const title = await boxOf(page.getByRole("heading", { level: 1, name: legal.title }));

        expect(Math.abs(brand.x - landing.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(brand.y - landing.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(title.x - brand.x)).toBeLessThanOrEqual(1);
      });
    }
  }
});

test("the privacy policy has the GDPR sections, the CNPD and a contact", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.getByText("Draft: placeholders pending.", { exact: true })).toHaveCount(0);
  await expect(page.getByText(`Last updated: ${LEGAL.lastUpdated}`, { exact: true })).toBeVisible();
  for (const title of [
    "Who is responsible",
    "What we collect",
    "Why we use it, and on what legal basis",
    "Who we share it with",
    "How long we keep it",
    "Your rights",
    "Cookies and analytics",
    "Contact",
    "Applicable law",
  ]) {
    await expect(page.getByRole("heading", { level: 2, name: title, exact: true })).toBeVisible();
  }
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: LEGAL.email }).first()).toHaveAttribute(
    "href",
    `mailto:${LEGAL.email}`,
  );
  await expect(main.getByRole("link", { name: /CNPD/ })).toHaveAttribute(
    "href",
    "https://www.cnpd.pt",
  );
  for (const processor of ["Stripe", "Resend", "PostHog", "Google", "Vercel"]) {
    await expect(main.getByRole("region", { name: "Who we share it with" })).toContainText(
      processor,
    );
  }
  await expect(
    main.getByRole("region", { name: "Why we use it, and on what legal basis" }),
  ).toContainText("portfolio");
  // Cookieless analytics: nothing stored on the device, legitimate interest.
  const cookies = main.getByRole("region", { name: "Cookies and analytics" });
  await expect(cookies).toContainText("no cookies, no local storage and no session");
  await expect(cookies).toContainText("legitimate");
  await expect(main).not.toContainText("[[");
  await expect(main).not.toContainText("\u2014");
});

test("the terms cover the provider, the service, withdrawal and complaints", async ({ page }) => {
  await page.goto("/terms");
  const main = page.getByRole("main");
  await expect(page.getByText("Draft: placeholders pending.", { exact: true })).toHaveCount(0);
  for (const title of [
    "Who we are",
    "The service",
    "Reel length",
    "Price and payment",
    "Your footage and the footage window",
    "Revisions",
    "Your content",
    "Cancellation and right of withdrawal",
    "Liability",
    "Events outside our control",
    "Changes to these terms",
    "Personal data",
    "Complaints and disputes",
    "Applicable law",
  ]) {
    await expect(page.getByRole("heading", { level: 2, name: title, exact: true })).toBeVisible();
  }
  const provider = main.getByRole("region", { name: "Who we are" });
  for (const fact of [LEGAL.ownerName, LEGAL.nif, LEGAL.address, LEGAL.email]) {
    await expect(provider).toContainText(fact);
  }
  const price = main.getByRole("region", { name: "Price and payment" });
  await expect(price).toContainText("590 EUR");
  await expect(price).toContainText("990 EUR");
  await expect(price).toContainText("article 53");
  const reelLength = main.getByRole("region", { name: "Reel length" });
  await expect(reelLength).toContainText("up to 2 minutes counts as 2 reels");
  await expect(reelLength).toContainText("2 minutes and 10 seconds counts as 3 reels");
  await expect(
    main.getByRole("region", { name: "Your footage and the footage window" }),
  ).toContainText("expire and are not refunded");
  await expect(main.getByRole("region", { name: "Revisions" })).toContainText(
    "one round of revisions",
  );
  await expect(main.getByRole("region", { name: "Your content" })).toContainText(
    "unless you tell us not to",
  );
  const withdrawal = main.getByRole("region", { name: "Cancellation and right of withdrawal" });
  await expect(withdrawal).toContainText("14 days");
  await expect(withdrawal).toContainText("Model withdrawal form");
  await expect(withdrawal).toContainText("no statutory right of withdrawal applies");
  await expect(withdrawal).toContainText("Work starts once the visual identity process begins");
  await expect(withdrawal).not.toContainText("ask us to start");
  await expect(withdrawal).toContainText("minus the value of the work already done");
  await expect(withdrawal).toContainText(
    "Once all the work is delivered, you can no longer withdraw",
  );
  await expect(main.getByRole("region", { name: "Who we are" })).toContainText(
    "buying it for their business",
  );
  const complaints = main.getByRole("region", { name: "Complaints and disputes" });
  await expect(complaints.getByRole("link", { name: LEGAL.complaintsBook })).toHaveAttribute(
    "href",
    LEGAL.complaintsBook,
  );
  await expect(complaints.getByRole("link", { name: LEGAL.adrEntity.name })).toHaveAttribute(
    "href",
    LEGAL.adrEntity.url,
  );
  // Every placeholder is filled in.
  await expect(main).not.toContainText("[[");
  await expect(main).not.toContainText("\u2014");
});

test("the terms checkbox keeps its plain wording", async ({ page }) => {
  await page.goto("/");
  await ctaButton(page).click();
  const dialog = formDialog(page);
  await expect(termsCheckbox(dialog)).toHaveAccessibleName(
    "I agree to the terms and conditions and the privacy policy",
  );
  await expect(dialog.getByRole("checkbox")).toHaveCount(2);
});

test("the reel-length note on / opens the terms at the reel-length section", async ({ page }) => {
  await page.goto("/");
  const link = page.getByRole("link", { name: "terms of service apply" });
  await expect(link).toHaveAttribute("href", "/terms#reel-length");
  await link.click();
  await expect(page).toHaveURL(/\/terms#reel-length$/);
  await expect(page.getByRole("heading", { level: 2, name: "Reel length" })).toBeInViewport();
});

test("the footer links the complaints book next to the legal pages", async ({ page }) => {
  await page.goto("/");
  const link = page
    .getByRole("navigation", { name: "Legal" })
    .getByRole("link", { name: LANDING.complaintsBook.label });
  await expect(link).toHaveAttribute("href", "https://www.livroreclamacoes.pt");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
});

test("the terms link to the privacy policy for personal data", async ({ page }) => {
  await page.goto("/terms");
  await expect(
    page.getByRole("main").getByRole("link", { name: "privacy policy", exact: true }),
  ).toHaveAttribute("href", "/privacy");
});
