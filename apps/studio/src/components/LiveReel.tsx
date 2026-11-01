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
import { changeBlockedReason } from "@/lib/change-request";
import { REEL_DETAIL_COLUMNS, type ReelDetail, formatBytes, formatCreatedAt } from "@/lib/reels";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";
import { type VersionListRow, readVersions } from "@/lib/versions";
import { ChangeRequestForm } from "./ChangeRequestForm";
import { Preview } from "./Preview";
import { VersionList } from "./VersionList";

interface Snapshot {
  reel: ReelDetail;
  jobs: JobRow[];
  steps: StepRow[];
  // Newest first; the newest is the current version.
  versions: VersionListRow[];
}

// Version numbers only grow (a restore is a new version too), so a late
// answer never replaces the list with an older one.
function newerList(shown: VersionListRow[], read: VersionListRow[]): VersionListRow[] {
  return (read[0]?.number ?? 0) >= (shown[0]?.number ?? 0) ? read : shown;
}

async function readSnapshot(supabase: SupabaseClient, id: string): Promise<Snapshot | null> {
  const [reel, jobs, steps] = await Promise.all([
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
  ]);
  if (reel.error || jobs.error || steps.error || !reel.data) return null;
  const versions = await readVersions(supabase, id).catch(() => null);
  if (!versions) return null;
  return { reel: reel.data, jobs: jobs.data ?? [], steps: steps.data ?? [], versions };
}

// The reel's status, jobs and step log. Read once on the server, then followed
// through Realtime filtered to this reel (RLS decides what arrives). One
// catch-up read each time the subscription becomes ready covers changes made
// between the server read and the subscription. No interval, no polling. The
// versions are re-read once each time a reel update names a new current
// version, which reaches the preview the same way and rebuilds it.
export function LiveReel({
  reel: initialReel,
  jobs: initialJobs,
  steps: initialSteps,
  versions: initialVersions,
}: Snapshot) {
  const [reel, setReel] = useState(initialReel);
  const [jobs, setJobs] = useState(initialJobs);
  const [steps, setSteps] = useState(initialSteps);
  const [versions, setVersions] = useState(initialVersions);
  const [ready, setReady] = useState(false);
  const id = initialReel.id;

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    if (!supabase) return;
    let active = true;
    const showVersions = (read: VersionListRow[]) => {
      if (active) setVersions((shown) => newerList(shown, read));
    };
    let followedVersionId: string | null = null;
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
            showVersions(snapshot.versions);
          }
          setReady(true);
        });
      })
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "reels", filter: `id=eq.${id}` },
        (payload) => {
          const changed = pickColumns<Partial<ReelDetail>>(payload.new, REEL_DETAIL_COLUMNS);
          setReel((current) => ({ ...current, ...changed }));
          const versionId = changed.current_version_id;
          if (versionId && versionId !== followedVersionId) {
            followedVersionId = versionId;
            // A failed read keeps the list shown; the next update or reload reads again.
            void readVersions(supabase, id).then(showVersions, () => {});
          }
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

  const versionNumber = versions[0]?.number ?? null;
  const blockedReason = changeBlockedReason(reel.status, jobs);
  const numberOf = (versionId: string | null) =>
    versions.find((version) => version.id === versionId)?.number;

  return (
    <div data-realtime={ready ? "ready" : "pending"} className="flex flex-col gap-6">
      {reel.current_version_id ? (
        <>
          <Preview reelId={reel.id} versionId={reel.current_version_id} />
          <ChangeRequestForm
            reelId={reel.id}
            blockedReason={blockedReason}
            jobCount={jobs.length}
          />
        </>
      ) : (
        <p className="text-sm text-stone-600">The preview appears once processing has finished.</p>
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
        {versionNumber !== null && (
          <>
            <dt className="text-stone-600">Edit</dt>
            <dd data-testid="current-version">version {versionNumber}</dd>
          </>
        )}
      </dl>

      <VersionList reelId={reel.id} versions={versions} blockedReason={blockedReason} />

      <section aria-labelledby="jobs-heading" className="flex flex-col gap-2">
        <h2 id="jobs-heading" className="text-lg font-semibold">
          Jobs
        </h2>
        {jobs.length === 0 ? (
          <p className="text-sm text-stone-600">No job yet.</p>
        ) : (
          <ul className="divide-y divide-stone-200 rounded-md border border-stone-200 bg-white text-sm">
            {jobs.map((job) => (
              <li key={job.id} className="flex flex-col gap-1 px-4 py-3">
                <span className="flex flex-wrap gap-3">
                  <span className="font-medium">{job.kind}</span>
                  <span data-testid="job-status">{job.status}</span>
                  <span className="text-stone-600">attempts: {job.attempts}</span>
                </span>
                {job.kind === "change" && job.request && (
                  <span data-testid="job-request" className="break-words text-stone-700">
                    &ldquo;{job.request}&rdquo;
                  </span>
                )}
                {job.kind === "restore" && (
                  <span data-testid="job-request" className="text-stone-700">
                    go back to version {numberOf(job.restore_version_id) ?? "?"}
                  </span>
                )}
                {job.status === "failed" && job.error_tail && (
                  <pre className="overflow-x-auto text-xs whitespace-pre-wrap text-red-700">
                    {job.error_tail}
                  </pre>
                )}
              </li>
            ))}
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
