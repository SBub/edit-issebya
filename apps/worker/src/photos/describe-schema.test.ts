import { describe, expect, it } from "vitest";
import { describeJsonSchema, parseDescribeAnswer } from "./describe-schema.ts";

const GOOD = {
  description: "A colourful test pattern with bars and a moving circle.",
  tags: ["test pattern", "colour bars", "abstract"],
};

describe("describeJsonSchema", () => {
  it("is a closed draft-07 object with the real limits", () => {
    expect(describeJsonSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(describeJsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["description", "tags"],
      properties: {
        description: { type: "string", minLength: 1, maxLength: 200 },
        tags: { type: "array", minItems: 3, maxItems: 8, items: { type: "string" } },
      },
    });
  });
});

describe("parseDescribeAnswer", () => {
  it("accepts a good answer", () => {
    expect(parseDescribeAnswer(GOOD)).toEqual({ ok: true, answer: GOOD });
  });

  it("refuses 2 tags, 9 tags, an upper-case tag, a long description and an extra field", () => {
    const refused = [
      { ...GOOD, tags: ["one", "two"] },
      { ...GOOD, tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] },
      { ...GOOD, tags: ["Test pattern", "colour bars", "abstract"] },
      { ...GOOD, description: "x".repeat(201) },
      { ...GOOD, mood: "calm" },
      null,
    ];
    for (const answer of refused) {
      const parsed = parseDescribeAnswer(answer);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reasons.length).toBeGreaterThan(0);
    }
    const tags = parseDescribeAnswer({ ...GOOD, tags: ["one", "two"] });
    expect(tags).toEqual({ ok: false, reasons: [expect.stringMatching(/^tags: /)] });
  });
});
