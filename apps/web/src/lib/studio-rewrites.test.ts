import { describe, expect, it } from "vitest";
import { STUDIO_ASSET_PREFIX, studioOrigin, studioRewrites } from "./studio-rewrites";

describe("studioOrigin", () => {
  it("defaults to the local studio on 3001", () => {
    expect(studioOrigin({})).toBe("http://localhost:3001");
    expect(studioOrigin({ STUDIO_URL: "", STUDIO_PORT: "" })).toBe("http://localhost:3001");
  });

  it("follows STUDIO_PORT", () => {
    expect(studioOrigin({ STUDIO_PORT: "9106" })).toBe("http://localhost:9106");
  });

  it("prefers STUDIO_URL and drops its trailing slash", () => {
    expect(
      studioOrigin({ STUDIO_URL: "https://studio.example.vercel.app/", STUDIO_PORT: "9106" }),
    ).toBe("https://studio.example.vercel.app");
  });
});

describe("studioRewrites", () => {
  it("forwards the zone and its static files", () => {
    expect(studioRewrites("http://localhost:3001")).toEqual([
      { source: "/studio", destination: "http://localhost:3001/studio" },
      { source: "/studio/:path+", destination: "http://localhost:3001/studio/:path+" },
      {
        source: "/studio-static/:path+",
        destination: "http://localhost:3001/studio-static/:path+",
      },
    ]);
  });

  it("uses the studio's asset prefix", () => {
    expect(STUDIO_ASSET_PREFIX).toBe("/studio-static");
  });
});
