import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_EVERY_MS, startHeartbeat } from "./heartbeat.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("startHeartbeat", () => {
  it("beats at once and every five minutes, never after stop()", async () => {
    expect(HEARTBEAT_EVERY_MS).toBe(300_000);
    const beat = vi.fn(async () => {});
    const heartbeat = startHeartbeat({ beat });
    expect(beat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS - 1);
    expect(beat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(beat).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS);
    expect(beat).toHaveBeenCalledTimes(3);
    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(3 * HEARTBEAT_EVERY_MS);
    expect(beat).toHaveBeenCalledTimes(3);
  });

  it("keeps beating after a failed beat", async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const beat = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
    });
    const heartbeat = startHeartbeat({ beat, onError: (error) => errors.push(error) });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS);
    expect(beat).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    heartbeat.stop();
  });
});
