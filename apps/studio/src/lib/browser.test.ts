import { describe, expect, it } from "vitest";
import { isChromium } from "./browser";

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const FIREFOX =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:132.0) Gecko/20100101 Firefox/132.0";

describe("isChromium", () => {
  it.each([
    ["Chrome", CHROME, true],
    ["Edge", EDGE, true],
    ["Safari", SAFARI, false],
    ["Safari on iPhone", IPHONE, false],
    ["Firefox", FIREFOX, false],
  ])("%s from the user agent", (_name, userAgent, expected) => {
    expect(isChromium({ userAgent })).toBe(expected);
  });

  it("trusts client hints when present", () => {
    const brands = [{ brand: "Google Chrome" }, { brand: "Chromium" }, { brand: "Not=A?Brand" }];
    expect(isChromium({ userAgent: SAFARI, userAgentData: { brands } })).toBe(true);
    expect(isChromium({ userAgent: CHROME, userAgentData: { brands: [] } })).toBe(false);
  });
});
