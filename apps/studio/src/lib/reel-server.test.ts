import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorCapture } from "./error-tracking";
import { deleteReel } from "./reel-server";

const REEL = "0b9f6c1e-3c1d-4c8e-9a51-2f4d7b6e8a10";

// A Supabase client stand-in: the signed-in user (or none) and a record of
// RPCs, answering with the given error.
function client({ user = true, rpcError = null as unknown } = {}) {
  const rpcs: { name: string; args: unknown }[] = [];
  const supabase = {
    auth: { getUser: async () => ({ data: { user: user ? { id: "u" } : null } }) },
    rpc: async (name: string, args: unknown) => {
      rpcs.push({ name, args });
      return { data: null, error: rpcError };
    },
  } as unknown as SupabaseClient;
  return { supabase, rpcs };
}

const captured: string[] = [];
const errors: ErrorCapture = {
  capture(error) {
    captured.push(error.message);
  },
  async flush() {},
};

beforeEach(() => {
  captured.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("deleteReel", () => {
  it("deletes the reel through delete_reel", async () => {
    const { supabase, rpcs } = client();
    expect(await deleteReel({ supabase, errors }, { reelId: REEL })).toEqual({
      ok: true,
      value: { reelId: REEL },
    });
    expect(rpcs).toEqual([{ name: "delete_reel", args: { p_reel_id: REEL } }]);
    expect(captured).toEqual([]);
  });

  it("answers not-found for a malformed id without calling anything", async () => {
    for (const reelId of ["nope", 42, null, `${REEL}x`]) {
      const { supabase, rpcs } = client();
      expect(await deleteReel({ supabase, errors }, { reelId })).toEqual({
        ok: false,
        error: "not-found",
      });
      expect(rpcs).toEqual([]);
    }
  });

  it("answers signed-out without a user and unavailable without a client", async () => {
    const { supabase, rpcs } = client({ user: false });
    expect(await deleteReel({ supabase, errors }, { reelId: REEL })).toEqual({
      ok: false,
      error: "signed-out",
    });
    expect(rpcs).toEqual([]);
    expect(await deleteReel({ supabase: null, errors }, { reelId: REEL })).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it("answers not-found for another owner's or a deleted reel, capturing nothing", async () => {
    const { supabase } = client({ rpcError: { code: "P0002", message: "no reel of yours" } });
    expect(await deleteReel({ supabase, errors }, { reelId: REEL })).toEqual({
      ok: false,
      error: "not-found",
    });
    expect(captured).toEqual([]);
  });

  it("reports any other error and answers failed", async () => {
    const { supabase } = client({ rpcError: { code: "57014", message: "timeout" } });
    expect(await deleteReel({ supabase, errors }, { reelId: REEL })).toEqual({
      ok: false,
      error: "failed",
    });
    expect(captured).toEqual(["studio: reel not deleted"]);
  });
});
