import { describe, expect, it } from "vitest";
import { OWNER_EDIT_FLAG, flagOverrides, flagsConfig, isFlagOn } from "./feature-flags";

const CONFIG = { projectToken: "phc_test", host: "https://eu.example.test" };
const OWNER = { id: "00000000-0000-4000-8000-000000000001", email: "owner@example.test" };

describe("flagsConfig", () => {
  const none = {
    serverToken: undefined,
    serverHost: undefined,
    publicToken: undefined,
    publicHost: undefined,
  };

  it("is null unless one pair is complete", () => {
    expect(flagsConfig(none)).toBeNull();
    expect(flagsConfig({ ...none, publicToken: "phc_a" })).toBeNull();
    expect(flagsConfig({ ...none, serverToken: " ", serverHost: "https://h" })).toBeNull();
  });

  it("prefers the server-only pair, else the public one", () => {
    expect(
      flagsConfig({
        serverToken: "phc_server",
        serverHost: "https://server",
        publicToken: "phc_public",
        publicHost: "https://public",
      }),
    ).toEqual({ projectToken: "phc_server", host: "https://server" });
    expect(
      flagsConfig({ ...none, publicToken: " phc_public ", publicHost: "https://public" }),
    ).toEqual({ projectToken: "phc_public", host: "https://public" });
  });
});

describe("flagOverrides", () => {
  it("reads a comma-separated list of keys", () => {
    expect(flagOverrides(undefined)).toEqual(new Set());
    expect(flagOverrides("")).toEqual(new Set());
    expect(flagOverrides(" studio-owner-edit , other ")).toEqual(
      new Set(["studio-owner-edit", "other"]),
    );
  });
});

describe("isFlagOn", () => {
  it("is the owner editor's flag", () => {
    expect(OWNER_EDIT_FLAG).toBe("studio-owner-edit");
  });

  it("is on when PostHog says so, for the user id with the email", async () => {
    const asked: unknown[] = [];
    const on = await isFlagOn(OWNER_EDIT_FLAG, OWNER, {
      config: CONFIG,
      overrides: new Set(),
      evaluate: async (config, key, user) => {
        asked.push({ config, key, user });
        return true;
      },
    });
    expect(on).toBe(true);
    expect(asked).toEqual([{ config: CONFIG, key: OWNER_EDIT_FLAG, user: OWNER }]);
  });

  it("is off when PostHog says off, fails or is not configured", async () => {
    const overrides = new Set<string>();
    expect(
      await isFlagOn(OWNER_EDIT_FLAG, OWNER, {
        config: CONFIG,
        overrides,
        evaluate: async () => false,
      }),
    ).toBe(false);
    expect(
      await isFlagOn(OWNER_EDIT_FLAG, OWNER, {
        config: CONFIG,
        overrides,
        evaluate: async () => {
          throw new Error("unreachable");
        },
      }),
    ).toBe(false);
    let called = false;
    expect(
      await isFlagOn(OWNER_EDIT_FLAG, OWNER, {
        config: null,
        overrides,
        evaluate: async () => {
          called = true;
          return true;
        },
      }),
    ).toBe(false);
    expect(called).toBe(false);
  });

  it("is on without PostHog when the tests' override names it", async () => {
    expect(
      await isFlagOn(OWNER_EDIT_FLAG, OWNER, {
        config: null,
        overrides: new Set([OWNER_EDIT_FLAG]),
      }),
    ).toBe(true);
    expect(
      await isFlagOn(OWNER_EDIT_FLAG, OWNER, { config: null, overrides: new Set(["other"]) }),
    ).toBe(false);
  });
});
