import { describe, expect, it } from "vitest";
import type { EngineComponent } from "./engine-note.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import { STYLES, VARIANTS, type TextStyle, type Variant } from "./variants.ts";

const COMPONENTS: EngineComponent[] = [
  "HOOK",
  "ACCENT",
  "QUESTION",
  "BIGWORD",
  "VISUAL",
  "LIST",
  "CAPTION",
];

const entries = Object.entries(VARIANTS) as [string, Variant][];

describe("the variant entries", () => {
  it("has one entry per component", () => {
    for (const component of COMPONENTS) {
      const of = entries.filter(([, entry]) => entry.component === component);
      expect(
        of.map(([name]) => name),
        component,
      ).toHaveLength(1);
    }
    expect(entries).toHaveLength(COMPONENTS.length);
  });

  it("keys each entry by its own name, `<component>/<name>` in lower-case words and hyphens", () => {
    for (const [name, entry] of entries) {
      expect(entry.variant).toBe(name);
      expect(name).toMatch(/^[a-z]+\/[a-z-]+$/);
      expect(name.split("/")[0]).toBe(entry.component.toLowerCase());
    }
  });

  it("holds the spec's fields: zones best first, timing, and whether the words leave the captions", () => {
    expect(
      Object.fromEntries(
        entries.map(([name, entry]) => [name, [entry.zones, entry.timing, entry.hides]]),
      ),
    ).toEqual({
      "hook/written-line": [
        ["upper-third", "anywhere-in-safe-zone"],
        { option: "window", from: 0.2, to: 3 },
        false,
      ],
      "accent/above-head": [
        ["above-head", "upper-third", "anywhere-in-safe-zone"],
        { option: "words" },
        true,
      ],
      "question/as-accent": [
        ["above-head", "upper-third", "anywhere-in-safe-zone"],
        { option: "words" },
        true,
      ],
      "bigword/behind": [["head-top"], { option: "words-lead", lead: 0.2, minimum: 1.5 }, true],
      "visual/card": [
        ["corner", "beside-face"],
        { option: "words-min-max", minimum: 1, maximum: 2 },
        false,
      ],
      "list/numbered": [
        ["upper-third", "anywhere-in-safe-zone"],
        { option: "words-entrance", entrance: 0.3 },
        true,
      ],
      "caption/default": [
        ["beside-face", "below-face", "caption-line", "anywhere-in-safe-zone"],
        { option: "caption-groups" },
        false,
      ],
    });
  });

  it("puts behind on the big word only, a box on the visual only, and the stack on the list", () => {
    expect(entries.filter(([, entry]) => entry.layer === "behind").map(([name]) => name)).toEqual([
      "bigword/behind",
    ]);
    expect(entries.filter(([, entry]) => entry.type === "box").map(([name]) => name)).toEqual([
      "visual/card",
    ]);
    expect(VARIANTS["visual/card"]).toMatchObject({ aspect: "4/5", width: "1/3" });
    expect(VARIANTS["list/numbered"].levels.map((level) => level.role)).toEqual([
      "number",
      "lead",
      "key",
    ]);
  });

  it("gives every text and level a style of the table: the base size is the style's, never the entry's", () => {
    const styles = new Set<TextStyle>(Object.values(STYLES));
    const named = entries.flatMap(([, entry]) =>
      entry.type === "box" ? [] : entry.levels ? entry.levels.map((l) => l.style) : [entry.style],
    );
    for (const style of named) expect(styles.has(style)).toBe(true);
    // Two entries on the same style share one base by construction.
    expect(VARIANTS["hook/written-line"].style).toBe(VARIANTS["accent/above-head"].style);
    expect(VARIANTS["question/as-accent"].style).toBe(VARIANTS["accent/above-head"].style);
    expect(VARIANTS["list/numbered"].levels[2]!.style).toBe(STYLES.accent);
    expect(VARIANTS["list/numbered"].levels[1]!.style).toBe(STYLES.caption);
    // Today's values: the bases are the preset's font sizes (110, 50), so the
    // builder's fallback size and the style agree while both exist.
    expect(STYLES.accent.base).toBe(ISSEBYA_PRESET.fonts.primary.size);
    expect(STYLES.caption.base).toBe(ISSEBYA_PRESET.fonts.secondary.size);
    // The one largest-fit style is the big word's, and only the big word has it.
    expect(STYLES.bigWord.base).toBe("largest-fit");
    expect(
      entries
        .filter(
          ([, entry]) => entry.style && "base" in entry.style && entry.style.base === "largest-fit",
        )
        .map(([name]) => name),
    ).toEqual(["bigword/behind"]);
  });

  it("rejects a wrong field or an unknown zone at compile time", () => {
    // @ts-expect-error a text takes no aspect
    const wrongField: Variant = { ...VARIANTS["accent/above-head"], aspect: "4/5" };
    // @ts-expect-error `nowhere` is not a zone of the zone table
    const unknownZone: Variant = { ...VARIANTS["accent/above-head"], zones: ["nowhere"] };
    expect([wrongField, unknownZone]).toHaveLength(2);
  });
});
