import { formatWaitingForAi, retryableJobIds } from "./failures";
import type { JobKind, JobRow, StepRow } from "./jobs";
import { formatTimeLeft, isProgressStep, timeLeftSeconds } from "./progress";
import type { ReelDetail } from "./reels";
import { JOB_STEPS, refusalReason, stepWords } from "./step-words";
import { formatOfflineSince } from "./worker-offline";

// What the reel page's progress overlay shows (app_docs/status.md): a pure
// function of LiveReel's live state, no reads, no timers. One state at a time,
// in this order: a failure the owner has not handled, the "New version N"
// notice, the oldest live job's progress, else nothing.

export type FailureAction = "try_again" | "change_request" | "keep_current";

export type OverlayState =
  | {
      kind: "failure";
      jobId: string;
      jobKind: string;
      // The step the job failed in; null for a failure outside any step.
      step: string | null;
      failureKind: JobRow["failure_kind"];
      headline: string;
      // Plain words from a refused answer's rule names; never a raw tail.
      reason: string | null;
      actions: FailureAction[];
    }
  | { kind: "notice"; text: string }
  | {
      kind: "working";
      words: string;
      // 1-based position in the job's step list; 0 while queued.
      index: number;
      total: number;
      // 0 to 1, a running long step's percent included.
      fraction: number;
      // A running long step's percent and time left.
      percent: number | null;
      timeLeft: string | null;
      waitingAi: string | null;
      waitingDisk: string | null;
      offline: string | null;
    }
  | { kind: "hidden" };

export interface JobProgress {
  // The running step's name, else the job's last step's; null before any.
  step: string | null;
  index: number;
  total: number;
  fraction: number;
}

const DONE_STATUSES: readonly StepRow["status"][] = ["done", "skipped"];
const LIVE_STATUSES: readonly JobRow["status"][] = ["queued", "running", "waiting_ai"];

function stepListOf(kind: string): readonly string[] {
  return Object.hasOwn(JOB_STEPS, kind) ? JOB_STEPS[kind as JobKind] : [];
}

// A cut-out runs inside decide and counts as it.
function listName(name: string): string {
  return name === "cutout" ? "decide" : name;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// How far along a job is: step k of n and the fraction done.
export function jobProgress(
  job: Pick<JobRow, "id" | "kind" | "status">,
  steps: readonly StepRow[],
): JobProgress {
  const list = stepListOf(job.kind);
  const total = list.length;
  const own = steps.filter((step) => step.job_id === job.id);
  if (job.status === "queued" || own.length === 0) {
    return { step: null, index: 0, total, fraction: 0 };
  }
  const running = own.findLast((step) => step.status === "running");
  // A waiting step (decide on an AI limit) is the job's own step even when a
  // step inside it (backgrounds, cutout) finished after it started.
  const current = running ?? own.findLast((step) => step.status === "waiting") ?? own.at(-1)!;
  // A step not in the list keeps the last known index.
  let index = 0;
  for (const step of own) {
    const at = list.indexOf(listName(step.name));
    if (at >= 0) index = at + 1;
    if (step === current) break;
  }
  const finished = new Set(
    own
      .filter((step) => DONE_STATUSES.includes(step.status))
      .map((step) => listName(step.name))
      .filter((name) => list.includes(name)),
  );
  let done = finished.size;
  if (
    running &&
    isProgressStep(running.name) &&
    running.progress_percent !== null &&
    !finished.has(listName(running.name))
  ) {
    done += running.progress_percent / 100;
  }
  return {
    step: current.name,
    index,
    total,
    fraction: total === 0 ? 0 : clamp(done / total),
  };
}

export interface OverlayInput {
  reel: Pick<ReelDetail, "status" | "footage_seconds">;
  jobs: readonly JobRow[];
  steps: readonly StepRow[];
  // For a restore's version number.
  versionsById: ReadonlyMap<string, { number: number }>;
  // Why no worker is claiming (free disk).
  waitingReason: string | null;
  // Since when the worker is offline.
  offline: Date | null;
  // The new version's number while its notice shows, else null.
  notice: number | null;
  // Failed jobs the owner has handled on this page load.
  dismissed: ReadonlySet<string>;
  // Per long step, the owner's earlier done rows as ms per footage second.
  estimateRates: Record<string, number[]>;
}

function wordsFor(
  name: string,
  job: Pick<JobRow, "restore_version_id">,
  versionsById: OverlayInput["versionsById"],
) {
  const restoreNumber = job.restore_version_id
    ? (versionsById.get(job.restore_version_id)?.number ?? null)
    : null;
  return stepWords(name, { restoreNumber });
}

function failureState(input: OverlayInput): OverlayState | null {
  const { reel, jobs, steps, dismissed, versionsById } = input;
  const newest = jobs.at(-1);
  if (!newest || newest.status !== "failed" || dismissed.has(newest.id)) return null;
  // Not retried, and never on a refused reel (another clip is the way on).
  if (!retryableJobIds(reel, jobs).includes(newest.id)) return null;
  const own = steps.filter((step) => step.job_id === newest.id);
  const failedStep = own.findLast((step) => step.status === "failed") ?? own.at(-1) ?? null;
  const step = failedStep?.name ?? null;
  const refused = newest.failure_kind === "answer_refused";
  // A change that would leave the reel as it is: nothing was saved.
  const unchanged = refused && (newest.failure_rules ?? []).includes("no-change");
  const headline = unchanged
    ? "Nothing changed"
    : wordsFor(step ?? "", newest, versionsById).failed;
  const reword = newest.kind === "change" && refused && Boolean(newest.request);
  const actions: FailureAction[] = reword
    ? ["change_request", "keep_current"]
    : ["try_again", "keep_current"];
  return {
    kind: "failure",
    jobId: newest.id,
    jobKind: newest.kind,
    step,
    failureKind: newest.failure_kind,
    headline,
    reason: refused ? refusalReason(newest.failure_rules) : null,
    actions,
  };
}

function workingState(input: OverlayInput): OverlayState | null {
  const { reel, jobs, steps, versionsById, waitingReason, offline, estimateRates } = input;
  const job = jobs.find((candidate) => LIVE_STATUSES.includes(candidate.status));
  if (!job) return null;
  const progress = jobProgress(job, steps);
  const base = {
    kind: "working" as const,
    index: progress.index,
    total: progress.total,
    fraction: progress.fraction,
    percent: null,
    timeLeft: null,
    waitingAi: null,
    waitingDisk: null,
    offline: null,
  };
  if (job.status === "queued") {
    return {
      ...base,
      words: "Waiting to start",
      waitingDisk: waitingReason,
      offline: offline ? formatOfflineSince(offline) : null,
    };
  }
  const name = progress.step ?? stepListOf(job.kind)[0] ?? "";
  const words = wordsFor(name, job, versionsById).doing;
  if (job.status === "waiting_ai") {
    const waitingAi =
      job.waiting_reason && job.not_before
        ? formatWaitingForAi(job.waiting_reason, job.not_before)
        : null;
    return { ...base, words, waitingAi };
  }
  const running = steps.findLast((step) => step.job_id === job.id && step.status === "running");
  if (running && isProgressStep(running.name) && running.progress_percent !== null) {
    // Elapsed to the progress write: changes with each Realtime update, no
    // ticking timer.
    const elapsedMs = running.progress_updated_at
      ? Date.parse(running.progress_updated_at) - Date.parse(running.started_at)
      : 0;
    return {
      ...base,
      words,
      percent: running.progress_percent,
      timeLeft: formatTimeLeft(
        timeLeftSeconds({
          rates: estimateRates[running.name],
          footageSeconds: reel.footage_seconds,
          elapsedMs,
        }),
      ),
    };
  }
  return { ...base, words };
}

export function overlayState(input: OverlayInput): OverlayState {
  return (
    failureState(input) ??
    (input.notice !== null ? { kind: "notice", text: `New version ${input.notice}` } : null) ??
    workingState(input) ?? { kind: "hidden" }
  );
}
