import { describe, expect, it } from "vitest";
import { CUTOUT_POOL, cutoutPool, machineLimits, runPool } from "./pool.ts";

const GB = 1024 ** 3;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
// The threads of the calls that can run together at worst.
const busiest = (threads: number[], concurrency: number) =>
  sum([...threads].sort((a, b) => b - a).slice(0, concurrency));

describe("cutoutPool", () => {
  // The measured reel: five spans of 1.73 s and one of 5.03 s.
  const reel = [1.733, 1.733, 1.734, 1.733, 5.033, 1.733];

  it("runs every span at once when the CPUs and memory allow, the long span on the spare CPUs", () => {
    expect(cutoutPool(reel, { cpus: 8, memoryBytes: 64 * GB })).toEqual({
      concurrency: 6,
      threads: [1, 1, 1, 1, 3, 1],
    });
  });

  it("caps the calls at once by memory: half the limit, one call's worth each", () => {
    expect(CUTOUT_POOL).toEqual({ processBytes: GB, memoryShare: 0.5 });
    // Docker Desktop's 7.75 GiB: 3.875 GiB for the calls.
    const tight = cutoutPool(reel, { cpus: 8, memoryBytes: 7.75 * GB });
    expect(tight.concurrency).toBe(3);
    expect(tight.threads).toEqual([2, 2, 2, 2, 4, 2]);
    expect(cutoutPool(reel, { cpus: 8, memoryBytes: 8 * GB }).concurrency).toBe(4);
    // Never less than one, however little memory there is.
    expect(cutoutPool(reel, { cpus: 8, memoryBytes: 0.5 * GB })).toEqual({
      concurrency: 1,
      threads: [8, 8, 8, 8, 8, 8],
    });
  });

  it("caps the calls at once by the CPUs, one thread each", () => {
    expect(cutoutPool(reel, { cpus: 2, memoryBytes: 64 * GB })).toEqual({
      concurrency: 2,
      threads: [1, 1, 1, 1, 1, 1],
    });
    expect(cutoutPool(reel, { cpus: 1, memoryBytes: 64 * GB })).toEqual({
      concurrency: 1,
      threads: [1, 1, 1, 1, 1, 1],
    });
  });

  it("never plans more threads than CPUs for the calls that can run together", () => {
    for (const cpus of [1, 2, 3, 4, 6, 8, 12, 16]) {
      for (const memory of [1, 3, 4, 7.75, 16, 64]) {
        for (const seconds of [reel, [3], [2, 2], [1, 9, 1, 9, 1, 9, 1, 9, 1, 9]]) {
          const { concurrency, threads } = cutoutPool(seconds, { cpus, memoryBytes: memory * GB });
          expect(concurrency).toBeGreaterThanOrEqual(1);
          expect(concurrency).toBeLessThanOrEqual(Math.min(seconds.length, cpus));
          expect(threads).toHaveLength(seconds.length);
          expect(Math.min(...threads)).toBeGreaterThanOrEqual(1);
          expect(busiest(threads, concurrency)).toBeLessThanOrEqual(cpus);
          // And never leaves a CPU unused that the slowest span could take.
          if (concurrency * 1 < cpus)
            expect(busiest(threads, concurrency)).toBeGreaterThan(concurrency);
        }
      }
    }
  });

  it("uses a single span's CPUs whole, and plans nothing for no span", () => {
    expect(cutoutPool([4], { cpus: 8, memoryBytes: 64 * GB })).toEqual({
      concurrency: 1,
      threads: [8],
    });
    expect(cutoutPool([], { cpus: 8, memoryBytes: 64 * GB })).toEqual({
      concurrency: 1,
      threads: [],
    });
  });

  it("reads this machine's limits", () => {
    const limits = machineLimits();
    expect(limits.cpus).toBeGreaterThanOrEqual(1);
    expect(limits.memoryBytes).toBeGreaterThan(0);
  });
});

describe("runPool", () => {
  // Work that holds each item until released, and counts how many run at once.
  function tracked() {
    let running = 0;
    let most = 0;
    const started: number[] = [];
    const release: (() => void)[] = [];
    const work = async (item: number) => {
      started.push(item);
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => release.push(resolve));
      running -= 1;
    };
    return { work, started, release, most: () => most };
  }
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it("runs at most `concurrency` items at a time, in order, and all of them", async () => {
    const { work, started, release, most } = tracked();
    const done = runPool([0, 1, 2, 3, 4, 5], 4, work);
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    release.shift()!();
    await tick();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    while (started.length < 6 || release.length > 0) {
      release.shift()?.();
      await tick();
    }
    await done;
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    expect(most()).toBe(4);
  });

  it("runs one at a time with a pool of one", async () => {
    const order: string[] = [];
    await runPool([1, 2, 3], 1, async (item) => {
      order.push(`start ${item}`);
      await tick();
      order.push(`end ${item}`);
    });
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
  });

  it("starts nothing after a failure, waits for the running ones, then throws the first", async () => {
    const started: number[] = [];
    const ended: number[] = [];
    const done = runPool([0, 1, 2, 3, 4], 2, async (item) => {
      started.push(item);
      if (item === 0) throw new Error("span 0 failed");
      await tick();
      await tick();
      ended.push(item);
      if (item === 1) throw new Error("span 1 failed later");
    });
    await expect(done).rejects.toThrow("span 0 failed");
    expect(started).toEqual([0, 1]);
    // The one already running was awaited, not abandoned.
    expect(ended).toEqual([1]);
  });

  it("does nothing for no items", async () => {
    await expect(runPool([], 4, async () => Promise.reject(new Error("never")))).resolves.toBe(
      undefined,
    );
  });
});
