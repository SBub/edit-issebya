import { describe, expect, it } from "vitest";
import { MAX_REQUEST_CHARS, changeBlockedReason, parseChangeRequest } from "./change-request";
import { REEL_STATUSES } from "./reels";

describe("parseChangeRequest", () => {
  it("trims the words", () => {
    expect(parseChangeRequest("  move the title lower \n")).toEqual({
      ok: true,
      value: "move the title lower",
    });
  });

  it("keeps quotes and line breaks inside", () => {
    expect(parseChangeRequest(`no accent on 'work'\nand "lock-in" bigger`)).toEqual({
      ok: true,
      value: `no accent on 'work'\nand "lock-in" bigger`,
    });
  });

  it("refuses an empty, whitespace-only or missing request", () => {
    for (const raw of ["", "   \n\t", undefined, null, 42]) {
      expect(parseChangeRequest(raw).ok).toBe(false);
    }
  });

  it("accepts exactly 1000 characters and refuses 1001", () => {
    expect(parseChangeRequest("a".repeat(MAX_REQUEST_CHARS)).ok).toBe(true);
    expect(parseChangeRequest(` ${"a".repeat(MAX_REQUEST_CHARS)} `).ok).toBe(true);
    expect(parseChangeRequest("a".repeat(MAX_REQUEST_CHARS + 1)).ok).toBe(false);
  });
});

describe("changeBlockedReason", () => {
  it("blocks every reel status but processed", () => {
    for (const status of REEL_STATUSES.filter((s) => s !== "processed")) {
      expect(changeBlockedReason(status, [])).toBe("Changes open once processing has finished.");
    }
  });

  it("blocks while a job is queued or running", () => {
    for (const status of ["queued", "running"] as const) {
      expect(changeBlockedReason("processed", [{ status: "done" }, { status }])).toBe(
        "Wait for the running job to finish.",
      );
    }
  });

  it("allows a processed reel whose jobs are done or failed", () => {
    expect(changeBlockedReason("processed", [{ status: "done" }, { status: "failed" }])).toBeNull();
    expect(changeBlockedReason("processed", [])).toBeNull();
  });
});
