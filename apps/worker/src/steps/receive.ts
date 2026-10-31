import type { Storage } from "@edit-issebya/storage";
import { type StepContext, runInProcessStep } from "../step-runner.ts";

// The placeholder step: confirms the source object is in storage and records
// its size. An R2 HEAD reads and writes no file, so it runs in-process and is
// measured by wall time only. After an abort (lost lease) it writes nothing more.
export function receive(ctx: StepContext & { storage: Storage }): Promise<void> {
  const { steps, storage, job, signal } = ctx;
  return runInProcessStep(ctx, {
    name: "receive",
    async work() {
      const key = await steps.sourceKey(job.reel_id);
      if (!key) throw new Error("reel has no source key");
      const object = await storage.head(key, { signal });
      signal.throwIfAborted();
      if (!object) throw new Error("source object missing");
      return { what: "footage received", sizeBytes: object.bytes };
    },
  });
}
