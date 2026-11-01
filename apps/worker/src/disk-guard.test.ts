import { describe, expect, it, vi } from "vitest";
import { claimIfRoom, createDiskGuard, freeDiskBytes, waitingReason } from "./disk-guard.ts";

const GB = 1024 ** 3;

function guardAt(free: { gb: number }) {
  const writes: { freeDiskBytes: number; waitingReason: string | null }[] = [];
  const guard = createDiskGuard({
    freeBytes: async () => free.gb * GB,
    minFreeDiskGb: 10,
    status: { write: async (status) => void writes.push(status) },
    log: () => {},
  });
  return { guard, writes };
}

describe("claimIfRoom", () => {
  it("never claims below the minimum and writes the reason, then claims once there is room", async () => {
    const free = { gb: 9 };
    const { guard, writes } = guardAt(free);
    const claim = vi.fn(async () => ({ id: "job-1" }));
    const claimWithRoom = claimIfRoom(guard, claim);

    expect(await claimWithRoom()).toBeNull();
    expect(claim).not.toHaveBeenCalled();
    expect(writes).toEqual([
      {
        freeDiskBytes: 9 * GB,
        waitingReason: "waiting: 9.0 GB free on the worker's disk, needs 10 GB",
      },
    ]);

    free.gb = 11;
    expect(await claimWithRoom()).toEqual({ id: "job-1" });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(writes.at(-1)).toEqual({ freeDiskBytes: 11 * GB, waitingReason: null });
  });

  it("writes an unchanged state only once", async () => {
    const low = guardAt({ gb: 9 });
    await low.guard.check();
    await low.guard.check();
    expect(low.writes).toHaveLength(1);

    const roomy = guardAt({ gb: 50 });
    await roomy.guard.check();
    await roomy.guard.check();
    expect(roomy.writes).toEqual([{ freeDiskBytes: 50 * GB, waitingReason: null }]);
  });
});

describe("waitingReason", () => {
  it("names the free space with one decimal and the minimum as configured", () => {
    expect(waitingReason(7.2 * GB, 10)).toBe(
      "waiting: 7.2 GB free on the worker's disk, needs 10 GB",
    );
    expect(waitingReason(0.5 * GB, 2.5)).toBe(
      "waiting: 0.5 GB free on the worker's disk, needs 2.5 GB",
    );
  });
});

describe("freeDiskBytes", () => {
  const dir = process.cwd();

  it("uses E2E_MOCK_FREE_DISK_GB under E2E_MOCK_STORAGE=true", async () => {
    const env = { E2E_MOCK_STORAGE: "true", E2E_MOCK_FREE_DISK_GB: "7.2" };
    expect(await freeDiskBytes(dir, env)).toBe(7.2 * GB);
  });

  it("ignores it unless the flag is exactly true, and reads the real volume", async () => {
    for (const env of [
      { E2E_MOCK_FREE_DISK_GB: "7.2" },
      { E2E_MOCK_STORAGE: "1", E2E_MOCK_FREE_DISK_GB: "7.2" },
    ]) {
      const free = await freeDiskBytes(dir, env);
      expect(free).toBeGreaterThan(0);
      expect(free).not.toBe(7.2 * GB);
    }
  });
});
