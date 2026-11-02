import { describe, expect, it } from "vitest";
import { PROGRESS_EVERY_MS, createProgressThrottle } from "./progress.ts";

function throttled({ fail = () => false }: { fail?: (percent: number) => boolean } = {}) {
  let clock = 0;
  const writes: { percent: number; at: number }[] = [];
  const errors: unknown[] = [];
  const throttle = createProgressThrottle({
    now: () => clock,
    async write(percent) {
      if (fail(percent)) throw new Error(`write ${percent} failed`);
      writes.push({ percent, at: clock });
    },
    onError: (error) => errors.push(error),
  });
  return {
    throttle,
    writes,
    errors,
    setClock(ms: number) {
      clock = ms;
    },
  };
}

describe("createProgressThrottle", () => {
  it("writes at most one value per 10 s over 7 minutes, rising, then 100", async () => {
    const { throttle, writes, setClock } = throttled();
    const lines = 1000;
    const durationMs = 7 * 60_000;
    for (let i = 0; i < lines; i += 1) {
      setClock(Math.round((i * durationMs) / lines));
      throttle.push(Math.floor((100 * i) / lines));
      await throttle.settled();
    }
    await throttle.finish();

    expect(writes.length).toBeLessThanOrEqual(43);
    expect(writes.at(-1)?.percent).toBe(100);
    const nonFinal = writes.slice(0, -1);
    for (let i = 1; i < nonFinal.length; i += 1) {
      expect(nonFinal[i]!.at - nonFinal[i - 1]!.at).toBeGreaterThanOrEqual(PROGRESS_EVERY_MS);
    }
    for (let i = 1; i < writes.length; i += 1) {
      expect(writes[i]!.percent).toBeGreaterThan(writes[i - 1]!.percent);
    }
  });

  it("writes the first value at once", async () => {
    const { throttle, writes } = throttled();
    throttle.push(3);
    await throttle.settled();
    expect(writes).toEqual([{ percent: 3, at: 0 }]);
  });

  it("never writes a lower value", async () => {
    const { throttle, writes, setClock } = throttled();
    throttle.push(40);
    setClock(20_000);
    throttle.push(30);
    setClock(40_000);
    throttle.push(40);
    setClock(60_000);
    throttle.push(41);
    await throttle.settled();
    expect(writes.map((w) => w.percent)).toEqual([40, 41]);
  });

  it("writes no 100 after stop()", async () => {
    const { throttle, writes } = throttled();
    throttle.push(10);
    throttle.stop();
    await throttle.settled();
    await throttle.finish();
    throttle.push(90);
    await throttle.settled();
    expect(writes.map((w) => w.percent)).toEqual([]);
  });

  it("keeps writing after a failed write", async () => {
    const { throttle, writes, errors, setClock } = throttled({ fail: (p) => p === 10 });
    throttle.push(10);
    setClock(10_000);
    throttle.push(20);
    await throttle.finish();
    expect(writes.map((w) => w.percent)).toEqual([20, 100]);
    expect(errors).toHaveLength(1);
  });
});
