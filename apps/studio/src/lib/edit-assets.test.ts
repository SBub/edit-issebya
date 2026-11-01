import { ISSEBYA_PRESET } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import { EDIT_ASSET_FILES, editAssetUrl } from "./edit-assets";

describe("EDIT_ASSET_FILES", () => {
  it("is exactly the preset's fonts and sounds, with their types", () => {
    expect(Object.fromEntries(EDIT_ASSET_FILES)).toEqual({
      [ISSEBYA_PRESET.fonts.primary.file]: "font/ttf",
      [ISSEBYA_PRESET.fonts.secondary.file]: "font/ttf",
      [ISSEBYA_PRESET.sounds.click.file]: "audio/wav",
    });
  });
});

describe("editAssetUrl", () => {
  it("points a preset path at the route", () => {
    expect(editAssetUrl("assets/fonts/Raleway-Light.ttf")).toBe(
      "/studio/api/edit-assets/assets/fonts/Raleway-Light.ttf",
    );
  });

  it("refuses a path the preset does not name", () => {
    expect(() => editAssetUrl("assets/fonts/OFL-Raleway.txt")).toThrow(/not a preset asset/);
  });
});
