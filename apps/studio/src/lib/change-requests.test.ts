import { describe, expect, it } from "vitest";
import {
  MAX_REQUEST_LENGTH,
  changeRule,
  jobRequestLabel,
  normalizeRequest,
  versionOrigin,
} from "./change-requests";
import { JOB_KINDS, type JobStatus } from "./jobs";

describe("normalizeRequest", () => {
  it("trims the owner's words", () => {
    expect(normalizeRequest("  move the title lower \n")).toEqual({
      ok: true,
      request: "move the title lower",
    });
  });

  it("refuses an empty or whitespace-only request and a non-string", () => {
    for (const text of ["", "   ", "\n\t", undefined, 3]) {
      expect(normalizeRequest(text).ok).toBe(false);
    }
  });

  it("accepts exactly 1000 characters and refuses 1001", () => {
    expect(MAX_REQUEST_LENGTH).toBe(1000);
    expect(normalizeRequest("a".repeat(1000))).toEqual({ ok: true, request: "a".repeat(1000) });
    expect(normalizeRequest("a".repeat(1001))).toEqual({
      ok: false,
      reason: "Keep it to 1000 characters.",
    });
    // Counted after trimming.
    expect(normalizeRequest(` ${"a".repeat(1000)} `).ok).toBe(true);
  });
});

describe("changeRule", () => {
  const job = (kind: string, status: JobStatus) => ({ kind, status });
  const processed = { status: "processed" as const, current_version_id: "v1" };

  it("is open with no notice on a processed reel with every job ended", () => {
    expect(changeRule(processed, [])).toEqual({ blocked: null, notice: null });
    expect(changeRule(processed, [job("process", "done"), job("change", "failed")])).toEqual({
      blocked: null,
      notice: null,
    });
  });

  it("is open during processing, saying the change runs after it", () => {
    for (const status of ["queued", "running", "waiting_ai"] as const) {
      expect(
        changeRule({ status: "converting", current_version_id: null }, [job("process", status)]),
      ).toEqual({ blocked: null, notice: "Your change will run after processing finishes." });
    }
  });

  it("is open behind another unfinished job, saying it runs after it", () => {
    for (const status of ["queued", "running", "waiting_ai"] as const) {
      expect(changeRule(processed, [job("process", "done"), job("change", status)])).toEqual({
        blocked: null,
        notice: "Your change will run after the current job finishes.",
      });
    }
  });

  it("blocks a refused reel", () => {
    expect(
      changeRule({ status: "refused", current_version_id: null }, [job("process", "failed")]),
    ).toEqual({ blocked: "This clip was refused; upload another.", notice: null });
  });

  it("blocks until the reel can have a version", () => {
    const noVersion = "Changes open once the reel has a version.";
    expect(changeRule({ status: "uploading", current_version_id: null }, []).blocked).toBe(
      noVersion,
    );
    expect(
      changeRule({ status: "failed", current_version_id: null }, [job("process", "failed")])
        .blocked,
    ).toBe(noVersion);
    expect(changeRule({ status: "uploaded", current_version_id: null }, []).blocked).toBe(
      noVersion,
    );
  });

  it("stays open on a reel with a version whose later process job failed", () => {
    expect(
      changeRule({ status: "failed", current_version_id: "v1" }, [job("process", "failed")]),
    ).toEqual({ blocked: null, notice: null });
  });
});

describe("labels", () => {
  const byId = new Map([
    ["v1", { number: 1 }],
    ["v3", { number: 3 }],
  ]);

  it("names a version's origin", () => {
    expect(versionOrigin({ restored_from_id: "v3", request: null }, byId)).toBe("restored from v3");
    expect(versionOrigin({ restored_from_id: null, request: "no accent on 'work'" }, byId)).toBe(
      "\"no accent on 'work'\"",
    );
    expect(versionOrigin({ restored_from_id: null, request: null }, byId)).toBe("automatic");
  });

  it("names what each job kind was asked to do", () => {
    expect(JOB_KINDS).toEqual(["process", "change", "restore", "render"]);
    const none = { request: null, restore_version_id: null, version_id: null };
    expect(jobRequestLabel({ kind: "process", ...none }, byId)).toBeNull();
    expect(jobRequestLabel({ kind: "change", ...none, request: "lower" }, byId)).toBe('"lower"');
    expect(jobRequestLabel({ kind: "restore", ...none, restore_version_id: "v1" }, byId)).toBe(
      "go back to v1",
    );
    expect(jobRequestLabel({ kind: "render", ...none, version_id: "v3" }, byId)).toBe(
      "export of v3",
    );
    expect(jobRequestLabel({ kind: "render", ...none, version_id: "v9" }, byId)).toBe("export");
  });
});
