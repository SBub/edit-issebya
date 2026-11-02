import { describe, expect, it } from "vitest";
import {
  assertLocalUrl,
  localDbUrl,
  localSupabaseAdmin,
  localSupabaseClient,
} from "./local-supabase";

describe("localSupabaseAdmin", () => {
  it("refuses the hosted project", () => {
    expect(() =>
      localSupabaseAdmin({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SECRET_KEY: "k" }),
    ).toThrow(/Refusing non-local Supabase URL/);
  });

  it("refuses a lookalike host", () => {
    expect(() =>
      localSupabaseAdmin({
        SUPABASE_URL: "https://127.0.0.1.evil.example",
        SUPABASE_SECRET_KEY: "k",
      }),
    ).toThrow(/Refusing non-local Supabase URL/);
  });

  it("refuses a missing key or URL", () => {
    expect(() => localSupabaseAdmin({ SUPABASE_URL: "http://127.0.0.1:54431" })).toThrow(
      /SUPABASE_SECRET_KEY/,
    );
    expect(() => localSupabaseAdmin({ SUPABASE_SECRET_KEY: "k" })).toThrow(/SUPABASE_URL/);
  });

  it("accepts the local stack", () => {
    expect(
      localSupabaseAdmin({ SUPABASE_URL: "http://127.0.0.1:54431", SUPABASE_SECRET_KEY: "k" }),
    ).toBeDefined();
    expect(
      localSupabaseAdmin({ SUPABASE_URL: "http://localhost:54431", SUPABASE_SECRET_KEY: "k" }),
    ).toBeDefined();
  });
});

describe("localSupabaseClient", () => {
  it("refuses the hosted project", () => {
    expect(() =>
      localSupabaseClient({
        NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pk",
      }),
    ).toThrow(/Refusing non-local Supabase URL/);
  });
});

describe("assertLocalUrl", () => {
  it("refuses an empty or unparsable URL", () => {
    expect(() => assertLocalUrl("")).toThrow(/Refusing/);
    expect(() => assertLocalUrl(undefined)).toThrow(/Refusing/);
    expect(() => assertLocalUrl("not a url")).toThrow(/Refusing/);
  });
});

describe("localDbUrl", () => {
  it("defaults to the shared stack's database", () => {
    expect(localDbUrl({})).toBe("postgresql://postgres:postgres@127.0.0.1:54432/postgres");
  });

  it("returns a local SUPABASE_DB_URL", () => {
    for (const url of [
      "postgresql://postgres:postgres@127.0.0.1:54452/postgres",
      "postgresql://postgres:postgres@localhost:54452/postgres",
    ]) {
      expect(localDbUrl({ SUPABASE_DB_URL: url })).toBe(url);
    }
  });

  it("refuses a hosted SUPABASE_DB_URL", () => {
    expect(() =>
      localDbUrl({ SUPABASE_DB_URL: "postgresql://postgres:x@db.abc.supabase.co:5432/postgres" }),
    ).toThrow(/Refusing non-local Supabase URL/);
  });
});
