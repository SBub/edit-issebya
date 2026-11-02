import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { workerConfig } from "./config.ts";

const BASE = {
  SUPABASE_URL: "http://127.0.0.1:54431",
  SUPABASE_SECRET_KEY: "sk",
  WORKER_ID: "mac-dev",
};

describe("workerConfig", () => {
  it("applies the defaults", () => {
    expect(workerConfig(BASE)).toEqual({
      supabaseUrl: "http://127.0.0.1:54431",
      secretKey: "sk",
      workerId: "mac-dev",
      pollIntervalSeconds: 120,
      leaseSeconds: 300,
      renewEveryMs: 60_000,
      minFreeDiskGb: 10,
      scratchDir: tmpdir(),
      keyPrefix: "",
    });
  });

  it("reads the optional variables", () => {
    const config = workerConfig({
      ...BASE,
      WORKER_POLL_INTERVAL_SECONDS: "30",
      WORKER_MIN_FREE_DISK_GB: "2.5",
      WORKER_SCRATCH_DIR: "/scratch",
      R2_KEY_PREFIX: " dev/ ",
    });
    expect(config.keyPrefix).toBe("dev/");
    expect(config.pollIntervalSeconds).toBe(30);
    expect(config.minFreeDiskGb).toBe(2.5);
    expect(config.scratchDir).toBe("/scratch");
  });

  it("names every missing variable in one message", () => {
    expect(() => workerConfig({})).toThrow(/SUPABASE_URL, SUPABASE_SECRET_KEY, WORKER_ID/);
    expect(() => workerConfig({ ...BASE, WORKER_ID: " " })).toThrow(/missing WORKER_ID/);
  });

  it("refuses a malformed key prefix, naming R2_KEY_PREFIX", () => {
    for (const value of ["dev", "/dev/", "Dev/"]) {
      expect(() => workerConfig({ ...BASE, R2_KEY_PREFIX: value })).toThrow(/R2_KEY_PREFIX/);
    }
  });

  it("refuses a poll interval that is not a positive integer", () => {
    for (const value of ["0", "-5", "1.5", "soon"]) {
      expect(() => workerConfig({ ...BASE, WORKER_POLL_INTERVAL_SECONDS: value })).toThrow(
        /WORKER_POLL_INTERVAL_SECONDS/,
      );
    }
  });
});
