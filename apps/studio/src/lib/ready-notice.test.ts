import { describe, expect, it } from "vitest";
import { readyBody, readyEvent, readyTitle } from "./ready-notice";

describe("readyEvent", () => {
  it("is null on the first render", () => {
    expect(readyEvent(null, { status: "processed", latestExportId: "e1" })).toBeNull();
  });

  it("is processed when the status moves into processed", () => {
    expect(
      readyEvent(
        { status: "making_previews", latestExportId: null },
        { status: "processed", latestExportId: null },
      ),
    ).toBe("processed");
  });

  it("is null from processed to processed", () => {
    expect(
      readyEvent(
        { status: "processed", latestExportId: null },
        { status: "processed", latestExportId: null },
      ),
    ).toBeNull();
  });

  it("is export when the newest export id changes to a new one", () => {
    expect(
      readyEvent(
        { status: "processed", latestExportId: "e1" },
        { status: "processed", latestExportId: "e2" },
      ),
    ).toBe("export");
    expect(
      readyEvent(
        { status: "processed", latestExportId: null },
        { status: "processed", latestExportId: "e1" },
      ),
    ).toBe("export");
    expect(
      readyEvent(
        { status: "processed", latestExportId: "e1" },
        { status: "processed", latestExportId: null },
      ),
    ).toBeNull();
  });
});

describe("readyTitle", () => {
  it("names the reel", () => {
    expect(readyTitle("short-speech.mp4")).toBe("Ready: short-speech.mp4");
  });
});

describe("readyBody", () => {
  it("says what is ready", () => {
    expect(readyBody("processed")).toMatch(/processed/);
    expect(readyBody("export")).toMatch(/export/);
  });
});
