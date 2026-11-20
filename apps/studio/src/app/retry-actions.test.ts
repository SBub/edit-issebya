import { beforeEach, describe, expect, it, vi } from "vitest";

// requestRetry copies the failed job's parameters into the new job's row; a
// relayout job needs its font_pair or the insert policy refuses the retry.

const REEL = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";

let inserted: Record<string, unknown> | null = null;
let failedJob: Record<string, unknown>;

vi.mock("@/lib/error-tracking", () => ({
  reportFailure: vi.fn(async () => undefined),
  serverErrorCapture: vi.fn(() => ({})),
}));

vi.mock("@/lib/supabase-server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: (table: string) => {
      if (table === "reels") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { id: REEL, status: "processed" } }) }),
          }),
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: failedJob }) }) }),
        insert: (row: Record<string, unknown>) => {
          inserted = row;
          return { select: () => ({ single: async () => ({ data: { id: "new" }, error: null }) }) };
        },
      };
    },
  }),
}));

const { requestRetry } = await import("./retry-actions");

function failed(extra: Record<string, unknown>) {
  failedJob = {
    id: JOB,
    reel_id: REEL,
    kind: "process",
    status: "failed",
    request: null,
    restore_version_id: null,
    version_id: null,
    owner_edit: null,
    font_pair: null,
    ...extra,
  };
}

beforeEach(() => {
  inserted = null;
});

describe("requestRetry", () => {
  it("copies the font pair of a failed relayout job", async () => {
    failed({ kind: "relayout", font_pair: "modern" });
    expect(await requestRetry({ reelId: REEL, jobId: JOB })).toEqual({
      status: "queued",
      jobId: "new",
    });
    expect(inserted).toEqual({
      reel_id: REEL,
      kind: "relayout",
      retry_of_job_id: JOB,
      font_pair: "modern",
    });
  });

  it("sends no font pair for a job that has none", async () => {
    failed({});
    await requestRetry({ reelId: REEL, jobId: JOB });
    expect(inserted).toEqual({ reel_id: REEL, kind: "process", retry_of_job_id: JOB });
  });
});
