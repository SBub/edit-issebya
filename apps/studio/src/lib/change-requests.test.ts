import { describe, expect, it } from "vitest";
import {
  changeBlockedReason,
  jobRequestLabel,
  versionOrigin,
  versionTitle,
} from "./change-requests";
import { JOB_KINDS } from "./jobs";

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
      "This clip was refused; upload another clip",
    );
  });

  it("blocks while uploading", () => {
    expect(changeBlockedReason({ status: "uploading", current_version_id: null })).toBe(
      "Changes open once the upload finishes",
    );
  });

  it("blocks a failed reel without a version", () => {
    expect(changeBlockedReason({ status: "failed", current_version_id: null })).toBe(
      "Processing failed; press Try again on the preview first",
    );
  });
});

describe("labels", () => {
  const byId = new Map([
    ["v1", { number: 1 }],
    ["v3", { number: 3 }],
  ]);

  it("names a version's origin", () => {
    const base = { restored_from_id: null, request: null, parent_id: "v1" };
    expect(versionOrigin({ ...base, restored_from_id: "v3" }, byId)).toBe("Back to v3");
    expect(versionOrigin({ ...base, restored_from_id: "gone" }, byId)).toBe(
      "Back to an earlier version",
    );
    expect(versionOrigin({ ...base, request: "no accent on 'work'" }, byId)).toBe(
      "no accent on 'work'",
    );
    expect(versionOrigin({ ...base, parent_id: null }, byId)).toBe("First version");
    expect(versionOrigin(base, byId)).toBe("Styled automatically");
  });

  describe("versionTitle", () => {
    const base = { restored_from_id: null, request: null, parent_id: "v1", change_title: null };

    it("calls the first version First version", () => {
      expect(versionTitle({ ...base, parent_id: null }, byId)).toBe("First version");
    });

    it("calls a going back Back to vN, whatever its title", () => {
      expect(versionTitle({ ...base, restored_from_id: "v3", change_title: "x" }, byId)).toBe(
        "Back to v3",
      );
    });

    it("uses Claude's title for a change", () => {
      const change = { ...base, request: "make the transitions slower" };
      expect(versionTitle({ ...change, change_title: "Transitions made longer" }, byId)).toBe(
        "Transitions made longer",
      );
    });

    it("falls back to the owner's request for a change saved before titles", () => {
      const long = "make the transitions slower and add a photo of the kitchen behind me";
      expect(versionTitle({ ...base, request: long }, byId)).toBe(long);
      expect(versionTitle({ ...base, request: long, change_title: "  " }, byId)).toBe(long);
    });

    it("titles an automatic styling by Claude's title, or says it was automatic", () => {
      expect(versionTitle({ ...base, change_title: "Captions styled" }, byId)).toBe(
        "Captions styled",
      );
      expect(versionTitle(base, byId)).toBe("Styled automatically");
    });

    it("shows the origin label for a version saved with no title, a start-over included", () => {
      // The decide step saves no title now: a start over (no request, a parent)
      // and an automatic styling both show their origin label.
      const startOver = { ...base, change_title: null };
      expect(versionTitle(startOver, byId)).toBe("Styled automatically");
      expect(versionTitle({ ...startOver, parent_id: null }, byId)).toBe("First version");
    });
  });

  it("names what each job kind was asked to do", () => {
    expect(JOB_KINDS).toEqual(["process", "change", "restore", "render", "start_over"]);
    const none = { request: null, restore_version_id: null, version_id: null };
    expect(jobRequestLabel({ kind: "process", ...none }, byId)).toBeNull();
    expect(jobRequestLabel({ kind: "restore", ...none, restore_version_id: "v1" }, byId)).toBe(
      "go back to v1",
    );
    expect(jobRequestLabel({ kind: "render", ...none, version_id: "v3" }, byId)).toBe(
      "export of v3",
    );
    expect(jobRequestLabel({ kind: "render", ...none, version_id: "v9" }, byId)).toBe("export");
    expect(jobRequestLabel({ kind: "start_over", ...none }, byId)).toBe("start over from v1");
  });
});
