import { availableParallelism, totalmem } from "node:os";

// What the cut-out's span tool calls may use together: the CPUs this process
// may run on and the memory it may hold (the container's limit when it has
// one, else the machine's).
export interface PoolLimits {
  cpus: number;
  memoryBytes: number;
}

export function machineLimits(): PoolLimits {
  const total = totalmem();
  // 0 or more than the machine has: no limit set (cgroup "max").
  const constrained = process.constrainedMemory();
  return {
    cpus: availableParallelism(),
    memoryBytes: constrained > 0 && constrained < total ? constrained : total,
  };
}

export const CUTOUT_POOL = {
  // What one span's tool call is counted as holding: the entry with its two
  // ffmpegs peaks at about 0.9 GB on 1080x1920 footage (app_docs/pipeline.md).
  processBytes: 1024 ** 3,
  // The share of the memory limit the span tool calls may hold together: the
  // rest is the worker's, the job's other work and the system's.
  memoryShare: 0.5,
} as const;

// How many span tool calls of one `cutout` step run at once, and the ONNX
// intra-op threads of each span (by its place in `seconds`, the spans'
// lengths). As many calls at once as there are spans, CPUs and memory for (at
// least one). Every span starts with one thread; one more goes, again and
// again, to the span with the most footage per thread (the step lasts as long
// as its slowest span), unless that would put the busiest calls that can run
// together over the CPU count.
export function cutoutPool(
  seconds: readonly number[],
  limits: PoolLimits,
): { concurrency: number; threads: number[] } {
  const cpus = Math.max(1, Math.floor(limits.cpus));
  const byMemory = Math.floor(
    (limits.memoryBytes * CUTOUT_POOL.memoryShare) / CUTOUT_POOL.processBytes,
  );
  const concurrency = Math.max(1, Math.min(seconds.length, cpus, byMemory));
  const threads = seconds.map(() => 1);
  // The threads of the calls that can run together at worst: the busiest ones.
  const busiest = () =>
    [...threads]
      .sort((a, b) => b - a)
      .slice(0, concurrency)
      .reduce((sum, count) => sum + count, 0);
  // Spans that cannot take one more thread.
  const full = new Set<number>();
  while (full.size < threads.length) {
    let slowest = -1;
    for (const index of threads.keys()) {
      if (full.has(index)) continue;
      if (
        slowest < 0 ||
        seconds[index]! / threads[index]! > seconds[slowest]! / threads[slowest]!
      ) {
        slowest = index;
      }
    }
    threads[slowest]! += 1;
    if (busiest() > cpus) {
      threads[slowest]! -= 1;
      full.add(slowest);
    }
  }
  return { concurrency, threads };
}

// Runs `work` over the items, at most `concurrency` at a time, in order of
// start. After a failure no further item starts; the ones already running are
// awaited (each tool call ends or is killed by the step's own signal), then
// the first failure is thrown.
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        await work(items[index]!, index);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  if (failed) throw failure;
}
