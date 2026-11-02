import { NotifyToggle } from "@/components/NotifyToggle";
import { RetryButton } from "@/components/RetryButton";
import { jobRequestLabel } from "@/lib/change-requests";
import { formatWaitingForAi } from "@/lib/failures";
import type { JobRow, StepRow } from "@/lib/jobs";
import { formatTimeLeft, isProgressStep, timeLeftSeconds } from "@/lib/progress";
import { type ReelDetail, formatBytes, formatCreatedAt } from "@/lib/reels";
import type { VersionListRow } from "@/lib/versions";
import { formatOfflineSince } from "@/lib/worker-offline";

interface Props {
  reel: ReelDetail;
  jobs: readonly JobRow[];
  steps: readonly StepRow[];
  versionsById: ReadonlyMap<string, VersionListRow>;
  // The failed jobs that show Retry.
  retryable: ReadonlySet<string>;
  // Why no worker is claiming (free disk), shown under a queued job.
  waitingReason: string | null;
  // Since when the worker is offline, shown under a queued job.
  offline: Date | null;
  // Per long step, the owner's earlier done rows as ms per footage second.
  estimateRates: Record<string, number[]>;
}

// The running long step's percentage and time left, a pure function of its
// row: elapsed is measured to the progress write, so it changes with each
// Realtime update and needs no ticking timer.
function StepProgress({
  step,
  rates,
  footageSeconds,
}: {
  step: StepRow;
  rates: number[] | undefined;
  footageSeconds: ReelDetail["footage_seconds"];
}) {
  if (step.status !== "running" || !isProgressStep(step.name)) return null;
  if (step.progress_percent === null || step.progress_percent === undefined) return null;
  const elapsedMs = step.progress_updated_at
    ? Date.parse(step.progress_updated_at) - Date.parse(step.started_at)
    : 0;
  return (
    <span className="flex flex-wrap gap-3 text-ink">
      <span data-testid="step-progress">{step.progress_percent}%</span>
      <span data-testid="step-time-left" className="text-muted">
        {formatTimeLeft(timeLeftSeconds({ rates, footageSeconds, elapsedMs }))}
      </span>
    </span>
  );
}

// The reel's status, the ready notification toggle, its jobs (a queued one
// with the reason no worker is claiming, and since when the worker is
// offline; a failed one with its error and Retry) and its step log. All of it
// comes from LiveReel's live state; nothing here reads or subscribes.
export function StatusPanel({
  reel,
  jobs,
  steps,
  versionsById,
  retryable,
  waitingReason,
  offline,
  estimateRates,
}: Props) {
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">Status</dt>
        <dd data-testid="reel-status">{reel.status}</dd>
        <dt className="text-muted">Size</dt>
        <dd>{formatBytes(reel.source_bytes)}</dd>
        <dt className="text-muted">Created</dt>
        <dd>
          <time dateTime={reel.created_at}>{formatCreatedAt(reel.created_at)}</time>
        </dd>
      </dl>
      <NotifyToggle />
      <section aria-labelledby="jobs-heading" className="flex flex-col gap-2">
        <h2 id="jobs-heading" className="text-sm font-semibold">
          Jobs
        </h2>
        {jobs.length === 0 ? (
          <p className="text-sm text-muted">No job yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line bg-panel text-sm">
            {jobs.map((job) => {
              const label = jobRequestLabel(job, versionsById);
              return (
                <li
                  key={job.id}
                  data-testid="job-item"
                  data-job-kind={job.kind}
                  className="flex flex-col gap-1 px-3 py-2"
                >
                  <span className="flex flex-wrap gap-3">
                    <span className="font-medium">{job.kind}</span>
                    <span data-testid="job-status">{job.status}</span>
                    <span className="text-muted">attempts: {job.attempts}</span>
                    {job.retry_of_job_id && (
                      <span data-testid="job-retry-of" className="text-muted">
                        retry
                      </span>
                    )}
                  </span>
                  {job.status === "waiting_ai" && job.waiting_reason && job.not_before && (
                    <span data-testid="job-waiting-ai" className="text-warn">
                      {formatWaitingForAi(job.waiting_reason, job.not_before)}
                    </span>
                  )}
                  {job.status === "queued" && waitingReason && (
                    <span data-testid="job-waiting" className="text-warn">
                      {waitingReason}
                    </span>
                  )}
                  {job.status === "queued" && offline && (
                    <span data-testid="job-offline" className="text-warn">
                      {formatOfflineSince(offline)}
                    </span>
                  )}
                  {label && (
                    <span data-testid="job-request" className="break-words text-ink">
                      {label}
                    </span>
                  )}
                  {job.status === "failed" && job.error_tail && (
                    <pre className="overflow-x-auto text-xs whitespace-pre-wrap text-danger">
                      {job.error_tail}
                    </pre>
                  )}
                  {retryable.has(job.id) && <RetryButton reelId={reel.id} jobId={job.id} />}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="steps-heading" className="flex flex-col gap-2">
        <h2 id="steps-heading" className="text-sm font-semibold">
          Steps
        </h2>
        {steps.length === 0 ? (
          <p className="text-sm text-muted">No steps yet.</p>
        ) : (
          <ol className="flex flex-col gap-1 text-sm">
            {steps.map((step) => (
              <li key={step.id} className="flex flex-col gap-1">
                <span data-testid="step-line" className="break-words">
                  {step.name}: {step.summary ?? step.status}
                </span>
                <StepProgress
                  step={step}
                  rates={estimateRates[step.name]}
                  footageSeconds={reel.footage_seconds}
                />
                {(step.status === "failed" || step.status === "waiting") && step.error_tail && (
                  <details data-testid="step-error-tail" className="text-xs">
                    <summary className="cursor-pointer text-muted">Show error</summary>
                    <pre className="mt-1 overflow-x-auto break-words whitespace-pre-wrap text-danger">
                      {step.error_tail}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
