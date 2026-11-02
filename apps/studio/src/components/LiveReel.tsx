"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import {
  JOB_COLUMNS,
  type JobRow,
  STEP_COLUMNS,
  type StepRow,
  pickColumns,
  upsertById,
} from "@/lib/jobs";
import { ChangeRequestForm } from "@/components/ChangeRequestForm";
import { ExportPanel } from "@/components/ExportPanel";
import { NotifyToggle } from "@/components/NotifyToggle";
import { ReelPreview } from "@/components/ReelPreview";
import { RetryButton } from "@/components/RetryButton";
import { VersionList } from "@/components/VersionList";
import { useReadyNotice } from "@/components/useReadyNotice";
import { changeBlockedReason, jobRequestLabel } from "@/lib/change-requests";
import { changeQueueNote, formatWaitingForAi, retryableJobIds } from "@/lib/failures";
import { formatTimeLeft, isProgressStep, timeLeftSeconds } from "@/lib/progress";
import {
  REEL_DETAIL_COLUMNS,
  type ReelDetail,
  formatBytes,
  formatCreatedAt,
  reelName,
} from "@/lib/reels";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";
import { VERSION_LIST_COLUMNS, type VersionListRow } from "@/lib/versions";
import {
  WORKER_STATUS_COLUMNS,
  type WorkerStatusRow,
  upsertWorkerStatus,
  waitingReasonOf,
} from "@/lib/worker-status";
import { formatOfflineSince, offlineAt, offlineSince } from "@/lib/worker-offline";

interface Snapshot {
  reel: ReelDetail;
  jobs: JobRow[];
  steps: StepRow[];
  versions: VersionListRow[];
  // The newest export's id (the panel reads and signs it itself).
  latestExportId: string | null;
  // Every worker's row: why it is not claiming (free disk) and its heartbeat.
  workerStatus: WorkerStatusRow[];
}

interface LiveReelProps extends Snapshot {
  // Per long step, the owner's earlier done rows as ms per footage second,
  // newest first: read once per page open, the time-left estimate's history.
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
    <span className="flex flex-wrap gap-3 text-stone-700">
      <span data-testid="step-progress">{step.progress_percent}%</span>
      <span data-testid="step-time-left" className="text-stone-600">
        {formatTimeLeft(timeLeftSeconds({ rates, footageSeconds, elapsedMs }))}
      </span>
    </span>
  );
}

async function readSnapshot(supabase: SupabaseClient, id: string): Promise<Snapshot | null> {
  const [reel, jobs, steps, versions, latestExport, workerStatus] = await Promise.all([
    supabase.from("reels").select(REEL_DETAIL_COLUMNS).eq("id", id).maybeSingle<ReelDetail>(),
    supabase
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("reel_id", id)
      .order("created_at")
      .returns<JobRow[]>(),
    supabase
      .from("steps")
      .select(STEP_COLUMNS)
      .eq("reel_id", id)
      .order("started_at")
      .returns<StepRow[]>(),
    supabase
      .from("versions")
      .select(VERSION_LIST_COLUMNS)
      .eq("reel_id", id)
      .order("number")
      .returns<VersionListRow[]>(),
    supabase
      .from("exports")
      .select("id")
      .eq("reel_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string }>(),
    supabase.from("worker_status").select(WORKER_STATUS_COLUMNS).returns<WorkerStatusRow[]>(),
  ]);
  if (
    reel.error ||
    jobs.error ||
    steps.error ||
    versions.error ||
    latestExport.error ||
    workerStatus.error
  ) {
    return null;
  }
  if (!reel.data) return null;
  return {
    reel: reel.data,
    jobs: jobs.data ?? [],
    steps: steps.data ?? [],
    versions: versions.data ?? [],
    latestExportId: latestExport.data?.id ?? null,
    workerStatus: workerStatus.data ?? [],
  };
}

// The reel's preview, export, change box, versions, status, jobs (a queued
// one with the reason no worker is claiming, if any, and since when the
// worker is offline) and step log (a running long step with its percentage
// and time left). When the reel becomes ready with the tab hidden, the title
// and, if turned on, a notification say so. Read once on the server, then followed
// through Realtime filtered to this reel (RLS decides what arrives). One
// catch-up read each time the subscription becomes ready covers changes made
// between the server read and the subscription. No interval, no polling.
export function LiveReel({
  reel: initialReel,
  jobs: initialJobs,
  steps: initialSteps,
  versions: initialVersions,
  latestExportId: initialLatestExportId,
  workerStatus: initialWorkerStatus,
  estimateRates,
}: LiveReelProps) {
  const [reel, setReel] = useState(initialReel);
  const [jobs, setJobs] = useState(initialJobs);
  const [steps, setSteps] = useState(initialSteps);
  const [versions, setVersions] = useState(initialVersions);
  const [latestExportId, setLatestExportId] = useState(initialLatestExportId);
  const [workerStatus, setWorkerStatus] = useState(initialWorkerStatus);
  const [ready, setReady] = useState(false);
  // The clock the offline line reads: set after mount (never on the server,
  // whose time and time zone are not the owner's), then once more at the
  // moment the newest heartbeat turns eleven minutes old. One timeout, no
  // interval, no database read.
  const [now, setNow] = useState<number | null>(null);
  const id = initialReel.id;
  const offlineMoment = offlineAt(workerStatus)?.getTime() ?? null;

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const delay = offlineMoment === null ? null : offlineMoment - Date.now();
    const later = delay !== null && delay > 0 ? setTimeout(tick, delay) : undefined;
    return () => {
      clearTimeout(first);
      clearTimeout(later);
    };
  }, [offlineMoment]);

  useReadyNotice({ status: reel.status, latestExportId, reelName: reelName(reel) });

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    if (!supabase) return;
    let active = true;
    const channel = supabase.channel(`reel-${id}-${crypto.randomUUID()}`);

    channel
      .on("system", {}, (message: { extension?: string; status?: string }) => {
        // "Subscribed to PostgreSQL": the listeners below are attached now.
        if (message.extension !== "postgres_changes" || message.status !== "ok") return;
        void readSnapshot(supabase, id).then((snapshot) => {
          if (!active) return;
          if (snapshot) {
            setReel(snapshot.reel);
            setJobs(snapshot.jobs);
            setSteps(snapshot.steps);
            setVersions(snapshot.versions);
            setLatestExportId(snapshot.latestExportId);
            setWorkerStatus(snapshot.workerStatus);
          }
          setReady(true);
        });
      })
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "reels", filter: `id=eq.${id}` },
        (payload) => {
          setReel((current) => ({
            ...current,
            ...pickColumns<Partial<ReelDetail>>(payload.new, REEL_DETAIL_COLUMNS),
          }));
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "jobs", filter: `reel_id=eq.${id}` },
        (payload) => {
          if (payload.eventType === "DELETE") return;
          const row = pickColumns<JobRow>(payload.new, JOB_COLUMNS);
          setJobs((current) => upsertById(current, row, "created_at"));
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "steps", filter: `reel_id=eq.${id}` },
        (payload) => {
          if (payload.eventType === "DELETE") return;
          const row = pickColumns<StepRow>(payload.new, STEP_COLUMNS);
          setSteps((current) => upsertById(current, row, "started_at"));
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "versions", filter: `reel_id=eq.${id}` },
        (payload) => {
          // Versions are never updated, so inserts are all there is to follow.
          const row = pickColumns<VersionListRow>(payload.new, VERSION_LIST_COLUMNS);
          setVersions((current) => upsertById(current, row, "created_at"));
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "exports", filter: `reel_id=eq.${id}` },
        (payload) => {
          // Exports are never updated; a new one is the newest.
          const row = pickColumns<{ id: string }>(payload.new, "id");
          setLatestExportId(row.id);
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "worker_status" },
        (payload) => {
          if (payload.eventType === "DELETE") return;
          const row = pickColumns<WorkerStatusRow>(payload.new, WORKER_STATUS_COLUMNS);
          setWorkerStatus((current) => upsertWorkerStatus(current, row));
        },
      );

    // setAuth hands the session's token to Realtime before joining, so RLS
    // sees the owner.
    void supabase.realtime.setAuth().then(() => {
      if (active) channel.subscribe();
    });

    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [id]);

  const blockedReason = changeBlockedReason(reel);
  const queueNote = changeQueueNote(jobs);
  const retryable = new Set(retryableJobIds(reel, jobs));
  const versionsById = new Map(versions.map((version) => [version.id, version]));
  const waitingReason = waitingReasonOf(workerStatus);
  const offline = now === null ? null : offlineSince(workerStatus, new Date(now));

  return (
    <div data-realtime={ready ? "ready" : "pending"} className="flex flex-col gap-6">
      <ReelPreview reelId={reel.id} currentVersionId={reel.current_version_id} />
      {reel.status === "refused" && reel.refusal_message && (
        <p
          role="alert"
          data-testid="reel-refusal"
          className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {reel.refusal_message}
        </p>
      )}
      <ExportPanel reel={reel} jobs={jobs} latestExportId={latestExportId} />
      <ChangeRequestForm
        reelId={reel.id}
        blockedReason={blockedReason}
        queueNote={queueNote}
        jobs={jobs}
      />
      <VersionList
        reelId={reel.id}
        versions={versions}
        currentVersionId={reel.current_version_id}
        blockedReason={blockedReason}
      />

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-stone-600">Status</dt>
        <dd data-testid="reel-status">{reel.status}</dd>
        <dt className="text-stone-600">Size</dt>
        <dd>{formatBytes(reel.source_bytes)}</dd>
        <dt className="text-stone-600">Created</dt>
        <dd>
          <time dateTime={reel.created_at}>{formatCreatedAt(reel.created_at)}</time>
        </dd>
      </dl>
      <NotifyToggle />
      <section aria-labelledby="jobs-heading" className="flex flex-col gap-2">
        <h2 id="jobs-heading" className="text-lg font-semibold">
          Jobs
        </h2>
        {jobs.length === 0 ? (
          <p className="text-sm text-stone-600">No job yet.</p>
        ) : (
          <ul className="divide-y divide-stone-200 rounded-md border border-stone-200 bg-white text-sm">
            {jobs.map((job) => {
              const label = jobRequestLabel(job, versionsById);
              return (
                <li
                  key={job.id}
                  data-testid="job-item"
                  data-job-kind={job.kind}
                  className="flex flex-col gap-1 px-4 py-3"
                >
                  <span className="flex flex-wrap gap-3">
                    <span className="font-medium">{job.kind}</span>
                    <span data-testid="job-status">{job.status}</span>
                    <span className="text-stone-600">attempts: {job.attempts}</span>
                    {job.retry_of_job_id && (
                      <span data-testid="job-retry-of" className="text-stone-600">
                        retry
                      </span>
                    )}
                  </span>
                  {job.status === "waiting_ai" && job.waiting_reason && job.not_before && (
                    <span data-testid="job-waiting-ai" className="text-amber-800">
                      {formatWaitingForAi(job.waiting_reason, job.not_before)}
                    </span>
                  )}
                  {job.status === "queued" && waitingReason && (
                    <span data-testid="job-waiting" className="text-amber-800">
                      {waitingReason}
                    </span>
                  )}
                  {job.status === "queued" && offline && (
                    <span data-testid="job-offline" className="text-amber-800">
                      {formatOfflineSince(offline)}
                    </span>
                  )}
                  {label && (
                    <span data-testid="job-request" className="break-words text-stone-700">
                      {label}
                    </span>
                  )}
                  {job.status === "failed" && job.error_tail && (
                    <pre className="overflow-x-auto text-xs whitespace-pre-wrap text-red-700">
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
        <h2 id="steps-heading" className="text-lg font-semibold">
          Steps
        </h2>
        {steps.length === 0 ? (
          <p className="text-sm text-stone-600">No steps yet.</p>
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
                    <summary className="cursor-pointer text-stone-600">Show error</summary>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-red-700">
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
