import { describe, expect, it } from "vitest";
import { createDrainer } from "./loop.ts";

describe("createDrainer", () => {
  it("drains until claim returns null", async () => {
    const queue = [1, 2, 3];
    const ran: number[] = [];
    const drainer = createDrainer({
      claim: async () => queue.shift() ?? null,
      run: async (job: number) => {
        ran.push(job);
      },
    });
    drainer.signal();
    await drainer.idle();
    expect(ran).toEqual([1, 2, 3]);
  });

  it("coalesces signals while busy into exactly one more pass", async () => {
    let claims = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const drainer = createDrainer({
      claim: async () => {
        claims += 1;
        return claims === 1 ? "job" : null;
      },
      run: async () => {
        await gate;
      },
    });
    drainer.signal();
    await Promise.resolve();
    drainer.signal();
    drainer.signal();
    release();
    await drainer.idle();
    // First pass: claim (job), claim (null); one extra pass: claim (null).
    expect(claims).toBe(3);
  });

  it("reports an error and recovers", async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const drainer = createDrainer({
      claim: async () => {
        calls += 1;
        if (calls === 1) throw new Error("down");
        return null;
      },
      run: async () => {},
      onError: (error) => errors.push(error),
    });
    drainer.signal();
    await drainer.idle();
    drainer.signal();
    await drainer.idle();
    expect(errors).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
