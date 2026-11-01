import { readFile } from "node:fs/promises";
import type { BuildAsset } from "@edit-issebya/edit";
import { beforeAll, describe, expect, it } from "vitest";
import { previewPage } from "./preview-page";

const GOLDEN = new URL("../../../../packages/edit/src/testdata/golden/", import.meta.url);
const FONTS: BuildAsset[] = [
  { path: "assets/fonts/GolosText-Bold.ttf", role: "font", ref: null },
  { path: "assets/fonts/Raleway-Light.ttf", role: "font", ref: null },
];
const CLIPS: BuildAsset[] = [
  { path: "source.mp4", role: "footage", ref: null },
  { path: "subject.webm", role: "cutout", ref: null },
];
const SOUND: BuildAsset = {
  path: "assets/sounds/mouse-click-trimmed.wav",
  role: "sound",
  ref: null,
};
const URLS = {
  footage: "https://r2.example/dev/cache/preview_copies/f/footage-preview.mp4?X-Amz-A=1&X-Amz-B=2",
  cutout: "/studio/api/e2e-storage-mock/dev/cache/preview_copies/f/subject-preview.webm",
};

let baseline: string;
let hand: string;

beforeAll(async () => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed goldens
  baseline = await readFile(new URL("baseline-short-speech.html", GOLDEN), "utf8");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed goldens
  hand = await readFile(new URL("rethink-work-hand.html", GOLDEN), "utf8");
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
  it("swaps the clips for the preview URLs and buffers them ahead", () => {
    const page = previewPage(baseline, [...CLIPS, ...FONTS], URLS, []);
    expect(page).not.toContain('"source.mp4"');
    expect(page).not.toContain('"subject.webm"');
    expect(page).toContain(
      ' src="https://r2.example/dev/cache/preview_copies/f/footage-preview.mp4?X-Amz-A=1&amp;X-Amz-B=2" preload="auto"',
    );
    expect(page).toContain(` src="${URLS.cutout}" preload="auto"`);
    expect(page.match(/preload="auto"/g)).toHaveLength(2);
  });

  it("loads the fonts from the edit-assets route", () => {
    const page = previewPage(baseline, [...CLIPS, ...FONTS], URLS, []);
    expect(page).toContain('url("/studio/api/edit-assets/assets/fonts/Raleway-Light.ttf")');
    expect(page).toContain('url("/studio/api/edit-assets/assets/fonts/GolosText-Bold.ttf")');
    expect(page).not.toContain('url("assets/');
  });

  it("drops the sound clips and changes nothing else", () => {
    const page = previewPage(hand, [...CLIPS, ...FONTS, SOUND], URLS, ["s-fund-life"]);
    expect(page).not.toContain('data-track-index="60"');
    expect(page).not.toContain("<audio");
    expect(page.split("\n")).toHaveLength(hand.split("\n").length - 1);
    expect(untouched(page.split("\n"))).toEqual(untouched(hand.split("\n")));
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
});
