// Test helper: a StepStore that records its calls, and a step context around
// it with telemetry that exports nothing unless processors are passed.
import { ROOT_CONTEXT } from "@opentelemetry/api";
import type { ClaimedJob } from "./queue.ts";
import type { StepContext } from "./step-runner.ts";
import type { StepMeasurements, StepStore } from "./step-store.ts";
import { type Telemetry, createTelemetry } from "./telemetry.ts";

export type StepCall =
  | { call: "start"; jobId: string; name: string }
  | { call: "done"; stepId: string; summary: string; measurements: StepMeasurements }
  | {
      call: "failed";
      stepId: string;
      tail: string;
      summary: string;
      measurements: StepMeasurements;
    };

export function recordingSteps(sourceKey: string | null = null) {
  const calls: StepCall[] = [];
  let next = 0;
  const steps: StepStore = {
    async start(job, name) {
      calls.push({ call: "start", jobId: job.id, name });
      next += 1;
      return `s${next}`;
    },
    async sourceKey() {
      return sourceKey;
    },
    async done(stepId, summary, measurements) {
      calls.push({ call: "done", stepId, summary, measurements });
    },
    async failed(stepId, tail, summary, measurements) {
      calls.push({ call: "failed", stepId, tail, summary, measurements });
    },
  };
  return { steps, calls };
}

export const TEST_JOB: ClaimedJob = {
  id: "0b6f2a52-7d0e-4c55-9d4a-3c1f0e8a1b01",
  reel_id: "5f1c9e2a-0d3b-4a7e-8c6f-2b9d4e1a7c30",
  owner_id: "o1",
  kind: "process",
  attempts: 1,
};

export function stepContext(
  steps: StepStore,
  {
    signal = new AbortController().signal,
    telemetry = createTelemetry({}),
    job = TEST_JOB,
  }: { signal?: AbortSignal; telemetry?: Telemetry; job?: ClaimedJob } = {},
): StepContext {
  return { steps, telemetry, jobContext: ROOT_CONTEXT, job, signal };
}
