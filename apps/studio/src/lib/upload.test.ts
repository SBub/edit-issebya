import { describe, expect, it } from "vitest";
import { isStorageKey } from "@edit-issebya/storage";
import {
  MAX_UPLOAD_BYTES,
  contentTypeOf,
  PART_BYTES,
  parseSignRequest,
  parseUploadRequest,
  retryDelayMs,
  sourceExtension,
  sourceKey,
} from "./upload";

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

describe("upload limits", () => {
  it("accepts up to 1 GiB in parts of 10 MiB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(1024 ** 3);
    expect(PART_BYTES).toBe(10 * 1024 ** 2);
    // At least S3's 5 MiB minimum, and the largest file stays under 10,000 parts.
    expect(PART_BYTES).toBeGreaterThanOrEqual(5 * 1024 ** 2);
    expect(Math.ceil(MAX_UPLOAD_BYTES / PART_BYTES)).toBeLessThanOrEqual(10000);
  });
});

describe("parseSignRequest", () => {
  const key = `dev/reels/${REEL}/source/original.mp4`;
  const uploadId = "2~abc_DEF-123";

  it("recognises the four multipart requests", () => {
    expect(parseSignRequest({ method: "POST", key, expiresIn: 1 })).toEqual({
      ok: true,
      value: { kind: "create", key },
    });
    expect(parseSignRequest({ method: "PUT", key, uploadId, partNumber: 4 })).toEqual({
      ok: true,
      value: { kind: "part", key, uploadId, partNumber: 4 },
    });
    expect(parseSignRequest({ method: "GET", key, uploadId })).toEqual({
      ok: true,
      value: { kind: "list", key, uploadId },
    });
    expect(parseSignRequest({ method: "POST", key, uploadId })).toEqual({
      ok: true,
      value: { kind: "complete", key, uploadId },
    });
  });

  it("refuses a single PutObject, every DELETE and anything malformed", () => {
    for (const input of [
      null,
      "POST",
      { method: "PUT", key, contentType: "video/mp4" },
      { method: "DELETE", key },
      { method: "DELETE", key, uploadId },
      { method: "GET", key },
      { method: "HEAD", key, uploadId },
      { method: "PUT", key, uploadId },
      { method: "PUT", key, uploadId, partNumber: 0 },
      { method: "PUT", key, uploadId, partNumber: 10001 },
      { method: "PUT", key, uploadId, partNumber: 1.5 },
      { method: "PUT", key, uploadId, partNumber: "1" },
      { method: "GET", key, uploadId, partNumber: 1 },
      { method: "POST", key: "../x" },
      { method: "POST", key: "Upper.mp4" },
      { method: "POST", key: 1 },
      { method: "GET", key, uploadId: "" },
      { method: "GET", key, uploadId: "a&b=c" },
      { method: "GET", key, uploadId: "x".repeat(1025) },
    ]) {
      expect(parseSignRequest(input), JSON.stringify(input)).toEqual({ ok: false });
    }
  });
});

describe("retryDelayMs", () => {
  it("backs off, then gives up", () => {
    expect([0, 1, 2, 3, 4].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000, 15000]);
    expect(retryDelayMs(5)).toBeNull();
  });
});

describe("contentTypeOf", () => {
  it("takes the type from the key's extension", () => {
    expect(contentTypeOf(`dev/reels/${REEL}/source/original.mp4`)).toBe("video/mp4");
    expect(contentTypeOf("a/original.mov")).toBe("video/quicktime");
    expect(contentTypeOf("a/original.m4v")).toBe("video/x-m4v");
    expect(contentTypeOf("a/original.webm")).toBe("video/webm");
    expect(contentTypeOf("a/original.bin")).toBe("application/octet-stream");
  });
});
