import { describe, expect, it } from "vitest";
import {
  MAX_REQUEST_LENGTH,
  changeBlockedReason,
  jobRequestLabel,
  normalizeRequest,
  versionOrigin,
} from "./change-requests";
import { JOB_KINDS } from "./jobs";

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
  it("is open on a processed reel and while the reel is processing", () => {
    for (const status of [
      "processed",
      "uploaded",
      "checking_footage",
      "converting",
      "making_previews",
    ] as const) {
      expect(changeBlockedReason({ status, current_version_id: null })).toBeNull();
    }
    // A failed reel with a version keeps its version usable.
    expect(changeBlockedReason({ status: "failed", current_version_id: "v1" })).toBeNull();
  });

  it("blocks a refused reel", () => {
    expect(changeBlockedReason({ status: "refused", current_version_id: null })).toBe(
      "This clip was refused; upload another clip.",
    );
  });

  it("blocks while uploading", () => {
    expect(changeBlockedReason({ status: "uploading", current_version_id: null })).toBe(
      "Changes open once the upload finishes.",
    );
  });

  it("blocks a failed reel without a version", () => {
    expect(changeBlockedReason({ status: "failed", current_version_id: null })).toBe(
      "Processing failed; press Retry on the failed job first.",
    );
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
