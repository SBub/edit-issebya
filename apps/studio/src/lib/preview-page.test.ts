import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { previewPage } from "./preview-page";

// eslint-disable-next-line security/detect-non-literal-fs-filename -- the edit package's golden page
const golden = readFileSync(
  new URL(
    "../../../../packages/edit/src/testdata/built/rethink-work-accents.html",
    import.meta.url,
  ),
  "utf8",
);

const ASSETS = [
  { role: "font", path: "assets/fonts/GolosText-Bold.ttf" },
  { role: "font", path: "assets/fonts/Raleway-Light.ttf" },
  { role: "sound", path: "assets/sounds/mouse-click-trimmed.wav" },
  { role: "footage", path: "footage.mp4" },
  { role: "cutout", path: "subject.webm" },
] as const;

const URLS: Record<string, string> = {
  "assets/fonts/GolosText-Bold.ttf": "/studio/api/edit-assets/fonts/GolosText-Bold.ttf",
  "assets/fonts/Raleway-Light.ttf": "/studio/api/edit-assets/fonts/Raleway-Light.ttf",
  "footage.mp4": "https://r2.example/cache/preview_copies/f/footage.mp4?sig=1",
  "subject.webm": "https://r2.example/cache/preview_copies/f/subject.webm?sig=2",
};

describe("previewPage", () => {
  it("leaves no <audio> line and no relative asset path", () => {
    expect(golden).toContain("<audio ");
    const page = previewPage(golden, [...ASSETS], URLS);
    expect(page).not.toContain("<audio");
    for (const asset of ASSETS) {
      expect(page).not.toContain(`"${asset.path}"`);
    }
    expect(page).toContain(`src="${URLS["footage.mp4"]}"`);
    expect(page).toContain(`url("${URLS["assets/fonts/Raleway-Light.ttf"]}")`);
  });

  it("changes nothing but the audio lines and the asset paths", () => {
    const page = previewPage(golden, [...ASSETS], URLS);
    let back = page;
    for (const [path, url] of Object.entries(URLS)) back = back.split(url).join(path);
    const withoutAudio = golden
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("<audio "))
      .join("\n");
    expect(back).toBe(withoutAudio);
  });

  it("escapes a URL inside an attribute", () => {
    const page = previewPage(golden, [...ASSETS], {
      ...URLS,
      "footage.mp4": 'https://r2.example/f.mp4?a=1&b="2"',
    });
    expect(page).toContain('src="https://r2.example/f.mp4?a=1&amp;b=&quot;2&quot;"');
  });

  it("throws on an asset without a URL", () => {
    const { "subject.webm": _, ...missing } = URLS;
    expect(() => previewPage(golden, [...ASSETS], missing)).toThrow("no URL for subject.webm");
  });
});
