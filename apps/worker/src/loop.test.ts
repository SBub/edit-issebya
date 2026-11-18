import { describe, expect, it } from "vitest";
import { createDrainer, createLanes } from "./loop.ts";

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

// A queue of jobs by kind and the two lanes of queue.ts over it: `export`
// takes only renders, `main` everything else. `release(id)` ends a job.
function twoLanes(kinds: readonly string[], between?: () => Promise<void>) {
  const queue = kinds.map((kind, index) => ({ id: index + 1, kind }));
  const running = new Set<number>();
  // Each entry: the kinds running right after a job started.
  const started: { id: number; lane: string; alongside: string[] }[] = [];
  const gates = new Map<number, () => void>();
  const take = (wanted: (kind: string) => boolean) => async () => {
    const at = queue.findIndex((job) => wanted(job.kind));
    return at < 0 ? null : queue.splice(at, 1)[0]!;
  };
  const kindOf = new Map(queue.map((job) => [job.id, job.kind]));
  const lanes = createLanes({
    lanes: [
      { name: "export", claim: take((kind) => kind === "render") },
      { name: "main", claim: take((kind) => kind !== "render") },
    ],
    between,
    run: async (job, lane) => {
      started.push({
        id: job.id,
        lane,
        alongside: [...running].map((id) => kindOf.get(id)!),
      });
      running.add(job.id);
      await new Promise<void>((resolve) => gates.set(job.id, resolve));
      running.delete(job.id);
    },
  });
  return {
    lanes,
    running,
    started,
    release(id: number) {
      gates.get(id)!();
    },
  };
}

// Lets every pending claim and start settle.
async function settle() {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe("createLanes", () => {
  it("runs a describe job and a process job while a render is running", async () => {
    const { lanes, running, started, release } = twoLanes(["render", "describe_photo", "process"]);
    lanes.signal();
    await settle();
    // The render and the photo run side by side, each in its lane.
    expect([...running]).toEqual([1, 2]);
    expect(started.map((entry) => entry.lane)).toEqual(["export", "main"]);
    release(2);
    await settle();
    // The render still runs; the main lane moved on to the upload.
    expect([...running]).toEqual([1, 3]);
    expect(started[2]).toEqual({ id: 3, lane: "main", alongside: ["render"] });
    release(3);
    release(1);
    await lanes.idle();
    expect(running.size).toBe(0);
  });

  it("never runs two renders together, nor two jobs of the main lane", async () => {
    const { lanes, running, started, release } = twoLanes([
      "render",
      "render",
      "owner_edit",
      "process",
    ]);
    lanes.signal();
    await settle();
    expect([...running]).toEqual([1, 3]);
    release(3);
    await settle();
    expect([...running]).toEqual([1, 4]);
    release(1);
    await settle();
    // The second render starts only once the first has ended.
    expect([...running]).toEqual([4, 2]);
    release(2);
    release(4);
    await lanes.idle();
    for (const entry of started) {
      const kind = entry.lane === "export" ? "render" : "other";
      const same = entry.alongside.filter((other) =>
        kind === "render" ? other === "render" : other !== "render",
      );
      expect(same).toEqual([]);
    }
  });

  it("runs the pass between jobs only while no lane runs a job", async () => {
    const seen: number[] = [];
    let passes = 0;
    const lanesRef: { running?: Set<number> } = {};
    const { lanes, running, release } = twoLanes(["render", "process", "process"], async () => {
      passes += 1;
      seen.push(lanesRef.running?.size ?? 0);
      // A slow pass: both lanes wait for it before they claim.
      await settle();
      seen.push(lanesRef.running?.size ?? 0);
    });
    lanesRef.running = running;
    lanes.signal();
    await settle();
    await settle();
    expect([...running]).toEqual([1, 2]);
    const before = passes;
    release(2);
    await settle();
    await settle();
    // The main lane claimed again while the render ran: no pass then.
    expect([...running]).toEqual([1, 3]);
    expect(passes).toBe(before);
    release(1);
    release(3);
    await lanes.idle();
    // Every pass saw no running job, at its start and at its end.
    expect(seen.every((count) => count === 0)).toBe(true);
    expect(passes).toBeGreaterThan(before);
  });

  it("wakes every lane on a signal and reports a lane's error", async () => {
    const errors: unknown[] = [];
    const claims: string[] = [];
    const lanes = createLanes({
      lanes: [
        {
          name: "export",
          claim: async () => {
            claims.push("export");
            throw new Error("down");
          },
        },
        {
          name: "main",
          claim: async () => {
            claims.push("main");
            return null;
          },
        },
      ],
      run: async () => {},
      onError: (error) => errors.push(error),
    });
    lanes.signal();
    await lanes.idle();
    expect(claims.sort()).toEqual(["export", "main"]);
    expect(errors).toHaveLength(1);
    // The failed lane claims again on the next signal.
    lanes.signal();
    await lanes.idle();
    expect(claims.filter((name) => name === "export")).toHaveLength(2);
  });
});
