import { describe, expect, it } from "vitest";
import { acceptsFile, decideDrop } from "./file-drop";
import { PHOTO_ACCEPT } from "./photos";

const jpeg = { name: "sample.jpg", type: "image/jpeg" };
const clip = { name: "short-speech.mp4", type: "video/mp4" };
const text = { name: "notes.txt", type: "text/plain" };

describe("acceptsFile", () => {
  it("takes the photo library's types and refuses others", () => {
    expect(acceptsFile(PHOTO_ACCEPT, jpeg)).toBe(true);
    expect(acceptsFile(PHOTO_ACCEPT, { name: "a.png", type: "image/png" })).toBe(true);
    expect(acceptsFile(PHOTO_ACCEPT, text)).toBe(false);
    expect(acceptsFile(PHOTO_ACCEPT, clip)).toBe(false);
    expect(acceptsFile(PHOTO_ACCEPT, { name: "a.gif", type: "image/gif" })).toBe(false);
  });

  it("takes a HEIC with no type by its extension, in any case", () => {
    expect(acceptsFile(PHOTO_ACCEPT, { name: "IMG_0001.HEIC", type: "" })).toBe(true);
    expect(acceptsFile(PHOTO_ACCEPT, { name: "photo", type: "" })).toBe(false);
  });

  it("reads a family token and ignores empty tokens", () => {
    expect(acceptsFile("image/*,", jpeg)).toBe(true);
    expect(acceptsFile("image/*", clip)).toBe(false);
    expect(acceptsFile("", jpeg)).toBe(false);
  });
});

describe("decideDrop", () => {
  it("uploads one accepted file", () => {
    expect(decideDrop([jpeg], PHOTO_ACCEPT)).toEqual({ kind: "upload", file: jpeg });
  });

  it("uploads none of several files, even accepted ones", () => {
    expect(decideDrop([jpeg, jpeg], PHOTO_ACCEPT)).toEqual({ kind: "too-many" });
    expect(decideDrop([jpeg, text], PHOTO_ACCEPT)).toEqual({ kind: "too-many" });
  });

  it("refuses one file the picker would not offer, by name", () => {
    expect(decideDrop([text], PHOTO_ACCEPT)).toEqual({ kind: "refused", name: "notes.txt" });
    expect(decideDrop([clip], PHOTO_ACCEPT)).toEqual({
      kind: "refused",
      name: "short-speech.mp4",
    });
  });

  it("does nothing without a file", () => {
    expect(decideDrop([], PHOTO_ACCEPT)).toEqual({ kind: "none" });
  });
});
