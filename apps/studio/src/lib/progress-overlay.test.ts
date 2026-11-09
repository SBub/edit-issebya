import { describe, expect, it } from "vitest";
import type { JobRow, StepRow } from "./jobs";
import { type OverlayInput, jobProgress, overlayState } from "./progress-overlay";

let ids = 0;

function job(extra: Partial<JobRow> = {}): JobRow {
  ids += 1;
  return {
    id: `j${ids}`,
    reel_id: "r1",
    kind: "process",
    request: null,
    restore_version_id: null,
    version_id: null,
    retry_of_job_id: null,
    status: "running",
    waiting_reason: null,
    not_before: null,
    attempts: 1,
    error_tail: null,
    failure_kind: null,
    failure_rules: null,
    created_at: `2026-11-03T10:00:${String(ids).padStart(2, "0")}Z`,
    started_at: null,
    finished_at: null,
    ...extra,
  };
}

function step(
  jobId: string,
  name: string,
  status: StepRow["status"],
  extra: Partial<StepRow> = {},
) {
  ids += 1;
  return {
    id: `s${ids}`,
    job_id: jobId,
    reel_id: "r1",
    name,
    status,
    summary: null,
    error_tail: null,
    started_at: `2026-11-03T10:01:${String(ids).padStart(2, "0")}Z`,
    finished_at: null,
    progress_percent: null,
    progress_updated_at: null,
    ...extra,
  } satisfies StepRow;
}

const done = (jobId: string, names: string[]) => names.map((name) => step(jobId, name, "done"));

function input(extra: Partial<OverlayInput>): OverlayInput {
  return {
    reel: { status: "processed", footage_seconds: null },
    jobs: [],
    steps: [],
    versionsById: new Map(),
    waitingReason: null,
    offline: null,
    notice: null,
    dismissed: new Set(),
    estimateRates: {},
    ...extra,
  };
}

describe("jobProgress", () => {
  it("is step 2 of 8 at convert", () => {
    const j = job();
    const steps = [step(j.id, "check_footage", "done"), step(j.id, "convert", "running")];
    expect(jobProgress(j, steps)).toEqual({ step: "convert", index: 2, total: 8, fraction: 1 / 8 });
  });

  it("counts half of head_track at 50 percent", () => {
    const j = job();
    const steps = [
      ...done(j.id, ["check_footage", "convert", "transcribe", "retime"]),
      step(j.id, "head_track", "running", { progress_percent: 50 }),
    ];
    expect(jobProgress(j, steps)).toMatchObject({ index: 5, fraction: 4.5 / 8 });
  });

  it("shows a cutout as decide's step", () => {
    const j = job({ kind: "change" });
    const steps = [step(j.id, "decide", "running"), step(j.id, "cutout", "running")];
    expect(jobProgress(j, steps)).toMatchObject({ step: "cutout", index: 1, total: 1 });
  });

  it("keeps the last known index for a step not in the list", () => {
    const j = job();
    const steps = [step(j.id, "check_footage", "done"), step(j.id, "mystery", "running")];
    expect(jobProgress(j, steps)).toMatchObject({ step: "mystery", index: 1 });
  });

  it("is 0 while queued and 1 when every step is done", () => {
    expect(jobProgress(job({ status: "queued" }), [])).toMatchObject({ index: 0, fraction: 0 });
    const j = job({ status: "done" });
    const all = done(j.id, [
      "check_footage",
      "convert",
      "transcribe",
      "retime",
      "head_track",
      "preview_copies",
      "first_version",
      "decide",
    ]);
    expect(jobProgress(j, all)).toMatchObject({ index: 8, fraction: 1 });
  });

  it("ignores another job's steps", () => {
    const j = job();
    const other = job();
    expect(jobProgress(j, [step(other.id, "convert", "done")])).toMatchObject({ index: 0 });
  });
});

describe("overlayState", () => {
  it("shows the oldest live job's words, step k of n and the bar", () => {
    const j = job({ kind: "change", request: "brighter" });
    const later = job({ status: "queued" });
    const state = overlayState(
      input({ jobs: [j, later], steps: [step(j.id, "decide", "running")] }),
    );
    expect(state).toMatchObject({
      kind: "working",
      words: "Styling your reel",
      index: 1,
      total: 1,
      fraction: 0,
    });
  });

  it("adds a long step's percent and time left", () => {
    const j = job({ kind: "render" });
    const state = overlayState(
      input({
        jobs: [j],
        steps: [step(j.id, "render", "running", { progress_percent: 40 })],
      }),
    );
    expect(state).toMatchObject({
      kind: "working",
      words: "Exporting",
      percent: 40,
      timeLeft: "no estimate yet",
      fraction: 0.4,
    });
  });

  it("reads a queued job as Waiting to start with the disk and offline lines", () => {
    const state = overlayState(
      input({
        jobs: [job({ status: "queued" })],
        waitingReason: "Not enough free disk",
        offline: new Date(2026, 10, 3, 9, 5),
      }),
    );
    expect(state).toMatchObject({
      kind: "working",
      words: "Waiting to start",
      index: 0,
      waitingDisk: "Not enough free disk",
      offline: expect.stringContaining("09:05"),
    });
  });

  it("shows a waiting job's AI line and no actions", () => {
    const j = job({
      kind: "change",
      status: "waiting_ai",
      waiting_reason: "the usage limit is reached",
      not_before: new Date(2026, 10, 3, 7, 5).toISOString(),
    });
    const state = overlayState(input({ jobs: [j], steps: [step(j.id, "decide", "waiting")] }));
    expect(state).toMatchObject({
      kind: "working",
      words: "Styling your reel",
      waitingAi: "Waiting for the AI: the usage limit is reached. Next try at 07:05",
    });
  });

  it("shows the waiting step's words over a step that finished inside it", () => {
    const j = job({
      kind: "change",
      status: "waiting_ai",
      waiting_reason: "the usage limit is reached",
      not_before: new Date(2026, 10, 3, 7, 5).toISOString(),
    });
    const steps = [step(j.id, "decide", "waiting"), step(j.id, "cutout", "done")];
    expect(overlayState(input({ jobs: [j], steps }))).toMatchObject({
      kind: "working",
      words: "Styling your reel",
    });
  });

  it("offers Try again and Keep for a refused answer, with the plain reason", () => {
    const j = job({
      kind: "start_over",
      status: "failed",
      failure_kind: "answer_refused",
      failure_rules: ["same-text", "safe-box"],
    });
    const state = overlayState(input({ jobs: [j], steps: [step(j.id, "decide", "failed")] }));
    expect(state).toEqual({
      kind: "failure",
      jobId: j.id,
      jobKind: "start_over",
      step: "decide",
      failureKind: "answer_refused",
      headline: "Could not finish styling",
      reason:
        "The same word would show twice on screen and something would sit outside the safe area",
      actions: ["try_again", "keep_current"],
    });
  });

  it("gives the failed step's headline and the refusal's reason for a refused answer", () => {
    const j = job({
      kind: "start_over",
      status: "failed",
      failure_kind: "answer_refused",
      failure_rules: ["answer-schema", "glossary"],
    });
    const state = overlayState(input({ jobs: [j], steps: [step(j.id, "decide", "failed")] }));
    expect(state).toMatchObject({
      kind: "failure",
      headline: "Could not finish styling",
      reason:
        "The AI's answer could not be used and a word would be spelled differently from your glossary",
      actions: ["try_again", "keep_current"],
    });
  });

  it("offers Try again for a transient failure, an old row and a refused process decide", () => {
    for (const extra of [
      { failure_kind: "transient" as const },
      { failure_kind: null },
      { failure_kind: "answer_refused" as const, failure_rules: ["safe-box"] },
    ]) {
      const j = job({ status: "failed", ...extra });
      const state = overlayState(input({ jobs: [j], steps: [step(j.id, "transcribe", "failed")] }));
      expect(state).toMatchObject({ kind: "failure", actions: ["try_again", "keep_current"] });
    }
  });

  it("names the failed step in plain words and never a raw tail", () => {
    const j = job({ status: "failed", error_tail: "ffmpeg exited with 1", failure_kind: "failed" });
    const state = overlayState(input({ jobs: [j], steps: [step(j.id, "transcribe", "failed")] }));
    expect(state).toMatchObject({
      headline: "Could not finish listening to your words",
      reason: null,
    });
  });

  it("shows no failure on a refused reel", () => {
    const j = job({ status: "failed" });
    const state = overlayState(
      input({ reel: { status: "refused", footage_seconds: null }, jobs: [j] }),
    );
    expect(state).toEqual({ kind: "hidden" });
  });

  it("hides a dismissed or retried failure, and one a newer job follows", () => {
    const failed = job({ status: "failed" });
    expect(overlayState(input({ jobs: [failed], dismissed: new Set([failed.id]) }))).toEqual({
      kind: "hidden",
    });
    const retry = job({ status: "done", retry_of_job_id: failed.id });
    expect(overlayState(input({ jobs: [failed, retry] }))).toEqual({ kind: "hidden" });
    const newer = job({ status: "done", kind: "change" });
    expect(overlayState(input({ jobs: [failed, newer] }))).toEqual({ kind: "hidden" });
  });

  it("puts a failure before the notice, and the notice before progress", () => {
    const failed = job({ status: "failed" });
    expect(overlayState(input({ jobs: [failed], notice: 3 }))).toMatchObject({ kind: "failure" });
    const running = job();
    expect(overlayState(input({ jobs: [running], notice: 3 }))).toEqual({
      kind: "notice",
      text: "New version 3",
    });
    expect(overlayState(input({ jobs: [running] }))).toMatchObject({ kind: "working" });
    expect(overlayState(input({}))).toEqual({ kind: "hidden" });
  });

  it("names the restore's version", () => {
    const j = job({ kind: "restore", restore_version_id: "v2" });
    const state = overlayState(
      input({
        jobs: [j],
        steps: [step(j.id, "restore", "running")],
        versionsById: new Map([["v2", { number: 2 }]]),
      }),
    );
    expect(state).toMatchObject({ words: "Going back to version 2" });
  });
});
