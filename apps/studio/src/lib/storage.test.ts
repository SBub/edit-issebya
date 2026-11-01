import { describe, expect, it } from "vitest";
import { keyPrefix, studioStorage } from "./storage";

const R2 = {
  R2_ACCOUNT_ID: "abc",
  R2_BUCKET: "bucket",
  R2_JURISDICTION: "eu",
  R2_STUDIO_ACCESS_KEY_ID: "id",
  R2_STUDIO_SECRET_ACCESS_KEY: "secret",
  R2_KEY_PREFIX: "dev/",
};
const OPTIONS = { uploadId: "a".repeat(32), partNumber: 1, expiresInSeconds: 60 };

describe("studioStorage", () => {
  it("gives the fake under the exact flag", async () => {
    const storage = studioStorage({ ...R2, E2E_MOCK_STORAGE: "true" });
    expect(await storage?.signUploadPart("dev/a.mp4", OPTIONS)).toBe(
      `/studio/api/e2e-storage-mock/dev/a.mp4?partNumber=1&uploadId=${"a".repeat(32)}`,
    );
  });

  it("gives R2 with the studio's keys otherwise", async () => {
    for (const flag of [undefined, "1", "TRUE"]) {
      const storage = studioStorage({ ...R2, E2E_MOCK_STORAGE: flag });
      const url = new URL((await storage?.signUploadPart("dev/a.mp4", OPTIONS)) ?? "");
      expect(url.host).toBe("abc.eu.r2.cloudflarestorage.com");
    }
  });

  it("is null when a variable is missing or the prefix is malformed", () => {
    expect(studioStorage({})).toBeNull();
    expect(studioStorage({ ...R2, R2_BUCKET: " " })).toBeNull();
    expect(studioStorage({ ...R2, R2_KEY_PREFIX: "../" })).toBeNull();
  });

  it("ignores the worker's keys", () => {
    const { R2_STUDIO_ACCESS_KEY_ID: _id, R2_STUDIO_SECRET_ACCESS_KEY: _secret, ...rest } = R2;
    expect(
      studioStorage({
        ...rest,
        R2_WORKER_ACCESS_KEY_ID: "wid",
        R2_WORKER_SECRET_ACCESS_KEY: "wsecret",
      }),
    ).toBeNull();
  });
});

describe("keyPrefix", () => {
  it("trims, allows empty and refuses malformed prefixes", () => {
    expect(keyPrefix({})).toBe("");
    expect(keyPrefix({ R2_KEY_PREFIX: " dev/ " })).toBe("dev/");
    expect(keyPrefix({ R2_KEY_PREFIX: "a/b_c/" })).toBe("a/b_c/");
    expect(keyPrefix({ R2_KEY_PREFIX: "dev" })).toBeNull();
    expect(keyPrefix({ R2_KEY_PREFIX: "/dev/" })).toBeNull();
    expect(keyPrefix({ R2_KEY_PREFIX: "Dev/" })).toBeNull();
  });
});
