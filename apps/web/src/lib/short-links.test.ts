import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHORT_LINKS, type ShortLink } from "@/content/links";
import { pickUtm } from "./utm";
import { shortLinkRedirects, shortLinkTarget } from "./short-links";

const SLUG = /^[a-z0-9-]+$/;
// Values go into a redirect destination; this alphabet needs no escaping and
// cannot be read as a path parameter (`:name`) by Next.
const UTM_VALUE = /^[a-z0-9-]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Routes and files a redirect would shadow (redirects run before the
// filesystem). The list is read from src/app and public/ so a new route is
// covered without editing this test; the fixed names are framework paths and
// metadata files that may not exist yet. Vitest runs from the repository root.
function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

const RESERVED = new Set([
  ...readdirSync("src/app").map(stripExtension),
  ...readdirSync("public").map(stripExtension),
  "terms",
  "privacy",
  "api",
  "opengraph-image",
  "twitter-image",
  "icon",
  "apple-icon",
  "favicon",
  "robots",
  "sitemap",
  "manifest",
  "_next",
]);

const link: ShortLink = {
  slug: "x",
  source: "whatsapp",
  medium: "group",
  campaign: "female-founders-lisbon",
  label: "Female Founders Lisbon",
  posted: null,
};

describe("shortLinkTarget", () => {
  it("builds / with the three UTM parameters, in order", () => {
    const target = new URL(shortLinkTarget(link), "https://x");
    expect(target.pathname).toBe("/");
    expect([...target.searchParams]).toEqual([
      ["utm_source", "whatsapp"],
      ["utm_medium", "group"],
      ["utm_campaign", "female-founders-lisbon"],
    ]);
  });

  it("encodes values the way URLSearchParams does", () => {
    const target = shortLinkTarget({ ...link, campaign: "a b&c" });
    expect(target.endsWith("=a+b%26c")).toBe(true);
    expect(new URL(target, "https://x").searchParams.get("utm_campaign")).toBe("a b&c");
  });

  it("round-trips through pickUtm, as the landing page reads it", () => {
    const params = Object.fromEntries(new URL(shortLinkTarget(link), "https://x").searchParams);
    expect(pickUtm(params)).toEqual({
      utm_source: "whatsapp",
      utm_medium: "group",
      utm_campaign: "female-founders-lisbon",
    });
  });
});

describe("shortLinkRedirects", () => {
  it("makes one temporary redirect per slug", () => {
    expect(shortLinkRedirects([link, { ...link, slug: "y" }])).toEqual([
      { source: "/x", destination: shortLinkTarget(link), permanent: false },
      { source: "/y", destination: shortLinkTarget(link), permanent: false },
    ]);
  });
});

describe("SHORT_LINKS", () => {
  it("has entries", () => {
    expect(SHORT_LINKS.length).toBeGreaterThan(0);
  });

  it.each(SHORT_LINKS.map((l) => [l.slug, l]))("%s is a lowercase [a-z0-9-] slug", (_, l) => {
    expect(l.slug).toMatch(SLUG);
  });

  it.each(SHORT_LINKS.map((l) => [l.slug, l]))("%s does not shadow a route or file", (_, l) => {
    expect(RESERVED.has(l.slug), `${l.slug} collides with an existing route or file`).toBe(false);
  });

  it.each(SHORT_LINKS.map((l) => [l.slug, l]))("%s has valid UTM values and date", (_, l) => {
    expect(l.source).toMatch(UTM_VALUE);
    expect(l.medium).toMatch(UTM_VALUE);
    expect(l.campaign).toMatch(UTM_VALUE);
    expect(l.label.trim()).not.toBe("");
    if (l.posted !== null) {
      expect(l.posted).toMatch(ISO_DATE);
      expect(new Date(`${l.posted}T00:00:00Z`).toISOString().slice(0, 10)).toBe(l.posted);
    }
  });

  it("has no duplicate slugs", () => {
    const slugs = SHORT_LINKS.map((l) => l.slug);
    expect(slugs.filter((s, i) => slugs.indexOf(s) !== i)).toEqual([]);
  });

  it("knows the reserved routes (the collision check is not vacuous)", () => {
    for (const name of ["terms", "privacy", "api", "opengraph-image", "reels"]) {
      expect(RESERVED.has(name)).toBe(true);
    }
  });
});
