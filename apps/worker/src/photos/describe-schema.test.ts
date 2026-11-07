import { describe, expect, it } from "vitest";
import { describeJsonSchema, parseDescribeAnswer, shortenDescription } from "./describe-schema.ts";

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

  it("refuses 2 tags, an upper-case tag, an empty description and an extra field", () => {
    const refused = [
      { ...GOOD, tags: ["one", "two"] },
      { ...GOOD, tags: ["Test pattern", "colour bars", "abstract"] },
      { ...GOOD, description: "" },
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

describe("parseDescribeAnswer on a long answer", () => {
  it("shortens a long description instead of refusing it", () => {
    const description = `${"A woman walks a dog along a wide sandy beach at sunset. ".repeat(4)}`;
    const parsed = parseDescribeAnswer({ ...GOOD, description });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.answer.description.length).toBeLessThanOrEqual(200);
      expect(parsed.answer.description).toBe(shortenDescription(description));
    }
  });

  it("keeps the first 8 tags and drops a tag over 30 characters", () => {
    const tags = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    expect(parseDescribeAnswer({ ...GOOD, tags })).toEqual({
      ok: true,
      answer: { ...GOOD, tags: tags.slice(0, 8) },
    });
    const long = "a".repeat(31);
    expect(parseDescribeAnswer({ ...GOOD, tags: [long, ...GOOD.tags] })).toEqual({
      ok: true,
      answer: GOOD,
    });
  });

  it("still refuses fewer than 3 tags once the long ones are dropped", () => {
    const parsed = parseDescribeAnswer({ ...GOOD, tags: ["a".repeat(31), "beach", "sunset"] });
    expect(parsed).toEqual({ ok: false, reasons: [expect.stringMatching(/^tags: /)] });
  });
});

describe("shortenDescription", () => {
  it("leaves a description within the limit as it is", () => {
    expect(shortenDescription(GOOD.description)).toBe(GOOD.description);
    const exact = "x".repeat(200);
    expect(shortenDescription(exact)).toBe(exact);
  });

  it("cuts at the last sentence end within the limit", () => {
    const first = `${"A long first sentence about the beach and the sea ".repeat(2).trim()}.`;
    const second = "Then the dog runs off into the waves! The sky goes pink over the far hills.";
    const text = `${first} ${second} ${"More words follow here. ".repeat(5)}`;
    const short = shortenDescription(text, 160);
    expect(short).toBe(`${first} ${second.split("! ")[0]}!`);
  });

  it("counts a sentence end whose space sits just past the limit", () => {
    const text = `${"word ".repeat(19)}ends. More text after it.`;
    expect(shortenDescription(text, 100)).toBe(`${"word ".repeat(19)}ends.`);
  });

  it("cuts at the last word when the only sentence end keeps under half", () => {
    const text = `Short one. ${"plenty of words, ".repeat(20)}`;
    const short = shortenDescription(text, 100);
    expect(short.length).toBeLessThanOrEqual(100);
    expect(text.startsWith(short)).toBe(true);
    expect(short).toMatch(/words$/);
    expect(text.charAt(short.length + 1)).toBe(" ");
  });

  it("never ends on a comma, a dash or a space, and never mid-word", () => {
    const text = `A quiet street, ${"lamps, ".repeat(40)}`;
    const short = shortenDescription(text, 50);
    expect(short).toMatch(/lamps$/);
    expect(short.length).toBeLessThanOrEqual(50);
    expect(shortenDescription(`${"a ".repeat(23)}b - ${"c".repeat(20)}`, 50)).toMatch(/b$/);
  });

  it("cuts one word longer than the limit hard", () => {
    expect(shortenDescription("x".repeat(250))).toBe("x".repeat(200));
  });

  it("gives 200 characters or fewer for any long description", () => {
    const words = ["sun", "sea,", "a dog.", "light", "pink!", "x".repeat(40), "sky?", "-"];
    for (let seed = 1; seed <= 50; seed += 1) {
      const text = Array.from({ length: 80 }, (_, i) => words[(i * seed) % words.length]).join(" ");
      const short = shortenDescription(text);
      expect(short.length).toBeGreaterThan(0);
      expect(short.length).toBeLessThanOrEqual(200);
      expect(text.startsWith(short)).toBe(true);
    }
  });
});
