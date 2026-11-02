import { describe, expect, it } from "vitest";
import { isChromium } from "./browser";

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const FIREFOX =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:132.0) Gecko/20100101 Firefox/132.0";

describe("isChromium", () => {
  it("reads the Chromium brand when userAgentData exists", () => {
    const brands = [{ brand: "Google Chrome" }, { brand: "Chromium" }, { brand: "Not?A_Brand" }];
    expect(isChromium({ userAgent: "", userAgentData: { brands } })).toBe(true);
    expect(isChromium({ userAgent: CHROME, userAgentData: { brands: [{ brand: "Other" }] } })).toBe(
      false,
    );
  });

  it("falls back to the user agent string", () => {
    expect(isChromium({ userAgent: CHROME })).toBe(true);
    expect(
      isChromium({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chromium/130.0 Safari/537.36" }),
    ).toBe(true);
  });

  it("is false for Safari, iPhone and Firefox", () => {
    expect(isChromium({ userAgent: SAFARI })).toBe(false);
    expect(isChromium({ userAgent: IPHONE })).toBe(false);
    expect(isChromium({ userAgent: FIREFOX })).toBe(false);
  });
});
