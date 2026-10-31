import { describe, expect, it } from "vitest";
import { supabaseConfig } from "./supabase-config";

describe("supabaseConfig", () => {
  it("returns both values when both are set", () => {
    expect(
      supabaseConfig({
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54431",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pk",
      }),
    ).toEqual({ url: "http://127.0.0.1:54431", publishableKey: "pk" });
  });

  it("returns null when one is missing", () => {
    expect(supabaseConfig({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54431" })).toBeNull();
    expect(supabaseConfig({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pk" })).toBeNull();
  });

  it("returns null when both are empty", () => {
    expect(
      supabaseConfig({ NEXT_PUBLIC_SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: " " }),
    ).toBeNull();
  });
});
