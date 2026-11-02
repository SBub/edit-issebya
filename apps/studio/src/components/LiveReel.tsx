"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import Link from "next/link";
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
import { ReelScreen } from "@/components/ReelScreen";
import { StatusPanel } from "@/components/StatusPanel";
import { VersionList } from "@/components/VersionList";
import { useReadyNotice } from "@/components/useReadyNotice";
import { changeBlockedReason } from "@/lib/change-requests";
import { changeQueueNote, retryableJobIds } from "@/lib/failures";
import { REEL_DETAIL_COLUMNS, type ReelDetail, reelName } from "@/lib/reels";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";
import {
  type VersionSelection,
  nextVersionId,
  previousVersionId,
  shownVersionId,
} from "@/lib/version-steps";
import { VERSION_LIST_COLUMNS, type VersionListRow } from "@/lib/versions";
import {
  WORKER_STATUS_COLUMNS,
  type WorkerStatusRow,
  upsertWorkerStatus,
  waitingReasonOf,
} from "@/lib/worker-status";
import { offlineAt, offlineSince } from "@/lib/worker-offline";

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

// The reel page on one screen (ReelScreen): the header with Export, the
// shown version's preview and tracks timeline with Undo and Redo, the change
// box, the versions, and the status panel (jobs, with the reason no worker is
// claiming and since when the worker is offline, and the step log with a
// running long step's percentage and time left). When the reel becomes ready with the tab hidden, the title
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
  // The owner's Undo or Redo pick, kept only while the current version is the
  // one it was made for (derived below, no effect).
  const [selection, setSelection] = useState<VersionSelection | null>(null);
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
  const currentId = reel.current_version_id;
  const shownId = shownVersionId(selection, currentId);
  const previousId = previousVersionId(versions, shownId);
  const nextId = nextVersionId(versions, shownId);

  // Undo and Redo change only what is shown: never a server action, never a
  // version or a job.
  const show = (versionId: string | null) => {
    if (versionId) setSelection({ id: versionId, forCurrent: currentId });
  };
  const stepButton =
    "flex size-8 items-center justify-center rounded-full border border-line text-base hover:bg-raised disabled:opacity-40";
  const controls = (
    <>
      <button
        type="button"
        aria-label="Undo"
        title="Undo: show the previous version"
        disabled={previousId === null}
        onClick={() => show(previousId)}
        className={stepButton}
      >
        <span aria-hidden="true">&#x21B6;</span>
      </button>
      <button
        type="button"
        aria-label="Redo"
        title="Redo: show the next version"
        disabled={nextId === null}
        onClick={() => show(nextId)}
        className={stepButton}
      >
        <span aria-hidden="true">&#x21B7;</span>
      </button>
    </>
  );

  return (
    <div data-realtime={ready ? "ready" : "pending"} className="h-dvh">
      <ReelScreen
        header={
          <>
            <Link
              href="/"
              aria-label="Back to your reels"
              className="flex flex-none items-center gap-1 rounded-full px-2 py-1 text-sm text-muted hover:bg-raised hover:text-ink"
            >
              <span aria-hidden="true">&larr;</span>
              <span className="hidden sm:inline">Your reels</span>
            </Link>
            <h1 className="min-w-0 flex-1 truncate text-base font-semibold" title={reelName(reel)}>
              {reelName(reel)}
            </h1>
            <ExportPanel reel={reel} jobs={jobs} latestExportId={latestExportId} />
          </>
        }
        main={
          <>
            {reel.status === "refused" && reel.refusal_message && (
              <p
                role="alert"
                data-testid="reel-refusal"
                className="flex-none rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
              >
                {reel.refusal_message}
              </p>
            )}
            <ReelPreview reelId={reel.id} versionId={shownId} controls={controls} />
          </>
        }
        footer={
          <ChangeRequestForm
            reelId={reel.id}
            blockedReason={blockedReason}
            queueNote={queueNote}
            jobs={jobs}
          />
        }
        versions={
          <VersionList
            reelId={reel.id}
            versions={versions}
            currentVersionId={currentId}
            selectedVersionId={shownId}
            blockedReason={blockedReason}
          />
        }
        status={
          <StatusPanel
            reel={reel}
            jobs={jobs}
            steps={steps}
            versionsById={versionsById}
            retryable={retryable}
            waitingReason={waitingReason}
            offline={offline}
            estimateRates={estimateRates}
          />
        }
      />
    </div>
  );
}
