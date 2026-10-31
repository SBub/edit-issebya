import { describe, expect, it } from "vitest";
import { isStorageKey } from "@edit-issebya/storage";
import { MAX_UPLOAD_BYTES, parseUploadRequest, sourceExtension, sourceKey } from "./upload";

const REEL = "0b9f6c1e-3c1d-4c8e-9a51-2f4d7b6e8a10";

// The same pattern the reels insert policy checks (20261031174750_job_queue.sql).
function policyAccepts(key: string, id: string): boolean {
  // eslint-disable-next-line security/detect-non-literal-regexp -- mirrors the policy, id is a fixed uuid
  return new RegExp(`^[a-z0-9/_-]*reels/${id}/source/original\\.[a-z0-9]{1,8}$`).test(key);
}

describe("sourceExtension", () => {
  it("accepts the supported video extensions, any case", () => {
    expect(sourceExtension("a.mp4")).toBe("mp4");
    expect(sourceExtension("A.MOV")).toBe("mov");
    expect(sourceExtension("clip.final.m4v")).toBe("m4v");
    expect(sourceExtension("x.webm")).toBe("webm");
  });

  it("refuses anything else", () => {
    expect(sourceExtension("a.avi")).toBeNull();
    expect(sourceExtension("mp4")).toBeNull();
    expect(sourceExtension("a.")).toBeNull();
  });
});

describe("sourceKey", () => {
  it("satisfies the insert policy and the storage key rule", () => {
    for (const prefix of ["", "dev/", "prod/a_b/"]) {
      const key = sourceKey(prefix, REEL, "mp4");
      expect(key).toBe(`${prefix}reels/${REEL}/source/original.mp4`);
      expect(policyAccepts(key, REEL)).toBe(true);
      expect(isStorageKey(key)).toBe(true);
    }
  });

  it("never matches another reel's id", () => {
    const other = "1b9f6c1e-3c1d-4c8e-9a51-2f4d7b6e8a10";
    expect(policyAccepts(sourceKey("dev/", other, "mp4"), REEL)).toBe(false);
  });
});

describe("parseUploadRequest", () => {
  const ok = { name: " clip.mp4 ", bytes: 1000, type: "video/mp4" };

  it("accepts a supported clip", () => {
    expect(parseUploadRequest(ok)).toEqual({
      ok: true,
      value: { name: "clip.mp4", bytes: 1000, type: "video/mp4", ext: "mp4" },
    });
    expect(parseUploadRequest({ ...ok, type: "" }).ok).toBe(true);
    expect(parseUploadRequest({ ...ok, bytes: MAX_UPLOAD_BYTES }).ok).toBe(true);
  });

  it("refuses size, type, name and extension problems", () => {
    expect(parseUploadRequest({ ...ok, bytes: 0 })).toEqual({ ok: false, reason: "empty" });
    expect(parseUploadRequest({ ...ok, bytes: 1.5 })).toEqual({ ok: false, reason: "empty" });
    expect(parseUploadRequest({ ...ok, bytes: MAX_UPLOAD_BYTES + 1 })).toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(parseUploadRequest({ ...ok, type: "image/png" })).toEqual({
      ok: false,
      reason: "type",
    });
    expect(parseUploadRequest({ ...ok, name: "  " })).toEqual({ ok: false, reason: "name" });
    expect(parseUploadRequest({ ...ok, name: `${"a".repeat(197)}.mp4` })).toEqual({
      ok: false,
      reason: "name",
    });
    expect(parseUploadRequest({ ...ok, name: "clip.avi" })).toEqual({
      ok: false,
      reason: "extension",
    });
  });
});
