import { describe, expect, it } from "vitest";
import { r2Endpoint, r2Storage } from "./r2.ts";

describe("r2Endpoint", () => {
  it("gives the plain and the jurisdictional form", () => {
    expect(r2Endpoint("abc")).toBe("https://abc.r2.cloudflarestorage.com");
    expect(r2Endpoint("abc", "eu")).toBe("https://abc.eu.r2.cloudflarestorage.com");
    expect(r2Endpoint("abc", " ")).toBe("https://abc.r2.cloudflarestorage.com");
  });
});

const KEY = "dev/reels/r1/source/original.mp4";
const UPLOAD_ID = "2~abc_DEF-123.x/y+z=";

function storage() {
  return r2Storage({
    accountId: "abc",
    bucket: "bucket",
    jurisdiction: "eu",
    accessKeyId: "dummy-id",
    secretAccessKey: "dummy-secret",
  });
}

// Host, path, expiry and no checksum parameter (the browser cannot send them).
function expectPresigned(raw: string, expires: string): URL {
  const url = new URL(raw);
  expect(url.host).toBe("abc.eu.r2.cloudflarestorage.com");
  expect(url.pathname).toBe(`/bucket/${KEY}`);
  expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
  expect(url.searchParams.get("X-Amz-Expires")).toBe(expires);
  const names = [...url.searchParams.keys()].map((name) => name.toLowerCase());
  expect(names.some((name) => name.startsWith("x-amz-checksum"))).toBe(false);
  expect(names).not.toContain("x-amz-sdk-checksum-algorithm");
  return url;
}

describe("r2Storage multipart signers", () => {
  it("presigns the create with its Content-Type header", async () => {
    const { url, headers } = await storage().signCreateMultipart(KEY, {
      contentType: "video/mp4",
      expiresInSeconds: 900,
    });
    expect(expectPresigned(url, "900").searchParams.has("uploads")).toBe(true);
    expect(headers).toEqual({ "Content-Type": "video/mp4" });
  });

  it("presigns a part with its number and upload id", async () => {
    const url = expectPresigned(
      await storage().signUploadPart(KEY, {
        uploadId: UPLOAD_ID,
        partNumber: 3,
        expiresInSeconds: 600,
      }),
      "600",
    );
    expect(url.searchParams.get("partNumber")).toBe("3");
    expect(url.searchParams.get("uploadId")).toBe(UPLOAD_ID);
  });

  it("presigns the list and the complete with the upload id", async () => {
    const s = storage();
    const options = { uploadId: UPLOAD_ID, expiresInSeconds: 900 };
    for (const raw of [
      await s.signListParts(KEY, options),
      await s.signCompleteMultipart(KEY, options),
    ]) {
      const url = expectPresigned(raw, "900");
      expect(url.searchParams.get("uploadId")).toBe(UPLOAD_ID);
      expect(url.searchParams.has("partNumber")).toBe(false);
    }
  });

  it("refuses an invalid key, upload id or part number", async () => {
    const s = storage();
    const options = { uploadId: UPLOAD_ID, partNumber: 1, expiresInSeconds: 60 };
    await expect(s.signUploadPart("../x", options)).rejects.toThrow(/invalid storage key/);
    await expect(
      s.signCreateMultipart("Upper.mp4", { contentType: "video/mp4", expiresInSeconds: 60 }),
    ).rejects.toThrow(/invalid storage key/);
    for (const uploadId of ["", "a&b=c", "a b", "x".repeat(1025)]) {
      await expect(s.signUploadPart(KEY, { ...options, uploadId })).rejects.toThrow(
        /invalid upload id/,
      );
      await expect(s.signListParts(KEY, { uploadId, expiresInSeconds: 60 })).rejects.toThrow(
        /invalid upload id/,
      );
    }
    for (const partNumber of [0, 10001, 1.5]) {
      await expect(s.signUploadPart(KEY, { ...options, partNumber })).rejects.toThrow(
        /part number/,
      );
    }
  });
});
