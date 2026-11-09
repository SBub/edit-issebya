import { describe, expect, it } from "vitest";
import type { EngineInput } from "./engine-input.ts";
import type { EngineComponent } from "./engine-note.ts";
import { VARIANTS } from "./variants.ts";
import { pickVariants, variantOf } from "./variant-picker.ts";

const NONE: EngineInput = {
  accents: [],
  questions: [],
  big_words: [],
  visuals: [],
  lists: [],
  word_fixes: [],
};

// One pick of every kind, the answer's full shape.
const EVERY: EngineInput = {
  accents: [{ from: "w1", to: "w2" }],
  questions: [{ from: "w3", to: "w4" }],
  big_words: [{ from: "w5", to: "w5" }],
  visuals: [{ from: "w6", to: "w7" }],
  lists: [{ items: [{ from: "w8", to: "w9", key_from: "w9" }] }],
  word_fixes: [],
  hook: { text: "A hook" },
};

const COMPONENTS: EngineComponent[] = [
  "HOOK",
  "ACCENT",
  "QUESTION",
  "BIGWORD",
  "VISUAL",
  "LIST",
  "CAPTION",
];

describe("variantOf", () => {
  it("gives every component its entry", () => {
    expect(variantOf("HOOK")).toBe(VARIANTS["hook/written-line"]);
    expect(variantOf("ACCENT")).toBe(VARIANTS["accent/above-head"]);
    expect(variantOf("QUESTION")).toBe(VARIANTS["question/as-accent"]);
    expect(variantOf("BIGWORD")).toBe(VARIANTS["bigword/behind"]);
    expect(variantOf("VISUAL")).toBe(VARIANTS["visual/card"]);
    expect(variantOf("LIST")).toBe(VARIANTS["list/numbered"]);
    expect(variantOf("CAPTION")).toBe(VARIANTS["caption/default"]);
  });
});

describe("pickVariants", () => {
  it("picks every component an answer holds, and always the captions", () => {
    const picked = pickVariants(EVERY);
    expect([...picked.keys()].sort()).toEqual([...COMPONENTS].sort());
    for (const component of COMPONENTS) {
      expect(picked.get(component)).toBe(variantOf(component));
    }
  });

  it("picks only the captions for an empty answer", () => {
    expect([...pickVariants(NONE).keys()]).toEqual(["CAPTION"]);
  });

  it("picks each kind of pick by its own component, and no other", () => {
    const kinds: [keyof EngineInput, EngineComponent, Partial<EngineInput>][] = [
      ["hook", "HOOK", { hook: { text: "A hook" } }],
      ["accents", "ACCENT", { accents: [{ from: "w1", to: "w1" }] }],
      ["questions", "QUESTION", { questions: [{ from: "w1", to: "w1" }] }],
      ["big_words", "BIGWORD", { big_words: [{ from: "w1", to: "w1" }] }],
      ["visuals", "VISUAL", { visuals: [{ from: "w1", to: "w1" }] }],
      ["lists", "LIST", { lists: [{ items: [{ from: "w1", to: "w1", key_from: "w1" }] }] }],
    ];
    for (const [kind, component, pick] of kinds) {
      const keys = [...pickVariants({ ...NONE, ...pick }).keys()].sort();
      expect(keys, kind).toEqual(["CAPTION", component].sort());
    }
  });
});
