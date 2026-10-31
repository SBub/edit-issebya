import { describe, expect, it } from "vitest";
import { r2Endpoint, r2Storage } from "./r2.ts";

describe("r2Endpoint", () => {
  it("gives the plain and the jurisdictional form", () => {
    expect(r2Endpoint("abc")).toBe("https://abc.r2.cloudflarestorage.com");
    expect(r2Endpoint("abc", "eu")).toBe("https://abc.eu.r2.cloudflarestorage.com");
    expect(r2Endpoint("abc", " ")).toBe("https://abc.r2.cloudflarestorage.com");
  });
});

describe("r2Storage.signUpload", () => {
  it("presigns a PUT on the R2 host without checksum parameters", async () => {
    const storage = r2Storage({
      accountId: "abc",
      bucket: "bucket",
      jurisdiction: "eu",
      accessKeyId: "dummy-id",
      secretAccessKey: "dummy-secret",
    });
    const url = new URL(
      await storage.signUpload("dev/reels/r1/source/original.mp4", {
        contentType: "video/mp4",
        expiresInSeconds: 900,
      }),
    );
    expect(url.host).toBe("abc.eu.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/bucket/dev/reels/r1/source/original.mp4");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    const names = [...url.searchParams.keys()].map((name) => name.toLowerCase());
    expect(names.some((name) => name.startsWith("x-amz-checksum"))).toBe(false);
    expect(names).not.toContain("x-amz-sdk-checksum-algorithm");
  });
});
