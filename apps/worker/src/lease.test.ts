import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepLease } from "./lease.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("keepLease", () => {
  it("renews every interval while held", async () => {
    const renew = vi.fn(async () => true);
    const lease = keepLease({ renew, everyMs: 1000 });
    await vi.advanceTimersByTimeAsync(3500);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(lease.signal.aborted).toBe(false);
    lease.stop();
  });

  it("aborts when a renewal returns false, and stops renewing", async () => {
    const renew = vi.fn(async () => false);
    const lease = keepLease({ renew, everyMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(lease.signal.aborted).toBe(true);
    expect((lease.signal.reason as Error).message).toBe("lease lost");
    await vi.advanceTimersByTimeAsync(5000);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it("aborts when a renewal throws", async () => {
    const lease = keepLease({
      renew: async () => {
        throw new Error("network");
      },
      everyMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(lease.signal.aborted).toBe(true);
  });

  it("stops renewing on stop()", async () => {
    const renew = vi.fn(async () => true);
    const lease = keepLease({ renew, everyMs: 1000 });
    lease.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(renew).not.toHaveBeenCalled();
    expect(lease.signal.aborted).toBe(false);
  });
});
