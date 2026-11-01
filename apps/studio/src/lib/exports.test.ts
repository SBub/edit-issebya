import { describe, expect, it, vi } from "vitest";
import {
  DOWNLOAD_URL_MAX_SECONDS,
  downloadSeconds,
  exportBlockedReason,
  exportFileName,
  exportView,
  latestExport,
  signExportDownload,
} from "./exports";
import { REEL_STATUSES } from "./reels";

const CREATED = "2026-11-01T09:30:00.000Z";
const EXPIRES = "2026-11-02T09:30:00.000Z";
const at = (iso: string, ms = 0) => new Date(Date.parse(iso) + ms);

describe("latestExport", () => {
  it("is null without exports", () => {
    expect(latestExport([])).toBeNull();
  });

  it("picks the newest by created_at, id breaking ties", () => {
    const rows = [
      { id: "b", created_at: "2026-11-01T09:00:00Z" },
      { id: "a", created_at: "2026-11-01T10:00:00Z" },
      { id: "c", created_at: "2026-11-01T10:00:00Z" },
      { id: "d", created_at: "2026-11-01T08:00:00Z" },
    ];
    expect(latestExport(rows)?.id).toBe("c");
  });
});

describe("exportView", () => {
  it("is none without an export", () => {
    expect(exportView(null, at(CREATED))).toEqual({ state: "none" });
  });

  it("is ready 1 ms before expires_at and expired at and after it", () => {
    expect(exportView({ expires_at: EXPIRES }, at(EXPIRES, -1))).toEqual({
      state: "ready",
      msLeft: 1,
    });
    expect(exportView({ expires_at: EXPIRES }, at(EXPIRES))).toEqual({ state: "expired" });
    expect(exportView({ expires_at: EXPIRES }, at(EXPIRES, 1))).toEqual({ state: "expired" });
  });
});

describe("exportBlockedReason", () => {
  it("blocks every reel status but processed", () => {
    for (const status of REEL_STATUSES.filter((s) => s !== "processed")) {
      expect(exportBlockedReason(status, [], "v1")).toBe(
        "Export opens once processing has finished.",
      );
    }
  });

  it("blocks without a current version", () => {
    expect(exportBlockedReason("processed", [], null)).toBe("No version to export yet.");
  });

  it("blocks while a render of this version is queued or running", () => {
    for (const status of ["queued", "running"] as const) {
      expect(
        exportBlockedReason("processed", [{ kind: "render", status, version_id: "v1" }], "v1"),
      ).toBe("Exporting this version.");
    }
  });

  it("is not blocked by a render of another version, a finished render or another kind", () => {
    expect(
      exportBlockedReason(
        "processed",
        [
          { kind: "render", status: "running", version_id: "v0" },
          { kind: "render", status: "done", version_id: "v1" },
          { kind: "render", status: "failed", version_id: "v1" },
          { kind: "change", status: "running", version_id: null },
        ],
        "v1",
      ),
    ).toBeNull();
  });
});

describe("downloadSeconds", () => {
  it("caps the link at the maximum", () => {
    expect(downloadSeconds(EXPIRES, at(CREATED))).toBe(DOWNLOAD_URL_MAX_SECONDS);
    expect(DOWNLOAD_URL_MAX_SECONDS).toBe(3600);
  });

  it("floors partial seconds", () => {
    expect(downloadSeconds(EXPIRES, at(EXPIRES, -90_999))).toBe(90);
    expect(downloadSeconds(EXPIRES, at(EXPIRES, -1_000))).toBe(1);
  });

  it("is null with less than a second left, at and past expires_at", () => {
    expect(downloadSeconds(EXPIRES, at(EXPIRES, -999))).toBeNull();
    expect(downloadSeconds(EXPIRES, at(EXPIRES))).toBeNull();
    expect(downloadSeconds(EXPIRES, at(EXPIRES, 60_000))).toBeNull();
  });
});

describe("exportFileName", () => {
  it("names the file after the reel and the export's UTC time", () => {
    expect(exportFileName("ABCDEF12-0000-4000-8000-000000000000", CREATED)).toBe(
      "reel-abcdef12-20261101-0930.mp4",
    );
  });
});

describe("signExportDownload", () => {
  const row = {
    r2_key: "dev/exports/r1/e1.mp4",
    reel_id: "abcdef12-0000-4000-8000-000000000000",
    created_at: CREATED,
    expires_at: EXPIRES,
  };
  const spyStorage = () => ({ signDownload: vi.fn(async () => "https://signed") });

  it("never signs at or past expires_at", async () => {
    for (const now of [at(EXPIRES), at(EXPIRES, 1), at(EXPIRES, -500)]) {
      const storage = spyStorage();
      expect(await signExportDownload(storage, row, now)).toBeNull();
      expect(storage.signDownload).not.toHaveBeenCalled();
    }
  });

  it("never signs for longer than the time left", async () => {
    const storage = spyStorage();
    expect(await signExportDownload(storage, row, at(EXPIRES, -120_500))).toBe("https://signed");
    expect(storage.signDownload).toHaveBeenCalledWith(row.r2_key, {
      expiresInSeconds: 120,
      fileName: "reel-abcdef12-20261101-0930.mp4",
    });
  });

  it("signs for at most an hour", async () => {
    const storage = spyStorage();
    await signExportDownload(storage, row, at(CREATED));
    expect(storage.signDownload).toHaveBeenCalledWith(row.r2_key, {
      expiresInSeconds: DOWNLOAD_URL_MAX_SECONDS,
      fileName: "reel-abcdef12-20261101-0930.mp4",
    });
  });
});
