import { readFile } from "node:fs/promises";
import {
  type BuildAsset,
  DEFAULT_FONT_PAIR_ID,
  FONT_PAIRS,
  fontPairFiles,
} from "@edit-issebya/edit";
import { beforeAll, describe, expect, it } from "vitest";
import { previewPage } from "./preview-page";

const GOLDEN = new URL("../../../../packages/edit/src/testdata/golden/", import.meta.url);
// The default pair's font files, once each (as the builder lists them).
const FONTS: BuildAsset[] = fontPairFiles(FONT_PAIRS[DEFAULT_FONT_PAIR_ID]).map((path) => ({
  path,
  role: "font" as const,
  ref: null,
}));
const CLIPS: BuildAsset[] = [{ path: "source.mp4", role: "footage", ref: null }];
const SOUND: BuildAsset = {
  path: "assets/sounds/mouse-click-trimmed.wav",
  role: "sound",
  ref: null,
};
const URLS = {
  footage: "https://r2.example/dev/cache/preview_copies/f/footage-preview.mp4?X-Amz-A=1&X-Amz-B=2",
};

let baseline: string;
// A page with one footage video and one sound clip (`click-visual-1`).
let request: string;
// A behind page: the footage's cut-out copies and two mask videos.
let behind: string;

beforeAll(async () => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed goldens
  baseline = await readFile(new URL("baseline-short-speech.html", GOLDEN), "utf8");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed goldens
  request = await readFile(new URL("rethink-work-request.html", GOLDEN), "utf8");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed goldens
  behind = await readFile(new URL("rethink-work-engine.html", GOLDEN), "utf8");
});

// The input's lines the transform must leave alone, and the output's.
function untouched(lines: string[]): string[] {
  return lines.filter(
    (line) =>
      !line.includes("<video ") &&
      !line.includes("@font-face ") &&
      !line.includes('data-track-index="60"'),
  );
}

describe("previewPage", () => {
  it("swaps the footage for its preview URL and buffers it ahead", () => {
    const page = previewPage(baseline, [...CLIPS, ...FONTS], URLS, []);
    expect(page).not.toContain('"source.mp4"');
    expect(page).toContain(
      ' src="https://r2.example/dev/cache/preview_copies/f/footage-preview.mp4?X-Amz-A=1&amp;X-Amz-B=2" preload="auto"',
    );
    expect(page.match(/preload="auto"/g)).toHaveLength(1);
  });

  it("plays one video for a page built from a stored version naming a cut-out", () => {
    const page = previewPage(request, [...CLIPS, ...FONTS, SOUND], URLS, ["click-visual-1"]);
    expect(page.match(/<video /g)).toHaveLength(1);
    expect(page).not.toContain("subject");
  });

  it("loads the fonts from the edit-assets route", () => {
    const page = previewPage(baseline, [...CLIPS, ...FONTS], URLS, []);
    for (const font of FONTS) {
      expect(page).toContain(`url("/studio/api/edit-assets/${font.path}")`);
    }
    expect(page).not.toContain('url("assets/');
  });

  it("drops the sound clips and changes nothing else", () => {
    const page = previewPage(request, [...CLIPS, ...FONTS, SOUND], URLS, ["click-visual-1"]);
    expect(page).not.toContain('data-track-index="60"');
    expect(page).not.toContain("<audio");
    expect(page.split("\n")).toHaveLength(request.split("\n").length - 1);
    expect(untouched(page.split("\n"))).toEqual(untouched(request.split("\n")));
  });

  it("leaves every other line of the baseline as built", () => {
    const page = previewPage(baseline, [...CLIPS, ...FONTS], URLS, []);
    expect(page.split("\n")).toHaveLength(baseline.split("\n").length);
    expect(untouched(page.split("\n"))).toEqual(untouched(baseline.split("\n")));
  });

  it("throws when an asset or a sound clip is not where the builder writes it", () => {
    const missing: BuildAsset = { path: "other.mp4", role: "footage", ref: null };
    expect(() => previewPage(baseline, [missing], URLS, [])).toThrow(/no <video> plays other.mp4/);
    expect(() => previewPage(baseline, FONTS, URLS, ["click-a"])).toThrow(/no single <audio>/);
  });

  it("swaps every footage copy and each mask of a behind page", () => {
    const mask = `masks/${"3".repeat(64)}.mp4`;
    const assets: BuildAsset[] = [...CLIPS, ...FONTS, { path: mask, role: "mask", ref: null }];
    const urls = {
      ...URLS,
      masks: [{ path: mask, url: "https://r2.example/a.mp4?s=1&t=2" }],
    };
    const page = previewPage(behind, assets, urls, ["click-visual-1", "click-big-word-1"]);
    expect(page).not.toMatch(/src="masks\//);
    expect(page).not.toContain('"source.mp4"');
    expect(page).not.toContain("<audio");
    // The footage clip and its two cut-out copies, then the two mask videos.
    expect(page.match(/footage-preview\.mp4[^"]*" preload="auto"/g)).toHaveLength(3);
    expect(
      page.match(/src="https:\/\/r2\.example\/a\.mp4\?s=1&amp;t=2" preload="auto"/g),
    ).toHaveLength(2);
  });

  it("loads each visual's stand-in picture from the edit-assets route", () => {
    const picture: BuildAsset = { path: "assets/visuals/visual-1.jpg", role: "visual", ref: null };
    const mask = `masks/${"3".repeat(64)}.mp4`;
    const assets: BuildAsset[] = [
      ...CLIPS,
      ...FONTS,
      picture,
      { path: mask, role: "mask", ref: null },
    ];
    const urls = { ...URLS, masks: [{ path: mask, url: "https://r2.example/a.mp4?s=1&t=2" }] };
    const page = previewPage(behind, assets, urls, ["click-visual-1", "click-big-word-1"]);
    expect(page).toContain(
      '<img src="/studio/api/edit-assets/assets/visuals/visual-1.jpg" alt="">',
    );
    expect(page).not.toMatch(/src="assets\/visuals\//);
  });

  it("throws for a visual picture the page does not show", () => {
    const picture: BuildAsset = { path: "assets/visuals/visual-3.jpg", role: "visual", ref: null };
    expect(() => previewPage(baseline, [picture], URLS, [])).toThrow(/no <img> plays/);
  });

  it("throws for a mask without a URL", () => {
    const mask: BuildAsset = { path: `masks/${"3".repeat(64)}.mp4`, role: "mask", ref: null };
    expect(() => previewPage(behind, [mask], URLS, [])).toThrow(`preview: no URL for ${mask.path}`);
  });
});
