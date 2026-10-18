import { describe, expect, it } from "vitest";
import { siteUrl } from "./site-url";

const VERCEL = "edit-issebya.vercel.app";

describe("siteUrl", () => {
  it("returns NEXT_PUBLIC_SITE_URL as given when it is clean", () => {
    expect(siteUrl({ NEXT_PUBLIC_SITE_URL: "https://edit.issebya.com" })).toBe(
      "https://edit.issebya.com",
    );
  });

  it("strips a trailing comma, slashes and whitespace", () => {
    expect(siteUrl({ NEXT_PUBLIC_SITE_URL: "  https://edit.issebya.com/, \n" })).toBe(
      "https://edit.issebya.com",
    );
  });

  it("falls back to the Vercel production domain when the value is invalid or unset", () => {
    expect(
      siteUrl({ NEXT_PUBLIC_SITE_URL: "edit.issebya.com", VERCEL_PROJECT_PRODUCTION_URL: VERCEL }),
    ).toBe(`https://${VERCEL}`);
    expect(siteUrl({ VERCEL_PROJECT_PRODUCTION_URL: VERCEL })).toBe(`https://${VERCEL}`);
  });

  it("falls back to the local server when nothing is set", () => {
    expect(siteUrl({})).toBe("http://localhost:3000");
    expect(siteUrl({ NEXT_PUBLIC_SITE_URL: "ftp://edit.issebya.com" })).toBe(
      "http://localhost:3000",
    );
  });
});
