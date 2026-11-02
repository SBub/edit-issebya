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
import { ReelPreview } from "@/components/ReelPreview";
import { VersionList } from "@/components/VersionList";
import { RetryJobButton } from "@/components/RetryJobButton";
import { changeRule, jobRequestLabel } from "@/lib/change-requests";
import { canRetry, isRetried, waitingForAiLine } from "@/lib/job-failures";
import { REEL_DETAIL_COLUMNS, type ReelDetail, formatBytes, formatCreatedAt } from "@/lib/reels";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";
import { VERSION_LIST_COLUMNS, type VersionListRow } from "@/lib/versions";
import {
  WORKER_STATUS_COLUMNS,
  type WorkerStatusRow,
  upsertWorkerStatus,
  waitingReasonOf,
} from "@/lib/worker-status";

interface Snapshot {
  reel: ReelDetail;
  jobs: JobRow[];
  steps: StepRow[];
  versions: VersionListRow[];
  // The newest export's id (the panel reads and signs it itself).
  latestExportId: string | null;
  // Workers' rows with a reason they are not claiming (free disk).
  workerStatus: WorkerStatusRow[];
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
    supabase
      .from("worker_status")
      .select(WORKER_STATUS_COLUMNS)
      .not("waiting_reason", "is", null)
      .returns<WorkerStatusRow[]>(),
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
// one with the reason no worker is claiming, if any) and step log. Read once on the server, then followed
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
}: Snapshot) {
  const [reel, setReel] = useState(initialReel);
  const [jobs, setJobs] = useState(initialJobs);
  const [steps, setSteps] = useState(initialSteps);
  const [versions, setVersions] = useState(initialVersions);
  const [latestExportId, setLatestExportId] = useState(initialLatestExportId);
  const [workerStatus, setWorkerStatus] = useState(initialWorkerStatus);
  const [ready, setReady] = useState(false);
  const id = initialReel.id;

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

  const rule = changeRule(reel, jobs);
  const versionsById = new Map(versions.map((version) => [version.id, version]));
  const waitingReason = waitingReasonOf(workerStatus);

  return (
    <div data-realtime={ready ? "ready" : "pending"} className="flex flex-col gap-6">
      <ReelPreview reelId={reel.id} currentVersionId={reel.current_version_id} />
      <ExportPanel reel={reel} jobs={jobs} latestExportId={latestExportId} />
      <ChangeRequestForm
        reelId={reel.id}
        blockedReason={rule.blocked}
        notice={rule.notice}
        jobs={jobs}
      />
      <VersionList
        reelId={reel.id}
        versions={versions}
        currentVersionId={reel.current_version_id}
        blockedReason={rule.blocked}
      />

      {reel.status === "refused" && reel.refusal_message && (
        <p
          data-testid="reel-refusal"
          role="status"
          className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {reel.refusal_message}
        </p>
      )}
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
                  </span>
                  {job.status === "queued" && waitingReason && (
                    <span data-testid="job-waiting" className="text-amber-800">
                      {waitingReason}
                    </span>
                  )}
                  {job.status === "waiting_ai" && job.not_before && (
                    <span data-testid="job-waiting-ai" className="text-amber-800">
                      {/* The clock part is the browser's zone; the server's render may differ. */}
                      <time dateTime={job.not_before} suppressHydrationWarning>
                        {waitingForAiLine(job)}
                      </time>
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
                  {canRetry(job, jobs, reel) && <RetryJobButton reelId={reel.id} jobId={job.id} />}
                  {isRetried(job, jobs) && (
                    <span data-testid="job-retried" className="text-stone-600">
                      retried
                    </span>
                  )}
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
                {step.status === "failed" && step.error_tail && (
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
