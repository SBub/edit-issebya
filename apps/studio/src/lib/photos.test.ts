import { describe, expect, it } from "vitest";
import {
  LIBRARY_INTRO,
  LIBRARY_INTRO_EMPTY,
  MAX_PHOTO_BYTES,
  PHOTO_ACCEPT,
  PHOTO_COLUMNS,
  PHOTO_STATUSES,
  PHOTO_TYPES,
  formatDimensions,
  isPhotoId,
  libraryIntro,
  parsePhotoUpload,
  photoBadge,
  photoKey,
  photoTileLabel,
} from "./photos";

const ID = "0b9f6c1e-3c1d-4c8e-9a51-2f4d7b6e8a10";

describe("parsePhotoUpload", () => {
  it("accepts each type with its extension", () => {
    for (const [type, ext] of Object.entries(PHOTO_TYPES)) {
      expect(parsePhotoUpload({ name: `a.${ext}`, size: 10, type })).toEqual({
        ok: true,
        value: { name: `a.${ext}`, size: 10, contentType: type, ext },
      });
    }
  });

  it("accepts HEIC and HEIF by extension when the browser gives no type", () => {
    expect(parsePhotoUpload({ name: "IMG_1.HEIC", size: 10, type: "" })).toMatchObject({
      ok: true,
      value: { contentType: "image/heic", ext: "heic" },
    });
    expect(parsePhotoUpload({ name: "b.heif", size: 10, type: "" })).toMatchObject({
      ok: true,
      value: { contentType: "image/heif", ext: "heif" },
    });
    expect(parsePhotoUpload({ name: "c.jpg", size: 10, type: "" })).toEqual({
      ok: false,
      reason: "type",
    });
  });

  it("refuses another type, an empty or oversized file and a bad name", () => {
    expect(parsePhotoUpload({ name: "a.gif", size: 10, type: "image/gif" })).toEqual({
      ok: false,
      reason: "type",
    });
    expect(parsePhotoUpload({ name: "a.mp4", size: 10, type: "video/mp4" })).toMatchObject({
      reason: "type",
    });
    expect(parsePhotoUpload({ name: "a.jpg", size: 0, type: "image/jpeg" })).toMatchObject({
      reason: "empty",
    });
    expect(parsePhotoUpload({ name: "a.jpg", size: 1.5, type: "image/jpeg" })).toMatchObject({
      reason: "empty",
    });
    expect(
      parsePhotoUpload({ name: "a.jpg", size: MAX_PHOTO_BYTES + 1, type: "image/jpeg" }),
    ).toMatchObject({ reason: "too-large" });
    expect(
      parsePhotoUpload({ name: "a.jpg", size: MAX_PHOTO_BYTES, type: "image/jpeg" }),
    ).toMatchObject({ ok: true });
    expect(parsePhotoUpload({ name: " ", size: 10, type: "image/jpeg" })).toMatchObject({
      reason: "name",
    });
    expect(
      parsePhotoUpload({ name: `${"a".repeat(252)}.jpg`, size: 10, type: "image/jpeg" }),
    ).toMatchObject({ reason: "name" });
    expect(parsePhotoUpload({ name: 3, size: "10", type: null })).toMatchObject({ ok: false });
  });

  it("is 25 MiB at most", () => {
    expect(MAX_PHOTO_BYTES).toBe(26214400);
  });
});

describe("photo keys and ids", () => {
  it("puts the original under the prefix's library folder", () => {
    expect(photoKey("dev/", ID, "heic")).toBe(`dev/library/${ID}/original.heic`);
    expect(photoKey("", ID, "jpg")).toBe(`library/${ID}/original.jpg`);
  });

  it("checks an id is a lower-case uuid", () => {
    expect(isPhotoId(ID)).toBe(true);
    expect(isPhotoId(ID.toUpperCase())).toBe(false);
    expect(isPhotoId("../x")).toBe(false);
    expect(isPhotoId(undefined)).toBe(false);
  });

  it("names its columns, keys included (server only)", () => {
    expect(PHOTO_COLUMNS).not.toContain("*");
    expect(PHOTO_COLUMNS).toContain("thumbnail_key");
    expect(PHOTO_STATUSES).toEqual(["uploading", "describing", "ready", "failed"]);
  });

  it("offers the types and the HEIC extensions to the picker", () => {
    expect(PHOTO_ACCEPT).toBe("image/jpeg,image/png,image/heic,image/heif,image/webp,.heic,.heif");
  });

  it("formats dimensions once measured", () => {
    expect(formatDimensions(1200, 900)).toBe("1200 x 900");
    expect(formatDimensions(null, 900)).toBeNull();
  });
});

describe("library tiles", () => {
  it("shows no badge for a ready photo and every other status", () => {
    expect(photoBadge("ready")).toBeUndefined();
    expect(photoBadge("uploading")).toBe("uploading");
    expect(photoBadge("describing")).toBe("describing");
    expect(photoBadge("failed")).toBe("failed");
    expect(PHOTO_STATUSES.filter((status) => photoBadge(status) === undefined)).toEqual(["ready"]);
  });

  it("names each tile by its file name, and its status while not ready", () => {
    expect(photoTileLabel({ fileName: "a.jpg", status: "ready" })).toBe("a.jpg");
    expect(photoTileLabel({ fileName: "b.heic", status: "failed" })).toBe("b.heic, failed");
    expect(photoTileLabel({ fileName: "c.png", status: "describing" })).toBe("c.png, describing");
  });
});

describe("library intro", () => {
  it("invites the first photo while the library is empty, then says what photos do", () => {
    expect(libraryIntro(0)).toBe(LIBRARY_INTRO_EMPTY);
    expect(LIBRARY_INTRO_EMPTY).toBe(
      "Add photos of your work, places or products. When you talk about them, they can appear behind you in your reels.",
    );
    expect(libraryIntro(1)).toBe(LIBRARY_INTRO);
    expect(libraryIntro(12)).toBe(LIBRARY_INTRO);
    expect(LIBRARY_INTRO).toBe(
      "Photos you add here can appear in your reels, placed behind you when they fit what you're saying",
    );
  });
});
