import { ISSEBYA_PRESET, VISUAL_STAND_INS, allFontFiles, soundFiles } from "@edit-issebya/edit";
import { stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { EDIT_ASSET_FILES, editAssetUrl } from "./edit-assets";

describe("EDIT_ASSET_FILES", () => {
  it("is exactly the preset's fonts and sounds (every take of each) and the stand-in pictures, with their types", () => {
    expect(Object.fromEntries(EDIT_ASSET_FILES)).toEqual({
      ...Object.fromEntries(allFontFiles().map((file) => [file, "font/ttf"])),
      "assets/sounds/mouse-click-trimmed.wav": "audio/wav",
      "assets/sounds/camera-shutter.wav": "audio/wav",
      "assets/sounds/whoosh.wav": "audio/wav",
      "assets/sounds/pop.wav": "audio/wav",
      "assets/sounds/typing-key-1.wav": "audio/wav",
      "assets/sounds/typing-key-2.wav": "audio/wav",
      "assets/sounds/typing-key-3.wav": "audio/wav",
      "assets/sounds/typing-key-4.wav": "audio/wav",
      ...Object.fromEntries(VISUAL_STAND_INS.map((image) => [image.file, "image/jpeg"])),
    });
  });

  it("serves every sound file the builder may name", () => {
    for (const file of soundFiles(ISSEBYA_PRESET)) {
      expect(EDIT_ASSET_FILES.get(file)).toBe("audio/wav");
    }
  });
});

describe("the key sound files", () => {
  it("are committed beside the click, small enough to fetch at once", async () => {
    for (const file of ISSEBYA_PRESET.sounds.typing.files) {
      const path = new URL(`../../../../packages/edit/${file}`, import.meta.url);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed assets
      const { size } = await stat(path);
      expect(size).toBeGreaterThan(1000);
      expect(size).toBeLessThan(20_000);
    }
  });
});

describe("editAssetUrl", () => {
  it("points a preset path at the route", () => {
    expect(editAssetUrl("assets/fonts/InterTight-SemiBold.ttf")).toBe(
      "/studio/api/edit-assets/assets/fonts/InterTight-SemiBold.ttf",
    );
  });

  it("refuses a path the preset does not name", () => {
    expect(() => editAssetUrl("assets/fonts/OFL-InterTight.txt")).toThrow(/not a preset asset/);
  });
});
