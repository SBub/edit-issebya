import { describe, expect, it } from "vitest";
import {
  currentVersionExport,
  EDITING_OFF_WHILE_EXPORTING,
  EXPORTING_LEAD,
  type ExportRef,
  exportBlockedReason,
  exportFileName,
  exportLinkSeconds,
  exportProgress,
  exportProgressDetail,
  exportRunning,
  exportingReason,
  followsCurrentVersion,
  isExportKey,
  liveRenderJobId,
} from "./exports";

const REEL = "5f1c9e2a-0d3b-4a7e-8c6f-2b9d4e1a7c30";
const OTHER = "0b6f2a52-7d0e-4c55-9d4a-3c1f0e8a1b01";
const EXPORT = "3e0c7b1a-5d2f-4a6e-9b8c-1f2e3d4c5b6a";

type Status = "queued" | "running" | "waiting_ai" | "done" | "failed" | "cancelled";
const render = (id: string, status: Status) => ({ id, kind: "render", status });

describe("exportBlockedReason", () => {
  const reel = { status: "processed" as const, current_version_id: "v2" };

  it("is open on a processed reel with a version and no export running", () => {
    expect(exportBlockedReason(reel, [])).toBeNull();
    expect(
      exportBlockedReason(reel, [
        render("a", "done"),
        render("b", "failed"),
        render("c", "cancelled"),
      ]),
    ).toBeNull();
  });

  it("needs a version and a processed reel", () => {
    expect(exportBlockedReason({ ...reel, current_version_id: null }, [])).toBe(
      "No version to export yet",
    );
    expect(exportBlockedReason({ ...reel, status: "retiming" }, [])).toBe(
      "Export opens once the reel is processed",
    );
  });

  it("holds while an export of the reel is queued, running or waiting", () => {
    for (const status of ["queued", "running", "waiting_ai"] as const) {
      expect(exportBlockedReason(reel, [render("a", status)])).toBe(
        "This reel is already exporting",
      );
    }
  });

  it("is not held by another kind of job", () => {
    expect(
      exportBlockedReason(reel, [{ id: "c", kind: "owner_edit", status: "running" }]),
    ).toBeNull();
  });
});

describe("liveRenderJobId and exportingReason", () => {
  it("is the newest live render of the reel, whatever version it exports", () => {
    expect(liveRenderJobId([render("a", "done"), render("b", "running")])).toBe("b");
    expect(liveRenderJobId([render("a", "queued")])).toBe("a");
    expect(liveRenderJobId([render("a", "waiting_ai")])).toBe("a");
  });

  it("is null without one", () => {
    expect(liveRenderJobId([])).toBeNull();
    expect(liveRenderJobId([render("a", "cancelled"), render("b", "done")])).toBeNull();
    expect(liveRenderJobId([{ id: "p", kind: "process", status: "running" }])).toBeNull();
  });

  it("turns editing off exactly while an export is live, with the reason shown", () => {
    expect(exportingReason([render("a", "running")])).toBe(EDITING_OFF_WHILE_EXPORTING);
    expect(exportingReason([render("a", "queued")])).toBe(EDITING_OFF_WHILE_EXPORTING);
    expect(exportingReason([render("a", "done")])).toBeNull();
    expect(exportingReason([render("a", "cancelled")])).toBeNull();
    expect(exportingReason([])).toBeNull();
    expect(EDITING_OFF_WHILE_EXPORTING).toMatch(/Cancel the export/);
  });
});

describe("exportLinkSeconds", () => {
  const now = Date.parse("2026-11-01T12:00:00.000Z");

  it("gives the whole seconds left, never past the expiry, an hour at most", () => {
    expect(exportLinkSeconds("2026-11-01T13:00:00.000Z", now)).toBe(3600);
    expect(exportLinkSeconds("2026-11-01T12:30:00.000Z", now)).toBe(1800);
    // A fresh export has 48 hours left; a link still lives one hour.
    expect(exportLinkSeconds("2026-11-03T12:00:00.000Z", now)).toBe(3600);
    expect(exportLinkSeconds("2026-11-01T12:00:01.999Z", now)).toBe(1);
    expect(exportLinkSeconds("2026-11-01T12:00:00.999Z", now)).toBeNull();
    expect(exportLinkSeconds("2026-11-01T12:00:00.000Z", now)).toBeNull();
    expect(exportLinkSeconds("2026-11-01T11:00:00.000Z", now)).toBeNull();
    expect(exportLinkSeconds("not a date", now)).toBeNull();
  });
});

describe("currentVersionExport", () => {
  const row = (version_id: string): ExportRef => ({
    id: "e1",
    reel_id: "r1",
    job_id: "j1",
    version_id,
    created_at: "2026-11-09T10:00:00.000Z",
    expires_at: "2026-11-11T10:00:00.000Z",
  });

  it("offers the export of the reel's current version", () => {
    const held = row("v2");
    expect(currentVersionExport(held, "v2")).toBe(held);
  });

  it("offers nothing once another version is current, whatever made it", () => {
    // An edit, a font change, Start over and going back all save a new
    // version with a new id: the export of v2 is of no version that is current.
    expect(currentVersionExport(row("v2"), "v3")).toBeNull();
    expect(currentVersionExport(row("v2"), null)).toBeNull();
    expect(currentVersionExport(null, "v2")).toBeNull();
  });
});

describe("followsCurrentVersion", () => {
  const job = (status: Status, version_id: string | null) => ({ status, version_id });

  it("follows an export of the current version to its end", () => {
    for (const status of ["queued", "running", "waiting_ai", "done", "failed"] as const) {
      expect(followsCurrentVersion(job(status, "v2"), "v2"), status).toBe(true);
    }
  });

  it("follows a job whose row has not arrived yet, and any live one", () => {
    expect(followsCurrentVersion(undefined, "v2")).toBe(true);
    for (const status of ["queued", "running", "waiting_ai"] as const) {
      expect(followsCurrentVersion(job(status, "v2"), "v3"), status).toBe(true);
    }
  });

  it("stops following an ended export once a newer version is current", () => {
    for (const status of ["done", "failed", "cancelled"] as const) {
      expect(followsCurrentVersion(job(status, "v2"), "v3"), status).toBe(false);
    }
  });
});

describe("isExportKey", () => {
  it("accepts the worker's key for this reel, with or without a prefix", () => {
    expect(isExportKey(`dev/exports/${REEL}/${EXPORT}.mp4`, REEL)).toBe(true);
    expect(isExportKey(`exports/${REEL}/${EXPORT}.mp4`, REEL)).toBe(true);
    expect(isExportKey(`e2e/run-1/exports/${REEL}/${EXPORT}.mp4`, REEL)).toBe(true);
  });

  it("refuses another reel's key and any other shape", () => {
    expect(isExportKey(`dev/exports/${OTHER}/${EXPORT}.mp4`, REEL)).toBe(false);
    expect(isExportKey(`dev/reels/${REEL}/source/original.mp4`, REEL)).toBe(false);
    expect(isExportKey(`dev/exports/${REEL}/${EXPORT}.webm`, REEL)).toBe(false);
    expect(isExportKey(`dev/exports/${REEL}/../${EXPORT}.mp4`, REEL)).toBe(false);
  });
});

describe("exportFileName", () => {
  it("names the version and the UTC minute it was made", () => {
    expect(exportFileName(3, "2026-11-01T09:05:59.000Z")).toBe("reel-v3-20261101-0905.mp4");
    expect(exportFileName(12, "2026-01-31T23:59:00+02:00")).toBe("reel-v12-20260131-2159.mp4");
  });
});

describe("exportProgress", () => {
  const JOB = "j1";
  const job = (status: Status) => [{ id: JOB, status }];
  const step = (
    name: string,
    status: "running" | "done" | "skipped",
    progress_percent: number | null = null,
    job_id = JOB,
  ) => ({ job_id, name, status, progress_percent });

  it("waits with a plain label before the render step runs", () => {
    expect(exportProgress(JOB, [], [], null)).toEqual({
      kind: "waiting",
      label: "waiting to start",
    });
    expect(exportProgress(JOB, job("queued"), [], null)).toEqual({
      kind: "waiting",
      label: "waiting to start",
    });
    expect(
      exportProgress(
        JOB,
        job("running"),
        [step("convert", "skipped"), step("cutout", "running")],
        null,
      ),
    ).toEqual({ kind: "waiting", label: "getting ready" });
  });

  it("follows the running render step's percent, 0 before its first write", () => {
    expect(exportProgress(JOB, job("running"), [step("render", "running")], null)).toEqual({
      kind: "rendering",
      percent: 0,
    });
    expect(exportProgress(JOB, job("running"), [step("render", "running", 42.6)], null)).toEqual({
      kind: "rendering",
      percent: 43,
    });
    // Another job's render step is not this one's.
    expect(
      exportProgress(JOB, job("running"), [step("render", "running", 80, "j2")], null),
    ).toEqual({ kind: "waiting", label: "getting ready" });
  });

  it("finishes after the render step until the export row arrives", () => {
    expect(exportProgress(JOB, job("running"), [step("render", "done", 100)], null)).toEqual({
      kind: "waiting",
      label: "finishing",
    });
    expect(exportProgress(JOB, job("done"), [], null)).toEqual({
      kind: "waiting",
      label: "finishing",
    });
  });

  it("is ready once this job's export arrives, never for another job's", () => {
    expect(exportProgress(JOB, job("running"), [], { id: "e1", job_id: JOB })).toEqual({
      kind: "ready",
      exportId: "e1",
    });
    // An older kept export of the reel is not this job's.
    expect(exportProgress(JOB, job("done"), [], { id: "e0", job_id: "older" })).toEqual({
      kind: "waiting",
      label: "finishing",
    });
  });

  it("ends failed or cancelled", () => {
    expect(exportProgress(JOB, job("failed"), [], null)).toEqual({ kind: "failed" });
    expect(exportProgress(JOB, job("cancelled"), [], null)).toEqual({ kind: "cancelled" });
  });

  it("runs (progress and Cancel shown) only while waiting or rendering", () => {
    expect(exportRunning({ kind: "waiting", label: "waiting to start" })).toBe(true);
    expect(exportRunning({ kind: "rendering", percent: 10 })).toBe(true);
    expect(exportRunning({ kind: "ready", exportId: "e1" })).toBe(false);
    expect(exportRunning({ kind: "failed" })).toBe(false);
    expect(exportRunning({ kind: "cancelled" })).toBe(false);
    expect(exportRunning(null)).toBe(false);
  });

  it("words a running export in one short line after its lead", () => {
    expect(EXPORTING_LEAD).toBe("Exporting…");
    expect(exportProgressDetail({ kind: "rendering", percent: 40 })).toBe("40%");
    expect(exportProgressDetail({ kind: "waiting", label: "waiting to start" })).toBe(
      "waiting to start",
    );
    expect(exportProgressDetail({ kind: "ready", exportId: "e1" })).toBe("");
  });
});
