import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { build } from "./build.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import { parseEdit, type Edit } from "./schema.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";
import {
  DEFAULT_FONT_PAIR_ID,
  FONT_PAIR_IDS,
  FONT_PAIRS,
  FONT_ROLES,
  allFontFiles,
  fontPairFiles,
  isFontPairId,
} from "./font-pairs.ts";

const ASSETS = new URL("../assets/fonts/", import.meta.url);

// The table tags of a TrueType file: a static instance has no `fvar`.
async function tableTags(file: string): Promise<string[]> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- packages/edit's own font assets
  const data = await readFile(new URL(file.replace("assets/fonts/", ""), ASSETS));
  const count = data.readUInt16BE(4);
  return Array.from({ length: count }, (_, index) =>
    data.toString("latin1", 12 + 16 * index, 16 + 16 * index),
  );
}

describe("FONT_PAIRS", () => {
  it("holds the six approved pairs, classic first and the default", () => {
    expect(FONT_PAIR_IDS).toEqual([
      "classic",
      "script",
      "signature",
      "handwritten",
      "retro",
      "bold",
    ]);
    expect(Object.keys(FONT_PAIRS)).toEqual([...FONT_PAIR_IDS]);
    expect(DEFAULT_FONT_PAIR_ID).toBe("classic");
  });

  it("names each role's font with its family, weight and style, and what it stands in for", () => {
    expect(FONT_PAIRS.classic.simple).toMatchObject({
      family: "Inter Tight SemiBold",
      weight: 600,
      style: "normal",
    });
    expect(FONT_PAIRS.classic.artistic).toMatchObject({
      family: "Playfair Display Italic",
      weight: 400,
      style: "italic",
    });
    expect(FONT_PAIRS.bold.simple).toMatchObject({ weight: 900 });
    for (const pair of Object.values(FONT_PAIRS)) {
      expect(pair.standsInFor.length).toBeGreaterThan(0);
      expect(pair.label.length).toBeGreaterThan(0);
    }
  });

  it("recognises only the six ids", () => {
    expect(isFontPairId("retro")).toBe(true);
    expect(isFontPairId("primary")).toBe(false);
    expect(isFontPairId(undefined)).toBe(false);
  });
});

describe("font files", () => {
  it("are exactly the files the pairs name, each present on disk", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- packages/edit's own font assets
    const onDisk = (await readdir(ASSETS)).filter((name) => name.endsWith(".ttf"));
    expect(allFontFiles().map((file) => file.replace("assets/fonts/", ""))).toEqual(onDisk.sort());
  });

  it("are static TrueType instances: no variation table, so HarfBuzz measures the drawn face", async () => {
    for (const file of allFontFiles()) {
      const tags = await tableTags(file);
      expect(tags, file).toContain("glyf");
      expect(tags, file).not.toContain("fvar");
    }
  });

  it("are the same files in each pair's two roles, with no retired font left", () => {
    for (const id of FONT_PAIR_IDS) {
      const files = fontPairFiles(FONT_PAIRS[id]);
      expect(files.length, id).toBeGreaterThanOrEqual(1);
      expect(files.length, id).toBeLessThanOrEqual(FONT_ROLES.length);
    }
    expect(allFontFiles().some((file) => /Raleway|GolosText/.test(file))).toBe(false);
  });
});

describe("a version's font pair", () => {
  const fixture = FIXTURES.find((item) => item.name === "rethink-work-engine")!;

  it("is recorded on the edit and refused when missing, with the reason, never read as classic", () => {
    expect(fixture.edit.font_pair).toBe("classic");
    const stored = structuredClone(fixture.edit) as Partial<Edit>;
    delete stored.font_pair;
    const parsed = parseEdit(stored, ISSEBYA_PRESET, fixture.transcript);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.reasons).toEqual([
      expect.stringMatching(/^font_pair: a font pair is required/),
    ]);
  });

  it("refuses an unknown pair id", () => {
    const stored = { ...structuredClone(fixture.edit), font_pair: "primary" };
    expect(parseEdit(stored, ISSEBYA_PRESET, fixture.transcript).ok).toBe(false);
  });

  it("is refused by the builder when the measurer shaped another pair", async () => {
    const measurer = await nodeMeasurer(FONT_PAIRS.script);
    expect(() =>
      build(fixture.edit, fixture.transcript, fixture.headTrack, ISSEBYA_PRESET, measurer),
    ).toThrow(/set in classic, measured in script/);
  });
});
