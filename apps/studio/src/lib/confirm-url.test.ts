import { describe, expect, it } from "vitest";
import { confirmUrl } from "./confirm-url";

describe("confirmUrl", () => {
  it("uses NEXT_PUBLIC_SITE_URL without its trailing slash", () => {
    expect(
      confirmUrl({ siteUrl: "https://edit.issebya.com/", forwardedHost: "x", host: "y" }),
    ).toBe("https://edit.issebya.com/studio/auth/confirm");
  });

  it("falls back to the forwarded proto and host", () => {
    expect(
      confirmUrl({
        siteUrl: "",
        forwardedProto: "https",
        forwardedHost: "localhost:9100",
        host: "localhost:9101",
      }),
    ).toBe("https://localhost:9100/studio/auth/confirm");
  });

  it("takes the first entry of a forwarded chain", () => {
    expect(confirmUrl({ forwardedHost: "localhost:9100, proxy:1", host: "h" })).toBe(
      "http://localhost:9100/studio/auth/confirm",
    );
  });

  it("falls back to the host header over plain http", () => {
    expect(confirmUrl({ host: "localhost:3001" })).toBe(
      "http://localhost:3001/studio/auth/confirm",
    );
  });
});
