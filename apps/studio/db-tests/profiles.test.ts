import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestUser, deleteTestUser, signedInClient } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";

// The owner's font pair (migration font_pair_profiles): a user reads, inserts
// and changes only their own row's pair, and the worker reads every row.
describe("profiles RLS", () => {
  const admin = localSupabaseAdmin();
  let userA: { id: string; email: string };
  let userB: { id: string; email: string };
  let clientA: SupabaseClient;
  let clientB: SupabaseClient;

  beforeAll(async () => {
    userA = await createTestUser(admin, "profile-a");
    userB = await createTestUser(admin, "profile-b");
    clientA = (await signedInClient(admin, userA.email)).client;
    clientB = (await signedInClient(admin, userB.email)).client;
  });

  afterAll(async () => {
    if (userA) await deleteTestUser(admin, userA.id);
    if (userB) await deleteTestUser(admin, userB.id);
  });

  it("gives a new row the classic pair by default", async () => {
    const { error } = await admin.from("profiles").insert({ user_id: userA.id });
    expect(error).toBeNull();
    const { data } = await admin
      .from("profiles")
      .select("font_pair")
      .eq("user_id", userA.id)
      .single();
    expect(data).toEqual({ font_pair: "classic" });
  });

  it("lets the owner read their own row and no one else's", async () => {
    const own = await clientA.from("profiles").select("user_id, font_pair").eq("user_id", userA.id);
    expect(own.error).toBeNull();
    expect(own.data).toEqual([{ user_id: userA.id, font_pair: "classic" }]);
    const other = await clientB.from("profiles").select("user_id").eq("user_id", userA.id);
    expect(other.error).toBeNull();
    expect(other.data).toEqual([]);
  });

  it("lets the owner insert their own row, but not one for another user", async () => {
    const own = await clientB.from("profiles").insert({ user_id: userB.id, font_pair: "retro" });
    expect(own.error).toBeNull();
    const forOther = await clientB
      .from("profiles")
      .insert({ user_id: userA.id, font_pair: "bold" });
    expect(forOther.error).not.toBeNull();
  });

  it("lets the owner change their pair, and refuses a pair outside the six", async () => {
    const changed = await clientA
      .from("profiles")
      .update({ font_pair: "script" })
      .eq("user_id", userA.id)
      .select("font_pair");
    expect(changed.error).toBeNull();
    expect(changed.data).toEqual([{ font_pair: "script" }]);
    const unknown = await clientA
      .from("profiles")
      .update({ font_pair: "primary" })
      .eq("user_id", userA.id);
    expect(unknown.error).not.toBeNull();
  });

  it("does not let another user change the pair, nor the owner delete the row", async () => {
    const otherChange = await clientB
      .from("profiles")
      .update({ font_pair: "handwritten" })
      .eq("user_id", userA.id)
      .select("user_id");
    expect(otherChange.error).toBeNull();
    expect(otherChange.data).toEqual([]);
    const { data: unchanged } = await admin
      .from("profiles")
      .select("font_pair")
      .eq("user_id", userA.id)
      .single();
    expect(unchanged).toEqual({ font_pair: "script" });
    const deleted = await clientA.from("profiles").delete().eq("user_id", userA.id);
    expect(deleted.error).not.toBeNull();
  });

  it("is read by the worker's service role for every user", async () => {
    const { data, error } = await admin
      .from("profiles")
      .select("user_id, font_pair")
      .in("user_id", [userA.id, userB.id]);
    expect(error).toBeNull();
    expect(data?.length).toBe(2);
  });
});
