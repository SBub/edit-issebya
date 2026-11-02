import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { previewCopiesRefs, recordPreviewCopies } from "./preview-copies-record.ts";

const FP = "663cba62bed2a62bac39ab4999cbb73fc546176fe1884f068c0962e208b98bfc";
const REEL = "3f0c2a8e-1b2d-4c3e-8f4a-5b6c7d8e9f01";

function stubDb(error: { message: string } | null = null) {
  const calls: unknown[][] = [];
  const db = {
    from(table: string) {
      calls.push(["from", table]);
      return {
        update(values: unknown) {
          calls.push(["update", values]);
          return {
            async eq(column: string, value: string) {
              calls.push(["eq", column, value]);
              return { error };
            },
          };
        },
      };
    },
  } as unknown as Pick<SupabaseClient, "from">;
  return { db, calls };
}

describe("previewCopiesRefs", () => {
  it("names both preview files under the preview_copies fingerprint", () => {
    expect(previewCopiesRefs({ retime: "x", preview_copies: FP })).toEqual({
      footage: { step: "preview_copies", fingerprint: FP, file: "footage-preview.mp4" },
      cutout: { step: "preview_copies", fingerprint: FP, file: "subject-preview.webm" },
    });
  });

  it("throws without the preview_copies fingerprint", () => {
    expect(() => previewCopiesRefs({ retime: "x" })).toThrow(/no fingerprint for preview_copies/);
  });
});

describe("recordPreviewCopies", () => {
  it("updates the reel's preview_copies column by id", async () => {
    const { db, calls } = stubDb();
    const refs = previewCopiesRefs({ preview_copies: FP });
    await recordPreviewCopies(db, REEL, refs);
    expect(calls).toEqual([
      ["from", "reels"],
      ["update", { preview_copies: refs }],
      ["eq", "id", REEL],
    ]);
  });

  it("throws a readable error when the update fails", async () => {
    const { db } = stubDb({ message: "boom" });
    await expect(
      recordPreviewCopies(db, REEL, previewCopiesRefs({ preview_copies: FP })),
    ).rejects.toThrow("preview copies not recorded: boom");
  });
});
