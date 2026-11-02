import { readFile } from "node:fs/promises";
import type { BuildAsset } from "@edit-issebya/edit";
import { beforeAll, describe, expect, it } from "vitest";
import { previewPage } from "./preview-page";

const GOLDEN = new URL("../../../../packages/edit/src/testdata/golden/", import.meta.url);
const FONTS: BuildAsset[] = [
  { path: "assets/fonts/GolosText-Bold.ttf", role: "font", ref: null },
  { path: "assets/fonts/Raleway-Light.ttf", role: "font", ref: null },
];
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
  it("swaps the footage for its preview URL and buffers it ahead", () => {
    const page = previewPage(baseline, [...CLIPS, ...FONTS], URLS, []);
    expect(page).not.toContain('"source.mp4"');
    expect(page).toContain(
      ' src="https://r2.example/dev/cache/preview_copies/f/footage-preview.mp4?X-Amz-A=1&amp;X-Amz-B=2" preload="auto"',
    );
    expect(page.match(/preload="auto"/g)).toHaveLength(1);
  });

  it("plays one video for a page built from a stored version naming a cut-out", () => {
    const page = previewPage(hand, [...CLIPS, ...FONTS, SOUND], URLS, ["s-fund-life"]);
    expect(page.match(/<video /g)).toHaveLength(1);
    expect(page).not.toContain("subject");
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

  it("swaps every footage copy, each mask and each photo of a behind page", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed goldens
    const behind = await readFile(new URL("rethink-work-behind.html", GOLDEN), "utf8");
    const photo = "3f6c1a52-8e4d-4b7a-9c21-5d0e8f7b6a14";
    const maskA = `masks/${"1".repeat(64)}.mp4`;
    const maskB = `masks/${"2".repeat(64)}.mp4`;
    const assets: BuildAsset[] = [
      ...CLIPS,
      ...FONTS,
      { path: maskA, role: "mask", ref: null },
      { path: maskB, role: "mask", ref: null },
      { path: `photos/${photo}.jpg`, role: "photo", ref: null, photoId: photo },
    ];
    const urls = {
      ...URLS,
      masks: [
        { path: maskA, url: "https://r2.example/a.mp4?s=1&t=2" },
        { path: maskB, url: "https://r2.example/b.mp4" },
      ],
      photos: [{ path: `photos/${photo}.jpg`, url: "https://r2.example/large.jpg?s=1" }],
    };
    const page = previewPage(behind, assets, urls, ["s-fund-life"]);
    expect(page).not.toMatch(/src="(masks|photos)\//);
    expect(page).not.toContain('"source.mp4"');
    // The footage clip and the four footage copies, then the four mask videos.
    expect(page.match(/footage-preview\.mp4[^"]*" preload="auto"/g)).toHaveLength(5);
    expect(
      page.match(/src="https:\/\/r2\.example\/a\.mp4\?s=1&amp;t=2" preload="auto"/g),
    ).toHaveLength(2);
    expect(page).toContain(' src="https://r2.example/large.jpg?s=1" alt=""');
  });

  it("throws for a mask or a photo without a URL, or one the page does not show", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed goldens
    const behind = await readFile(new URL("rethink-work-behind.html", GOLDEN), "utf8");
    const mask: BuildAsset = { path: `masks/${"1".repeat(64)}.mp4`, role: "mask", ref: null };
    expect(() => previewPage(behind, [mask], URLS, [])).toThrow(`preview: no URL for ${mask.path}`);
    const absent: BuildAsset = { path: "photos/none.jpg", role: "photo", ref: null };
    expect(() =>
      previewPage(behind, [absent], { ...URLS, photos: [{ path: absent.path, url: "u" }] }, []),
    ).toThrow("preview: no <img> plays photos/none.jpg");
  });
});
