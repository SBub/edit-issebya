import { describe, expect, it } from "vitest";
import { pickUtm } from "./utm";

describe("pickUtm", () => {
  it("picks only the five UTM keys", () => {
    expect(
      pickUtm({
        utm_source: "ig",
        utm_medium: "social",
        utm_campaign: "spring",
        utm_term: "reels",
        utm_content: "story",
        utm_other: "x",
        checkout: "success",
      }),
    ).toEqual({
      utm_source: "ig",
      utm_medium: "social",
      utm_campaign: "spring",
      utm_term: "reels",
      utm_content: "story",
    });
  });

  it("drops empty and whitespace-only values and trims the rest", () => {
    expect(pickUtm({ utm_source: "", utm_medium: "   ", utm_campaign: " spring " })).toEqual({
      utm_campaign: "spring",
    });
  });

  it("takes the first of repeated values", () => {
    expect(pickUtm({ utm_source: ["a", "b"] })).toEqual({ utm_source: "a" });
    expect(pickUtm({ utm_source: [] })).toEqual({});
  });

  it("caps each value at 500 characters", () => {
    expect(pickUtm({ utm_source: "a".repeat(600) }).utm_source).toHaveLength(500);
  });
});
