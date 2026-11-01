import { describe, expect, it } from "vitest";
import {
  MAX_REQUEST_LENGTH,
  changeBlockedReason,
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

describe("changeBlockedReason", () => {
  const job = (status: JobStatus) => ({ status });

  it("is open on a processed reel with no queued or running job", () => {
    expect(changeBlockedReason({ status: "processed" }, [])).toBeNull();
    expect(changeBlockedReason({ status: "processed" }, [job("done"), job("failed")])).toBeNull();
  });

  it("blocks while a job is queued or running", () => {
    for (const status of ["queued", "running"] as const) {
      expect(changeBlockedReason({ status: "processed" }, [job("done"), job(status)])).toBe(
        "A job is running on this reel; wait for it to finish.",
      );
    }
  });

  it("blocks until the reel is processed", () => {
    for (const status of ["uploaded", "converting", "failed"] as const) {
      expect(changeBlockedReason({ status }, [])).toBe("Changes open once the reel is processed.");
    }
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
