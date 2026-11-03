import { describe, expect, it } from "vitest";
import {
  exportBlockedReason,
  exportFileName,
  exportCancellable,
  exportLinkSeconds,
  exportModalState,
  isExportKey,
  liveRenderJobId,
} from "./exports";

const REEL = "5f1c9e2a-0d3b-4a7e-8c6f-2b9d4e1a7c30";
const OTHER = "0b6f2a52-7d0e-4c55-9d4a-3c1f0e8a1b01";
const EXPORT = "3e0c7b1a-5d2f-4a6e-9b8c-1f2e3d4c5b6a";

describe("exportBlockedReason", () => {
  const reel = { status: "processed" as const, current_version_id: "v2" };
  const render = (status: "queued" | "running" | "done" | "failed", version_id = "v2") => ({
    kind: "render",
    status,
    version_id,
  });

  it("is open on a processed reel with a version and no render of it running", () => {
    expect(exportBlockedReason(reel, [])).toBeNull();
    expect(exportBlockedReason(reel, [render("done"), render("failed")])).toBeNull();
  });

  it("needs a version and a processed reel", () => {
    expect(exportBlockedReason({ ...reel, current_version_id: null }, [])).toBe(
      "No version to export yet",
    );
    expect(exportBlockedReason({ ...reel, status: "retiming" }, [])).toBe(
      "Export opens once the reel is processed",
    );
  });

  it("holds while a render of the current version is queued or running", () => {
    expect(exportBlockedReason(reel, [render("queued")])).toBe("Exporting this version...");
    expect(exportBlockedReason(reel, [render("running")])).toBe("Exporting this version...");
  });

  it("is not held by a render of an older version or another kind of job", () => {
    expect(exportBlockedReason(reel, [render("running", "v1")])).toBeNull();
    expect(
      exportBlockedReason(reel, [{ kind: "change", status: "running", version_id: null }]),
    ).toBeNull();
  });
});

describe("exportLinkSeconds", () => {
  const now = Date.parse("2026-11-01T12:00:00.000Z");

  it("gives the whole seconds left, never past the expiry", () => {
    expect(exportLinkSeconds("2026-11-01T13:00:00.000Z", now)).toBe(3600);
    expect(exportLinkSeconds("2026-11-01T12:00:01.999Z", now)).toBe(1);
    expect(exportLinkSeconds("2026-11-01T12:00:00.999Z", now)).toBeNull();
    expect(exportLinkSeconds("2026-11-01T12:00:00.000Z", now)).toBeNull();
    expect(exportLinkSeconds("2026-11-01T11:00:00.000Z", now)).toBeNull();
    expect(exportLinkSeconds("not a date", now)).toBeNull();
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

describe("exportModalState", () => {
  const JOB = "j1";
  const job = (status: "queued" | "running" | "waiting_ai" | "done" | "failed" | "cancelled") => [
    { id: JOB, status },
  ];
  const step = (
    name: string,
    status: "running" | "done" | "skipped",
    progress_percent: number | null = null,
    job_id = JOB,
  ) => ({ job_id, name, status, progress_percent });

  it("waits with a plain label before the render step runs", () => {
    expect(exportModalState(JOB, [], [], null)).toEqual({
      kind: "waiting",
      label: "Waiting to start",
    });
    expect(exportModalState(JOB, job("queued"), [], null)).toEqual({
      kind: "waiting",
      label: "Waiting to start",
    });
    expect(
      exportModalState(
        JOB,
        job("running"),
        [step("convert", "skipped"), step("cutout", "running")],
        null,
      ),
    ).toEqual({ kind: "waiting", label: "Getting ready" });
  });

  it("follows the running render step's percent, 0 before its first write", () => {
    expect(exportModalState(JOB, job("running"), [step("render", "running")], null)).toEqual({
      kind: "rendering",
      percent: 0,
    });
    expect(exportModalState(JOB, job("running"), [step("render", "running", 42.6)], null)).toEqual({
      kind: "rendering",
      percent: 43,
    });
    // Another job's render step is not this one's.
    expect(
      exportModalState(JOB, job("running"), [step("render", "running", 80, "j2")], null),
    ).toEqual({ kind: "waiting", label: "Getting ready" });
  });

  it("finishes after the render step until the export row arrives", () => {
    expect(exportModalState(JOB, job("running"), [step("render", "done", 100)], null)).toEqual({
      kind: "waiting",
      label: "Finishing",
    });
    expect(exportModalState(JOB, job("done"), [], null)).toEqual({
      kind: "waiting",
      label: "Finishing",
    });
  });

  it("is ready once this job's export arrives, never for another job's", () => {
    expect(exportModalState(JOB, job("running"), [], { id: "e1", job_id: JOB })).toEqual({
      kind: "ready",
      exportId: "e1",
    });
    expect(exportModalState(JOB, job("done"), [], { id: "e0", job_id: "older" })).toEqual({
      kind: "waiting",
      label: "Finishing",
    });
  });

  it("ends failed or cancelled", () => {
    expect(exportModalState(JOB, job("failed"), [], null)).toEqual({ kind: "failed" });
    expect(exportModalState(JOB, job("cancelled"), [], null)).toEqual({ kind: "cancelled" });
  });

  it("can be cancelled only while waiting or rendering", () => {
    expect(exportCancellable({ kind: "waiting", label: "Waiting to start" })).toBe(true);
    expect(exportCancellable({ kind: "rendering", percent: 10 })).toBe(true);
    expect(exportCancellable({ kind: "ready", exportId: "e1" })).toBe(false);
    expect(exportCancellable({ kind: "failed" })).toBe(false);
    expect(exportCancellable({ kind: "cancelled" })).toBe(false);
  });
});

describe("liveRenderJobId", () => {
  const reel = { current_version_id: "v2" };
  const render = (
    id: string,
    status: "queued" | "running" | "done" | "cancelled",
    version_id = "v2",
  ) => ({
    id,
    kind: "render",
    status,
    version_id,
  });

  it("is the newest live render of the current version", () => {
    expect(liveRenderJobId(reel, [render("a", "done"), render("b", "running")])).toBe("b");
    expect(liveRenderJobId(reel, [render("a", "queued")])).toBe("a");
  });

  it("is null without one", () => {
    expect(liveRenderJobId(reel, [])).toBeNull();
    expect(liveRenderJobId(reel, [render("a", "cancelled"), render("b", "done")])).toBeNull();
    expect(liveRenderJobId(reel, [render("a", "running", "v1")])).toBeNull();
  });
});
