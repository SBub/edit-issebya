import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  type WorkerStatusStore,
  freeBytesFn,
  guardedClaim,
  statfsFreeBytes,
  waitingReason,
} from "./disk-guard.ts";

const GB = 1024 ** 3;

function memoryStatus() {
  const rows: { freeDiskBytes: number; waitingReason: string | null }[] = [];
  const status: WorkerStatusStore = {
    async set(row) {
      rows.push(row);
    },
  };
  return { rows, status };
}

async function attempt(freeGb: number) {
  const { rows, status } = memoryStatus();
  let claims = 0;
  const logs: string[] = [];
  const job = await guardedClaim({
    dir: "/scratch",
    minFreeDiskGb: 10,
    freeBytes: async () => freeGb * GB,
    status,
    claim: async () => {
      claims += 1;
      return { id: "job-1" };
    },
    log: (message) => logs.push(message),
  });
  return { job, claims, rows, logs };
}

describe("guardedClaim", () => {
  it("never claims below the minimum and writes why", async () => {
    const { job, claims, rows, logs } = await attempt(9);
    expect(claims).toBe(0);
    expect(job).toBeNull();
    const reason = "waiting: 9.0 GB free on the worker's disk, needs 10 GB";
    expect(rows).toEqual([{ freeDiskBytes: 9 * GB, waitingReason: reason }]);
    expect(logs).toEqual([`worker: ${reason}`]);
  });

  it("claims above the minimum and clears the reason", async () => {
    const { job, claims, rows } = await attempt(11);
    expect(claims).toBe(1);
    expect(job).toEqual({ id: "job-1" });
    expect(rows).toEqual([{ freeDiskBytes: 11 * GB, waitingReason: null }]);
  });

  it("claims at exactly the minimum", async () => {
    const { claims } = await attempt(10);
    expect(claims).toBe(1);
  });
});

describe("waitingReason", () => {
  it("gives the free space to one decimal and the minimum as configured", () => {
    expect(waitingReason(7.2 * GB, 10)).toBe(
      "waiting: 7.2 GB free on the worker's disk, needs 10 GB",
    );
    expect(waitingReason(0, 2.5)).toBe("waiting: 0.0 GB free on the worker's disk, needs 2.5 GB");
  });
});

describe("freeBytesFn", () => {
  it("forces the free space only under E2E_MOCK_STORAGE set to exactly 'true'", async () => {
    expect(
      await freeBytesFn({ E2E_MOCK_STORAGE: "true", E2E_MOCK_FREE_DISK_GB: "7.2" })("/x"),
    ).toBe(Math.round(7.2 * GB));
    for (const flag of [undefined, "", "1", "TRUE", "yes"]) {
      expect(freeBytesFn({ E2E_MOCK_STORAGE: flag, E2E_MOCK_FREE_DISK_GB: "7.2" })).toBe(
        statfsFreeBytes,
      );
    }
    expect(freeBytesFn({ E2E_MOCK_STORAGE: "true" })).toBe(statfsFreeBytes);
  });

  it("refuses a malformed forced value", () => {
    for (const value of ["lots", "-1"]) {
      expect(() => freeBytesFn({ E2E_MOCK_STORAGE: "true", E2E_MOCK_FREE_DISK_GB: value })).toThrow(
        /E2E_MOCK_FREE_DISK_GB/,
      );
    }
  });
});

describe("statfsFreeBytes", () => {
  it("reads a positive free space", async () => {
    expect(await statfsFreeBytes(tmpdir())).toBeGreaterThan(0);
  });
});
