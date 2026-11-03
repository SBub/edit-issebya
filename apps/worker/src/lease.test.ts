import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isJobCancelled, isJobGone, keepLease } from "./lease.ts";

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

  it("aborts with JobCancelled once the cancel check sees a cancel, and stops both timers", async () => {
    const renew = vi.fn(async () => true);
    let cancelledNow = false;
    const cancelled = vi.fn(async () => cancelledNow);
    const lease = keepLease({ renew, everyMs: 60_000, cancelled, cancelCheckEveryMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(lease.signal.aborted).toBe(false);
    cancelledNow = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toMatchObject({ name: "JobCancelled" });
    expect(isJobCancelled(lease.signal)).toBe(true);
    const checks = cancelled.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(cancelled).toHaveBeenCalledTimes(checks);
    expect(renew).not.toHaveBeenCalled();
  });

  it("checks for a cancel at once on checkCancelled", async () => {
    const lease = keepLease({
      renew: async () => true,
      everyMs: 60_000,
      cancelled: async () => true,
      cancelCheckEveryMs: 60_000,
    });
    expect(await lease.checkCancelled()).toBe(true);
    expect(isJobCancelled(lease.signal)).toBe(true);
    lease.stop();
  });

  it("never checks or cancels without a cancel check, and a failed check is not a cancel", async () => {
    const plain = keepLease({ renew: async () => true, everyMs: 1000 });
    expect(await plain.checkCancelled()).toBe(false);
    plain.stop();
    const failing = keepLease({
      renew: async () => true,
      everyMs: 60_000,
      cancelled: async () => {
        throw new Error("network");
      },
      cancelCheckEveryMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(failing.signal.aborted).toBe(false);
    failing.stop();
  });

  it("tells a lost lease from a cancel", async () => {
    const lease = keepLease({ renew: async () => false, everyMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(lease.signal.aborted).toBe(true);
    expect(isJobCancelled(lease.signal)).toBe(false);
  });

  it("aborts with JobGone after one renewal that found the row gone, and stops the timers", async () => {
    const renew = vi.fn(async () => false);
    const gone = vi.fn(async () => true);
    const lease = keepLease({ renew, everyMs: 1000, gone });
    await vi.advanceTimersByTimeAsync(1000);
    expect(lease.signal.aborted).toBe(true);
    expect(isJobGone(lease.signal)).toBe(true);
    expect(isJobCancelled(lease.signal)).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("stays a lost lease when the row is still there or the gone check fails", async () => {
    const still = keepLease({ renew: async () => false, everyMs: 1000, gone: async () => false });
    const failing = keepLease({
      renew: async () => false,
      everyMs: 1000,
      gone: async () => {
        throw new Error("network");
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    for (const lease of [still, failing]) {
      expect(lease.signal.aborted).toBe(true);
      expect(isJobGone(lease.signal)).toBe(false);
      expect((lease.signal.reason as Error).message).toBe("lease lost");
    }
  });

  it("checks for a gone row at once on checkGone, and never without a gone check", async () => {
    const plain = keepLease({ renew: async () => true, everyMs: 60_000 });
    expect(await plain.checkGone()).toBe(false);
    expect(plain.signal.aborted).toBe(false);
    plain.stop();
    const lease = keepLease({ renew: async () => true, everyMs: 60_000, gone: async () => true });
    expect(await lease.checkGone()).toBe(true);
    expect(isJobGone(lease.signal)).toBe(true);
    expect(await lease.checkGone()).toBe(true);
    lease.stop();
  });
});
