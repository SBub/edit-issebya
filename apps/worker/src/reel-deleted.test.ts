import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ErrorTracker } from "./error-tracking.ts";
import type { ClaimedJob } from "./queue.ts";
import { recordingSteps, stepContext } from "./recording-steps.ts";
import { runJob } from "./run-job.ts";
import { runInProcessStep, runStep } from "./step-runner.ts";
import { TargetGone } from "./stored-files.ts";

// A job whose reel is deleted while it runs (app_docs/studio.md, "Jobs, steps
// and the lease"): the cascade removes its row, the next renewal matches
// nothing and finds the row gone, the running tool's process group is killed,
// and the job ends `deleted` with nothing more written and nothing captured.

const NODE = process.execPath;
const RENEW_MS = 100;
// The step runner's grace between SIGTERM and SIGKILL (step-runner.ts).
const KILL_AFTER_MS = 5000;

const JOB: ClaimedJob = {
  id: "j-del",
  reel_id: "r-del",
  photo_id: null,
  owner_id: "o1",
  kind: "process",
  attempts: 1,
  restore_version_id: null,
  version_id: null,
};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "reel-deleted-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function recordingTracker() {
  const errors = {
    enabled: true,
    stepFailed: vi.fn(),
    jobFailed: vi.fn(),
    crashed: vi.fn(),
    shutdown: vi.fn(async () => undefined),
  } satisfies ErrorTracker;
  return errors;
}

// The job's database as the worker sees it: held until `deleted` is set, then
// every renewal matches no row and the row is gone.
function jobRow() {
  const row = { deleted: false };
  return {
    row,
    renew: vi.fn(async () => !row.deleted),
    gone: vi.fn(async () => row.deleted),
    finish: vi.fn(async () => !row.deleted),
    fail: vi.fn(async () => !row.deleted),
    refuse: vi.fn(async () => !row.deleted),
    wait: vi.fn(async () => !row.deleted),
  };
}

function nothingRecorded(
  db: ReturnType<typeof jobRow>,
  errors: ReturnType<typeof recordingTracker>,
  lines: string[],
) {
  expect(db.finish).not.toHaveBeenCalled();
  expect(db.fail).not.toHaveBeenCalled();
  expect(db.refuse).not.toHaveBeenCalled();
  expect(db.wait).not.toHaveBeenCalled();
  for (const method of [errors.stepFailed, errors.jobFailed, errors.crashed]) {
    expect(method).not.toHaveBeenCalled();
  }
  expect(lines).toEqual([`job ${JOB.id}: reel deleted, stopped`]);
}

describe("a job whose reel is deleted", () => {
  it(
    "stops within one renewal, kills the running tool and records nothing",
    { timeout: 20_000 },
    async () => {
      const pidFile = join(dir, "pid");
      const db = jobRow();
      const errors = recordingTracker();
      const { steps, calls } = recordingSteps();
      const lines: string[] = [];
      let pid = 0;
      let deletedAt = 0;
      const outcome = runJob({
        job: JOB,
        renewEveryMs: RENEW_MS,
        ...db,
        errors,
        log: (line) => void lines.push(line),
        work: (signal, checkCancelled, checkGone) =>
          runStep(stepContext(steps, { signal, checkCancelled, checkGone, errors, job: JOB }), {
            name: "transcribe",
            file: NODE,
            args: [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30000);`,
            ],
            describe: "transcribed",
          }),
      });
      for (let i = 0; i < 200 && !pid; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file in the test's temp folder
        pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      }
      expect(pid).toBeGreaterThan(0);
      db.row.deleted = true;
      deletedAt = performance.now();

      expect(await outcome).toBe("deleted");
      expect(performance.now() - deletedAt).toBeLessThan(2 * RENEW_MS + KILL_AFTER_MS);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(calls.map((c) => c.call)).toEqual(["start"]);
      nothingRecorded(db, errors, lines);
    },
  );

  it("stops as deleted when a stored file is recorded after the reel went", async () => {
    const db = jobRow();
    const errors = recordingTracker();
    const { steps, calls } = recordingSteps();
    const lines: string[] = [];
    const records = {
      record: vi.fn(async (key: string) => {
        if (db.row.deleted) throw new TargetGone(key);
      }),
    };
    const outcome = await runJob({
      job: JOB,
      // Far off: the gone check on the failure decides, not a renewal.
      renewEveryMs: 60_000,
      ...db,
      errors,
      log: (line) => void lines.push(line),
      work: (signal, checkCancelled, checkGone) =>
        runInProcessStep(
          stepContext(steps, { signal, checkCancelled, checkGone, errors, job: JOB }),
          {
            name: "convert",
            work: async () => {
              db.row.deleted = true;
              await records.record("dev/cache/convert/a/converted.mp4");
              return { what: "converted", sizeBytes: null };
            },
          },
        ),
    });
    expect(outcome).toBe("deleted");
    expect(records.record).toHaveBeenCalledOnce();
    expect(calls.map((c) => c.call)).toEqual(["start"]);
    nothingRecorded(db, errors, lines);
  });
});
